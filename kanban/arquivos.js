// PDFs (checklists e Launch) abrem por uma rota do app, não direto pela URL assinada:
// assim cada download fica no log de auditoria (seção 12) e a URL assinada de 15 min só é
// criada na hora do clique.
const crypto = require('crypto');
const orcamentoPdf = require('./orcamento-pdf');
const { ErroAcao } = require('./acoes');
const MAX_PDF = 30 * 1024 * 1024;

const caminhoAbrir = (midiaId) => `/api/kanban/midias/${midiaId}/abrir`;

// Nome sugerido no download ("vistoria-entrada-cliente-v2.pdf", nome original do Launch...).
function nomeDoPdf(db, midiaId) {
  const p = db.prepare('SELECT tipo, via, versao FROM kb_pdfs WHERE midia_id = ?').get(Number(midiaId));
  if (p) return `${p.tipo.replace(/_/g, '-')}${p.via === 'unica' ? '' : `-${p.via}`}-v${p.versao}.pdf`;
  const l = db.prepare('SELECT nome_arquivo FROM launch_relatorios WHERE midia_id = ?').get(Number(midiaId));
  if (l) return l.nome_arquivo;
  const m = db.prepare('SELECT legenda FROM kb_midias WHERE id = ?').get(Number(midiaId));
  if (m && /\.pdf$/i.test(m.legenda || '')) return m.legenda; // orçamento / orçamento aprovado pelo cliente
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
  if (m.nome_arquivo) return m.nome_arquivo; // anexo de arquivo: nome original
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

// PDF do orçamento (Cauã) ou do orçamento aprovado pelo cliente (Luan, aprovação parcial). Vai da memória do
// servidor direto para o bucket e fica ligado ao card; só aparece na linha do tempo quando o card
// muda de fase com ele (o evento de fase leva o PDF).
const TIPOS_PDF_CARD = { orcamento: 'orcamento', via_cliente: 'orcamento-aprovado-cliente' };
async function salvarPdfDoCard(db, storage, { cardId, tipo, bytes, operador, opcao = null, agora = new Date().toISOString() }) {
  if (!storage || !storage.configurado) throw new ErroAcao(503, 'Armazenamento de mídia não configurado');
  if (!TIPOS_PDF_CARD[tipo]) throw new ErroAcao(400, 'Tipo de PDF inválido');
  if (!bytes || !bytes.length) throw new ErroAcao(400, 'PDF vazio');
  if (bytes.length > MAX_PDF) throw new ErroAcao(413, 'PDF grande demais (máximo 30 MB)');
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new ErroAcao(415, 'O arquivo precisa ser um PDF');
  const card = db.prepare('SELECT id, os_numero, arquivado_em FROM kb_cards WHERE id = ?').get(Number(cardId));
  if (!card) throw new ErroAcao(404, 'Card não encontrado');
  if (card.arquivado_em) throw new ErroAcao(409, 'Card arquivado: desarquive para anexar');
  const d = new Date(agora);
  const chave = `orcamentos/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.pdf`;
  await storage.enviar(chave, bytes, 'application/pdf');
  const id = db.prepare(`INSERT INTO kb_midias (cliente_id, chave_objeto, tipo, mime, tamanho_bytes, card_id, status, autor_nome, criado_em, enviado_em)
      VALUES (?, ?, 'pdf', 'application/pdf', ?, ?, 'enviado', ?, ?, ?)`).run(`${tipo}-${crypto.randomUUID()}`, chave, bytes.length, card.id, operador, agora, agora).lastInsertRowid;
  const n = tipo === 'orcamento' && Number.isInteger(Number(opcao)) && Number(opcao) > 1 ? Number(opcao) : null; // Orçamento 2, 3…
  db.prepare('UPDATE kb_midias SET legenda = ? WHERE id = ?').run(`${TIPOS_PDF_CARD[tipo]}${n ? `-${n}` : ''}-os${card.os_numero}-${id}.pdf`, id);
  const pecas = await lerPecasDoPdf(db, id, bytes);
  return { midia_id: id, pecas_lidas: pecas ? pecas.length : null };
}

// Peças da tabela "INFORMAÇÕES DE PEÇAS" do PDF do Onmotor, guardadas na mídia (kb_midias.pdf_pecas).
// Falha na leitura não impede o anexo: fica sem peças lidas (NULL) e a separação usa a solicitação.
async function lerPecasDoPdf(db, midiaId, bytes) {
  try {
    const pecas = await orcamentoPdf.pecasDoPdf(bytes);
    db.prepare('UPDATE kb_midias SET pdf_pecas = ? WHERE id = ?').run(JSON.stringify(pecas), midiaId);
    return pecas;
  } catch (_) {
    return null;
  }
}

// Peças já lidas da mídia; PDF enviado antes da leitura existir (NULL) é lido agora do bucket.
async function pecasDaMidia(db, storage, midiaId) {
  const m = midiaId ? db.prepare("SELECT id, chave_objeto, pdf_pecas FROM kb_midias WHERE id = ? AND tipo = 'pdf' AND removido_em IS NULL").get(Number(midiaId)) : null;
  if (!m) return [];
  if (m.pdf_pecas !== null && m.pdf_pecas !== undefined) { try { return JSON.parse(m.pdf_pecas) || []; } catch (_) { return []; } }
  if (!storage || !storage.configurado) return [];
  let bytes;
  try { bytes = await storage.ler(m.chave_objeto); } catch (_) { return []; }
  return (await lerPecasDoPdf(db, m.id, bytes)) || [];
}

module.exports = { lerPecasDoPdf, pecasDaMidia, caminhoAbrir, caminhoBaixar, nomeDoPdf, nomeDaMidia, urlDoPdf, urlParaBaixar, salvarPdfDoCard };
