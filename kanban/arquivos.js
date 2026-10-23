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

module.exports = { caminhoAbrir, nomeDoPdf, urlDoPdf };
