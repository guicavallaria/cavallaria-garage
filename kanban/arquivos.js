// PDFs (checklists e Launch) abrem por uma rota do app, não direto pela URL assinada:
// assim cada download fica no log de auditoria (seção 12) e a URL assinada de 15 min só é
// criada na hora do clique.
const { ErroAcao } = require('./acoes');

const caminhoAbrir = (midiaId) => `/api/kanban/midias/${midiaId}/abrir`;

// Nome sugerido no download ("vistoria-entrada-cliente-v2.pdf", nome original do Launch...).
function nomeDoPdf(db, midiaId) {
  const p = db.prepare('SELECT tipo, via, versao FROM kb_pdfs WHERE midia_id = ?').get(Number(midiaId));
  if (p) return `${p.tipo.replace(/_/g, '-')}${p.via === 'unica' ? '' : `-${p.via}`}-v${p.versao}.pdf`;
  const l = db.prepare('SELECT nome_arquivo FROM launch_relatorios WHERE midia_id = ?').get(Number(midiaId));
  if (l) return l.nome_arquivo;
  return `documento-${midiaId}.pdf`;
}

async function urlDoPdf(db, storage, midiaId) {
  if (!storage || !storage.configurado) throw new ErroAcao(503, 'Armazenamento de mídia não configurado');
  const m = db.prepare("SELECT * FROM kb_midias WHERE id = ? AND tipo = 'pdf' AND status = 'enviado' AND removido_em IS NULL").get(Number(midiaId));
  if (!m) throw new ErroAcao(404, 'PDF não encontrado');
  const url = await storage.urlVer(m.chave_objeto, { nomeArquivo: nomeDoPdf(db, m.id), contentType: 'application/pdf' });
  return { url, midia: m };
}

// Botão "Baixar" do card: qualquer mídia (foto, vídeo, áudio, PDF) sai como download direto.
const caminhoBaixar = (midiaId) => `/api/kanban/midias/${midiaId}/baixar`;
const EXTENSAO = {
  'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic',
  'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm',
  'audio/webm': 'webm', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg', 'audio/aac': 'aac',
  'application/pdf': 'pdf',
};
function extensao(m) {
  const mime = String(m.mime || '').split(';')[0].trim().toLowerCase();
  if (EXTENSAO[mime]) return EXTENSAO[mime];
  const daChave = /\.([a-z0-9]{2,5})$/i.exec(m.chave_objeto || '');
  return daChave ? daChave[1].toLowerCase() : 'bin';
}
function nomeDaMidia(db, m) {
  if (m.tipo === 'pdf') return nomeDoPdf(db, m.id);
  const card = m.card_id ? db.prepare('SELECT os_numero FROM kb_cards WHERE id = ?').get(m.card_id) : null;
  return `${card ? `os${card.os_numero}-` : ''}${m.tipo}-${m.id}.${extensao(m)}`;
}
async function urlParaBaixar(db, storage, midiaId) {
  if (!storage || !storage.configurado) throw new ErroAcao(503, 'Armazenamento de mídia não configurado');
  const m = db.prepare("SELECT * FROM kb_midias WHERE id = ? AND status = 'enviado' AND removido_em IS NULL").get(Number(midiaId));
  if (!m) throw new ErroAcao(404, 'Arquivo não encontrado');
  const url = await storage.urlVer(m.chave_objeto, { nomeArquivo: nomeDaMidia(db, m), contentType: m.mime || null, baixar: true });
  return { url, midia: m };
}

module.exports = { caminhoAbrir, caminhoBaixar, nomeDoPdf, nomeDaMidia, urlDoPdf, urlParaBaixar };
