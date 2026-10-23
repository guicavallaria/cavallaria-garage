// Links públicos com validade para mídias (abrem sem login):
//  - vídeo/áudio citado no PDF de revisão (QR code impresso);
//  - PDF enviado ao cliente pelo WhatsApp.
// Validade padrão de 7 dias (seção 12 do prompt) e revogáveis. URL assinada do S3 não pode
// ser revogada, então o link aponta para o app (/m/<token>), que confere validade e revogação
// e só então redireciona para uma URL assinada de 15 minutos.
const crypto = require('crypto');
const { ErroAcao, validarOperador } = require('./acoes');

const DIAS_PADRAO = 7;

function baseUrl(env = process.env) {
  return (env.APP_PUBLIC_URL || `http://localhost:${env.PORT || 3000}`).replace(/\/$/, '');
}

function criarLink(db, midiaId, { finalidade, operador, dias = DIAS_PADRAO, agora = new Date() }) {
  // "Sistema" é reservado para o operador humano, mas o PDF gerado sozinho cria links em nome dele.
  const op = operador === 'Sistema' ? 'Sistema' : validarOperador(operador);
  if (!['video_pdf', 'pdf_cliente'].includes(finalidade)) throw new ErroAcao(400, 'Finalidade de link inválida');
  const m = db.prepare("SELECT id FROM kb_midias WHERE id = ? AND status = 'enviado' AND removido_em IS NULL").get(Number(midiaId));
  if (!m) throw new ErroAcao(404, 'Arquivo não encontrado');
  const token = crypto.randomBytes(24).toString('base64url');
  const expira = new Date(agora.getTime() + dias * 86_400_000).toISOString();
  db.prepare(`INSERT INTO kb_links (token, midia_id, finalidade, expira_em, criado_por, criado_em) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(token, m.id, finalidade, expira, op, agora.toISOString());
  return { token, url: `${baseUrl()}/m/${token}`, expira_em: expira };
}

// Devolve a mídia do link, ou o motivo de não abrir.
function resolverLink(db, token, { agora = new Date() } = {}) {
  if (!/^[A-Za-z0-9_-]{20,64}$/.test(String(token || ''))) return { erro: 'Link inválido' };
  const l = db.prepare('SELECT * FROM kb_links WHERE token = ?').get(token);
  if (!l) return { erro: 'Link inválido' };
  if (l.revogado_em) return { erro: 'Este link foi cancelado pela oficina' };
  if (Date.parse(l.expira_em) < agora.getTime()) return { erro: 'Este link expirou. Peça um novo à Cavallaria Garage.' };
  const m = db.prepare("SELECT * FROM kb_midias WHERE id = ? AND status = 'enviado' AND removido_em IS NULL").get(l.midia_id);
  if (!m) return { erro: 'Arquivo não disponível' };
  db.prepare('UPDATE kb_links SET acessos = acessos + 1 WHERE id = ?').run(l.id);
  return { link: l, midia: m };
}

function revogarLink(db, linkId, { operador, agora = new Date() }) {
  const op = validarOperador(operador);
  const l = db.prepare('SELECT * FROM kb_links WHERE id = ?').get(Number(linkId));
  if (!l) throw new ErroAcao(404, 'Link não encontrado');
  if (!l.revogado_em) db.prepare('UPDATE kb_links SET revogado_em = ?, revogado_por = ? WHERE id = ?').run(agora.toISOString(), op, l.id);
  return { ok: true };
}

function linksDaMidia(db, midiaId) {
  return db.prepare('SELECT id, finalidade, expira_em, revogado_em, revogado_por, criado_por, criado_em, acessos FROM kb_links WHERE midia_id = ? ORDER BY id DESC')
    .all(Number(midiaId)).map((l) => ({ ...l, url: null }));
}

// Rota pública GET /m/:token (montada no server.js ANTES do login).
function rotaPublica({ db, storage, log = console.log }) {
  return async (req, res) => {
    const r = resolverLink(db, req.params.token);
    if (r.erro) {
      res.status(410).type('html').send(`<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
        <title>Cavallaria Garage</title><body style="font-family:Arial,sans-serif;padding:32px;max-width:520px;margin:auto;color:#1f2330">
        <h1 style="font-size:20px">Cavallaria Garage</h1><p>${r.erro}</p><p>(46) 2604-0612</p></body></html>`);
      return;
    }
    try {
      const ext = { video: 'mp4', audio: 'm4a', pdf: 'pdf', foto: 'jpg' }[r.midia.tipo] || 'bin';
      const url = await storage.urlVer(r.midia.chave_objeto, { nomeArquivo: `cavallaria-${r.midia.id}.${ext}`, contentType: r.midia.mime });
      res.redirect(302, url);
    } catch (e) {
      log('kanban: link público falhou: ' + e.message);
      res.status(503).send('Arquivo indisponível no momento. Tente de novo em instantes.');
    }
  };
}

module.exports = { criarLink, resolverLink, revogarLink, linksDaMidia, rotaPublica, baseUrl, DIAS_PADRAO };
