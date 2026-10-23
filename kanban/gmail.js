// Leitura da caixa do Launch pela API do Gmail (somente leitura, OAuth 2.0 — nunca senha).
//
// Variáveis de ambiente (só no Railway):
//   GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET  → cliente OAuth do projeto no Google Cloud
//   GMAIL_REFRESH_TOKEN                   → gerado uma vez com tools/gmail-autorizar.js
//                                           (escopo gmail.readonly, conta launchcavallaria@gmail.com)
// Sem biblioteca do Google (pesada): três chamadas HTTPS com o fetch do Node.
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
// E-mails do scanner dos últimos 30 dias. O scanner (diagnostic_report@cnlaunch.com) NÃO anexa o PDF:
// manda um link para o relatório no servidor da Launch (…dbscar.com/ait_report/….pdf) e põe o nome
// do arquivo no assunto. E-mail com "launch" no assunto e PDF anexo (encaminhado à mão) também vale.
const BUSCA_PADRAO = '(from:cnlaunch.com OR from:dbscar.com OR (subject:launch has:attachment filename:pdf)) newer_than:30d';
// Só baixa relatório de servidores da Launch, por HTTPS.
const HOSTS_LAUNCH = /(^|\.)(dbscar\.com|cnlaunch\.com|x431\.com)$/i;
const MAX_LINK_BYTES = 31 * 1024 * 1024;

// permanente = não adianta tentar de novo (link vencido, fora da Launch, grande demais): marca só aquele e-mail
class ErroGmail extends Error {
  constructor(msg, { permanente = false } = {}) { super(msg); this.permanente = permanente; }
}

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

// Links de PDF de servidores da Launch no corpo do e-mail (texto e HTML).
function linksPdf(parte) {
  const textos = [];
  const juntar = (p) => {
    if (!p) return;
    if (p.body && p.body.data && /^text\//i.test(p.mimeType || '')) textos.push(b64url(p.body.data).toString('utf8'));
    for (const f of p.parts || []) juntar(f);
  };
  juntar(parte);
  const vistos = new Set();
  for (const t of textos) {
    for (const bruto of t.match(/https:\/\/[^\s"'<>()]+/g) || []) {
      const limpo = bruto.replace(/&amp;/g, '&').replace(/[.,;]+$/, '');
      let u;
      try { u = new URL(limpo); } catch (_) { continue; }
      if (u.protocol === 'https:' && HOSTS_LAUNCH.test(u.hostname) && /\.pdf$/i.test(u.pathname)) vistos.add(u.toString());
    }
  }
  return [...vistos];
}

class ClienteGmail {
  constructor({ env = process.env, fetchImpl = globalThis.fetch, busca = env.LAUNCH_GMAIL_BUSCA || BUSCA_PADRAO, porRodada = 40, esperaBaseMs = 2000 } = {}) {
    if (!configurado(env)) throw new ErroGmail('Gmail não configurado (GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET, GMAIL_REFRESH_TOKEN)');
    this.env = env;
    this.fetch = fetchImpl;
    this.busca = busca;
    this.token = null;
    this.expira = 0;
    this.porRodada = porRodada;
    this.esperaBaseMs = esperaBaseMs;
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

  async get(caminho, tentativa = 0, limite = 0) {
    const r = await this.fetch(API + caminho, { headers: { Authorization: `Bearer ${await this.acessoToken(tentativa > 0)}` } });
    if (r.status === 401 && tentativa === 0) return this.get(caminho, 1, limite); // token venceu: renova uma vez
    if (!r.ok) {
      const j = await (r.json ? r.json().catch(() => ({})) : {});
      const motivos = ((j.error && j.error.errors) || []).map((e) => e.reason).join(',');
      // limite de velocidade do Gmail (403 rateLimitExceeded/userRateLimitExceeded ou 429): espera e tenta de novo
      if ((r.status === 429 || (r.status === 403 && /rate|limit|quota/i.test(motivos))) && limite < 4) {
        await new Promise((ok) => setTimeout(ok, this.esperaBaseMs * 2 ** limite));
        return this.get(caminho, tentativa, limite + 1);
      }
      throw new ErroGmail(`Gmail respondeu ${r.status}${motivos ? ` (${motivos})` : ''} em ${caminho.split('?')[0]}`);
    }
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
      anexos: [
        ...anexosPdf(msg.payload).map((a) => ({
          nome: a.nome,
          carregar: async () => (a.dados ? b64url(a.dados)
            : b64url((await this.get(`/messages/${encodeURIComponent(msg.id)}/attachments/${encodeURIComponent(a.attachmentId)}`)).data)),
        })),
        ...this.anexosPorLink(msg),
      ],
    };
  }

  // Relatório por link (o jeito do scanner). Nome: o do assunto quando ele é o nome do PDF.
  anexosPorLink(msg) {
    const links = linksPdf(msg.payload);
    const assunto = cabecalho(msg, 'Subject').trim();
    return links.map((link) => ({
      nome: links.length === 1 && /^[\w.() -]+\.pdf$/i.test(assunto) ? assunto : decodeURIComponent(new URL(link).pathname.split('/').pop()),
      carregar: () => this.baixarLink(link),
    }));
  }

  async baixarLink(link) {
    const r = await this.fetch(link, { redirect: 'follow' });
    const final = new URL(r.url || link);
    if (final.protocol !== 'https:' || !HOSTS_LAUNCH.test(final.hostname)) throw new ErroGmail('link do relatório saiu do servidor da Launch', { permanente: true });
    if (!r.ok) throw new ErroGmail(`servidor da Launch respondeu ${r.status} ao baixar o relatório`, { permanente: r.status >= 400 && r.status < 500 && r.status !== 429 });
    if (Number(r.headers && r.headers.get && r.headers.get('content-length')) > MAX_LINK_BYTES) throw new ErroGmail('relatório grande demais', { permanente: true });
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > MAX_LINK_BYTES) throw new ErroGmail('relatório grande demais', { permanente: true });
    return bytes;
  }

  // Mensagens ainda não processadas (o controle por message_id fica no banco).
  // No máximo `porRodada` por vez (mais antigas primeiro): a caixa recebe ~300 relatórios por mês e
  // abrir todos de uma vez estoura o limite do Gmail. O resto entra nas próximas rodadas (a cada 5 min).
  async buscarNovas(jaProcessada, { porRodada = this.porRodada } = {}) {
    const ids = (await this.listarIds()).filter((id) => !jaProcessada(id)).reverse().slice(0, porRodada);
    const out = [];
    for (const id of ids) out.push(await this.mensagem(id));
    return out;
  }
}

module.exports = { ClienteGmail, ErroGmail, configurado, anexosPdf, linksPdf, BUSCA_PADRAO };
