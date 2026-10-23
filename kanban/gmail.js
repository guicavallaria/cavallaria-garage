// Leitura da caixa do Launch pela API do Gmail (somente leitura, OAuth 2.0 — nunca senha).
//
// Variáveis de ambiente (só no Railway):
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET  → cliente OAuth do projeto no Google Cloud
//   GMAIL_REFRESH_TOKEN                   → gerado uma vez com tools/gmail-autorizar.js
//                                           (escopo gmail.readonly, conta launchcavallaria@gmail.com)
// Sem biblioteca do Google (pesada): três chamadas HTTPS com o fetch do Node.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
// E-mails do scanner: remetente ou assunto "LAUNCH", com PDF anexo, dos últimos 30 dias.
const BUSCA_PADRAO = 'has:attachment filename:pdf (from:launch OR subject:launch) newer_than:30d';

class ErroGmail extends Error {}

function configurado(env = process.env) {
  return Boolean(env.GMAIL_CLIENT_ID && env.GMAIL_CLIENT_SECRET && env.GMAIL_REFRESH_TOKEN);
}

const b64url = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64');

function cabecalho(msg, nome) {
  const h = ((msg.payload && msg.payload.headers) || []).find((x) => x.name.toLowerCase() === nome.toLowerCase());
  return h ? h.value : '';
}

// Anexos PDF em qualquer nível do e-mail (multipart dentro de multipart).
function anexosPdf(parte, out = []) {
  if (!parte) return out;
  if (parte.filename && /\.pdf$/i.test(parte.filename) && parte.body && (parte.body.attachmentId || parte.body.data)) {
    out.push({ nome: parte.filename, attachmentId: parte.body.attachmentId || null, dados: parte.body.data || null, tamanho: parte.body.size || 0 });
  }
  for (const p of parte.parts || []) anexosPdf(p, out);
  return out;
}

class ClienteGmail {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, busca = env.LAUNCH_GMAIL_BUSCA || BUSCA_PADRAO } = {}) {
    if (!configurado(env)) throw new ErroGmail('Gmail não configurado (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)');
    this.env = env;
    this.fetch = fetchImpl;
    this.busca = busca;
    this.token = null;
    this.expira = 0;
  }

  async acessoToken(forcar = false) {
    if (!forcar && this.token && Date.now() < this.expira - 60_000) return this.token;
    const r = await this.fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: this.env.GMAIL_CLIENT_ID, client_secret: this.env.GMAIL_CLIENT_SECRET,
        refresh_token: this.env.GMAIL_REFRESH_TOKEN, grant_type: 'refresh_token',
      }).toString(),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      if (j.error === 'invalid_grant') throw new ErroGmail('A autorização do Gmail expirou ou foi revogada: refaça o passo de autorização (tools/gmail-autorizar.js)');
      throw new ErroGmail(`Gmail recusou o login (${r.status} ${j.error || ''})`.trim());
    }
    this.token = j.access_token;
    this.expira = Date.now() + (Number(j.expires_in) || 3600) * 1000;
    return this.token;
  }

  async get(caminho, tentativa = 0) {
    const r = await this.fetch(API + caminho, { headers: { Authorization: `Bearer ${await this.acessoToken(tentativa > 0)}` } });
    if (r.status === 401 && tentativa === 0) return this.get(caminho, 1); // token venceu: renova uma vez
    if (!r.ok) throw new ErroGmail(`Gmail respondeu ${r.status} em ${caminho.split('?')[0]}`);
    return r.json();
  }

  // Ids das mensagens que batem com a busca (até 3 páginas).
  async listarIds() {
    const ids = [];
    let pagina = null;
    for (let i = 0; i < 3; i++) {
      const q = new URLSearchParams({ q: this.busca, maxResults: '100', ...(pagina ? { pageToken: pagina } : {}) });
      const j = await this.get(`/messages?${q}`);
      for (const m of j.messages || []) ids.push(m.id);
      if (!j.nextPageToken) break;
      pagina = j.nextPageToken;
    }
    return ids;
  }

  async mensagem(id) {
    const msg = await this.get(`/messages/${encodeURIComponent(id)}?format=full`);
    return {
      messageId: msg.id,
      recebidoEm: new Date(Number(msg.internalDate) || Date.parse(cabecalho(msg, 'Date')) || Date.now()).toISOString(),
      assunto: cabecalho(msg, 'Subject'),
      remetente: cabecalho(msg, 'From'),
      anexos: anexosPdf(msg.payload).map((a) => ({
        nome: a.nome,
        carregar: async () => (a.dados ? b64url(a.dados)
          : b64url((await this.get(`/messages/${encodeURIComponent(msg.id)}/attachments/${encodeURIComponent(a.attachmentId)}`)).data)),
      })),
    };
  }

  // Mensagens ainda não processadas (o controle por message_id fica no banco).
  async buscarNovas(jaProcessada) {
    const ids = (await this.listarIds()).filter((id) => !jaProcessada(id));
    const out = [];
    for (const id of ids.reverse()) out.push(await this.mensagem(id)); // mais antigas primeiro
    return out;
  }
}

module.exports = { ClienteGmail, ErroGmail, configurado, anexosPdf, BUSCA_PADRAO };
