// Peças do PDF de orçamento do Onmotor (via do cliente / orçamento), pedido do Guilherme em 12/11/2026.
//
// O PDF do Onmotor tem a tabela "INFORMAÇÕES DE PEÇAS":
//   Peça(s)                                   Qtd         Valor unit.  Valor total
//   A5.2 - MOTUL 8100 X-POWER 10W60           7,00 LT     R$ 153,99    R$ 1.077,93
// Lemos o texto com o pdf.js (Mozilla), remontamos as linhas pela posição na página e tiramos
// código, descrição, quantidade e unidade de cada peça. Nada do cliente sai daqui: só as peças.
const MAX_BYTES = 30 * 1024 * 1024;

let pdfjs = null;
async function carregarPdfjs() {
  if (!pdfjs) pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs;
}

// Linhas de texto de cada página, na ordem de leitura (de cima para baixo, da esquerda para a direita).
async function linhasDoPdf(bytes) {
  const { getDocument } = await carregarPdfjs();
  const doc = await getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, useSystemFonts: false, verbosity: 0 }).promise;
  const linhas = [];
  try {
    for (let n = 1; n <= Math.min(doc.numPages, 20); n++) {
      const pag = await doc.getPage(n);
      const { items } = await pag.getTextContent();
      const porY = [];
      for (const it of items) {
        if (!it.str || !it.str.trim()) continue;
        const x = it.transform[4];
        const y = it.transform[5];
        let l = porY.find((g) => Math.abs(g.y - y) <= 2.5);
        if (!l) { l = { y, partes: [] }; porY.push(l); }
        l.partes.push({ x, s: it.str });
      }
      porY.sort((a, b) => b.y - a.y);
      for (const l of porY) linhas.push(l.partes.sort((a, b) => a.x - b.x).map((p) => p.s.trim()).join(' ').replace(/\s+/g, ' ').trim());
    }
  } finally {
    await doc.destroy();
  }
  return linhas;
}

const RX_PECA = /^([A-Z]{0,3}\d+(?:\.\d+)+)\s*-\s*(.+?)\s+(\d{1,6}(?:[.,]\d{1,3})?)\s+([A-Za-zÀ-ú.]{1,12})\s+R\$\s*[\d.]+,\d{2}\s+R\$\s*[\d.]+,\d{2}$/;
const RX_PECA_SEM_UNIDADE = /^([A-Z]{0,3}\d+(?:\.\d+)+)\s*-\s*(.+?)\s+(\d{1,6}(?:[.,]\d{1,3})?)\s+R\$\s*[\d.]+,\d{2}\s+R\$\s*[\d.]+,\d{2}$/;

const qtdTexto = (q) => {
  const n = Number(String(q).replace(/\./g, '').replace(',', '.'));
  return Number.isFinite(n) ? String(Math.round(n * 1000) / 1000).replace('.', ',') : String(q);
};

// Das linhas do PDF para as peças: só o trecho entre "INFORMAÇÕES DE PEÇAS" e o rodapé de totais.
function pecasDasLinhas(linhas) {
  const out = [];
  let dentro = false;
  for (const linha of linhas) {
    if (/INFORMA[ÇC][ÕO]ES DE PE[ÇC]AS/i.test(linha)) { dentro = true; continue; }
    if (!dentro) continue;
    if (/^Total Servi[çc]o|Valor total:|^INFORMA[ÇC][ÕO]ES DE /i.test(linha)) break;
    const m = linha.match(RX_PECA) || linha.match(RX_PECA_SEM_UNIDADE);
    if (!m) continue;
    const [, codigo, nome, qtd, unidade] = m;
    const descricao = nome.replace(/\s+/g, ' ').trim().slice(0, 240);
    if (!descricao) continue;
    out.push({ codigo, descricao, quantidade: qtdTexto(qtd), unidade: unidade && !/^R\$/.test(unidade) ? unidade.toUpperCase() : null });
  }
  return out;
}

// Texto que vai para a lista de peças do card: "MOTUL 8100 X-POWER 10W60 — 7 LT"
const descricaoDaPeca = (p) => `${p.descricao}${p.quantidade ? ` — ${p.quantidade}${p.unidade ? ` ${p.unidade}` : ''}` : ''}`.slice(0, 300);

async function pecasDoPdf(bytes) {
  if (!bytes || !bytes.length || bytes.length > MAX_BYTES) return [];
  return pecasDasLinhas(await linhasDoPdf(bytes));
}

module.exports = { pecasDoPdf, pecasDasLinhas, linhasDoPdf, descricaoDaPeca };
