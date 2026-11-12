// Peças lidas do PDF de orçamento do Onmotor (pedido de 12/11/2026). O PDF de teste é gerado aqui,
// no mesmo formato da tabela "INFORMAÇÕES DE PEÇAS" do Onmotor, sem dado de cliente.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const { bancoDeTeste } = require('./helpers/db');
const nov = require('./helpers/novidades');
const { aplicarLeitura } = require('../kanban/sync');
const acoes = require('../kanban/acoes');
const pecas = require('../kanban/pecas');
const arquivos = require('../kanban/arquivos');
const orcamentoPdf = require('../kanban/orcamento-pdf');
const fluxo = require('../kanban/fluxo');
const { criarRouter } = require('../kanban/routes');
const { criarStorage } = require('../kanban/storage');
const { iniciarS3Dev } = require('../tools/s3-dev');

const AGORA = '2026-11-12T12:00:00.000Z';
const F = fluxo.FASE;

// PDF de uma página: cada linha é uma lista de [x, texto] na mesma altura (Helvetica, WinAnsi).
function pdfDeLinhas(linhas) {
  const esc = (s) => s.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)');
  let y = 800;
  const ops = [];
  for (const partes of linhas) {
    for (const [x, t] of partes) ops.push(`BT /F1 8 Tf ${x} ${y} Td (${esc(t)}) Tj ET`);
    y -= 14;
  }
  const conteudo = Buffer.from(ops.join('\n'), 'latin1');
  const objs = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    null,
  ];
  const partes = [Buffer.from('%PDF-1.4\n', 'latin1')];
  const offs = [];
  let tam = partes[0].length;
  objs.forEach((o, i) => {
    offs.push(tam);
    const b = o === null
      ? Buffer.concat([Buffer.from(`${i + 1} 0 obj\n<< /Length ${conteudo.length} >>\nstream\n`, 'latin1'), conteudo, Buffer.from('\nendstream\nendobj\n', 'latin1')])
      : Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
    partes.push(b);
    tam += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${tam}\n%%EOF\n`;
  partes.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(partes);
}

const ORCAMENTO = pdfDeLinhas([
  [[40, 'OS: 9999'], [250, 'VIA CLIENTE']],
  [[220, 'INFORMAÇÕES DE SERVIÇOS']],
  [[40, 'A1 - Troca de óleo e filtro'], [500, 'R$ 0,00']],
  [[220, 'INFORMAÇÕES DE PEÇAS']],
  [[40, 'Peça(s)'], [380, 'Qtd'], [450, 'Valor unit.'], [510, 'Valor total']],
  [[40, 'A1.1 - FILTRO DE ÓLEO DO MOTOR MANN'], [380, '1,00 UN'], [450, 'R$ 124,91'], [510, 'R$ 124,91']],
  [[40, 'A1.2 - MOTUL 8100 X-POWER 10W60'], [380, '7,00 LT'], [450, 'R$ 153,99'], [510, 'R$ 1.077,93']],
  [[40, 'A10.1 - JUNTA DO CAVALETE (ELRING)'], [380, '1,50 PC'], [450, 'R$ 20,00'], [510, 'R$ 30,00']],
  [[40, 'Total Serviço(s): R$ 0,00'], [250, 'Total Peça(s): R$ 1.232,84']],
  [[40, 'A9.9 - NAO E PECA 1,00 UN R$ 1,00 R$ 1,00']],
]);

let s3;
let storage;
let pasta;
before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-orcpdf-'));
  s3 = await iniciarS3Dev({ porta: 0, dir: path.join(pasta, 's3'), log: () => {} });
  storage = criarStorage({
    STORAGE_ENDPOINT: `http://127.0.0.1:${s3.porta}`, STORAGE_BUCKET: 'kanban-dev', STORAGE_ACCESS_KEY: 'devkey',
    STORAGE_SECRET_KEY: 'devsecret', STORAGE_REGION: 'us-east-1', STORAGE_PATH_STYLE: 'true',
  });
});
after(async () => {
  await s3.fechar();
  fs.rmSync(pasta, { recursive: true, force: true });
});

function banco() {
  const db = bancoDeTeste();
  db.transaction(() => aplicarLeitura(db, nov.linhas(), { agora: '2026-11-10T12:00:00.000Z', primeiraCarga: true }))();
  return db;
}
const mover = (db, id, faseId, extra = {}) => acoes.moverCard(db, id, { faseId, operador: 'Teste', ...extra }, { agora: AGORA });

test('linhas do PDF → peças: código, descrição, quantidade e unidade; para no rodapé de totais', () => {
  const p = orcamentoPdf.pecasDasLinhas([
    'INFORMAÇÕES DE SERVIÇOS', 'A1 - Troca de óleo R$ 0,00',
    'INFORMAÇÕES DE PEÇAS', 'Peça(s) Qtd Valor unit. Valor total',
    'A4.2 - ATE DOT 4 2,00 FRASCO R$ 22,34 R$ 44,68',
    'A9.1 - SELO 32,0MM PK 1,00 PC R$ 12,95 R$ 12,95',
    'B2.1 - PARAFUSO 3,00 R$ 1,00 R$ 3,00',
    'Total Serviço(s): R$ 4.544,87 Total Peça(s): R$ 1.969,59 Valor total: R$ 6.514,46',
    'A5.1 - DEPOIS DO TOTAL 1,00 UN R$ 1,00 R$ 1,00',
  ]);
  assert.deepEqual(p, [
    { codigo: 'A4.2', descricao: 'ATE DOT 4', quantidade: '2', unidade: 'FRASCO' },
    { codigo: 'A9.1', descricao: 'SELO 32,0MM PK', quantidade: '1', unidade: 'PC' },
    { codigo: 'B2.1', descricao: 'PARAFUSO', quantidade: '3', unidade: null },
  ]);
  assert.equal(orcamentoPdf.descricaoDaPeca(p[0]), 'ATE DOT 4 — 2 FRASCO');
  assert.equal(orcamentoPdf.descricaoDaPeca(p[2]), 'PARAFUSO — 3');
});

test('PDF real (gerado no formato do Onmotor) → peças', async () => {
  const p = await orcamentoPdf.pecasDoPdf(ORCAMENTO);
  assert.deepEqual(p.map(orcamentoPdf.descricaoDaPeca), ['FILTRO DE ÓLEO DO MOTOR MANN — 1 UN', 'MOTUL 8100 X-POWER 10W60 — 7 LT', 'JUNTA DO CAVALETE (ELRING) — 1,5 PC']);
  assert.deepEqual(await orcamentoPdf.pecasDoPdf(Buffer.from('%PDF-1.4 quebrado')).catch(() => 'erro'), 'erro');
});

test('anexar o PDF lê as peças; a aprovação lança as do PDF aprovado na separação', async () => {
  const db = banco();
  const c = db.prepare('SELECT * FROM kb_cards WHERE fase_id = 2 ORDER BY id LIMIT 1').get();
  mover(db, c.id, F.ORCAMENTO, { pecas: [{ descricao: 'Troca de óleo' }] });
  const orc = await arquivos.salvarPdfDoCard(db, storage, { cardId: c.id, tipo: 'orcamento', bytes: ORCAMENTO, operador: 'Cauã', agora: AGORA });
  assert.equal(orc.pecas_lidas, 3);
  mover(db, c.id, F.APROVACAO, { pdfMidiaId: orc.midia_id });
  mover(db, c.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'integral' });
  assert.deepEqual(pecas.listar(db, c.id).map((p) => [p.descricao, p.situacao]), [
    ['FILTRO DE ÓLEO DO MOTOR MANN — 1 UN', 'a_definir'], ['MOTUL 8100 X-POWER 10W60 — 7 LT', 'a_definir'], ['JUNTA DO CAVALETE (ELRING) — 1,5 PC', 'a_definir']]);

  // PDF sem tabela de peças (ou ilegível): a aprovação usa as peças da solicitação
  const d = db.prepare('SELECT * FROM kb_cards WHERE fase_id = 2 ORDER BY id LIMIT 1').get();
  mover(db, d.id, F.ORCAMENTO, { pecas: [{ descricao: 'Bateria 60 Ah' }] });
  const vazio = await arquivos.salvarPdfDoCard(db, storage, { cardId: d.id, tipo: 'orcamento', bytes: pdfDeLinhas([[[40, 'sem peças']]]), operador: 'Cauã', agora: AGORA });
  assert.equal(vazio.pecas_lidas, 0);
  mover(db, d.id, F.APROVACAO, { pdfMidiaId: vazio.midia_id });
  const via = await arquivos.salvarPdfDoCard(db, storage, { cardId: d.id, tipo: 'via_cliente', bytes: Buffer.from('%PDF-1.4 ilegível'), operador: 'Luan', agora: AGORA });
  assert.equal(via.pecas_lidas, null);
  mover(db, d.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'parcial', pdfMidiaId: via.midia_id });
  assert.deepEqual(pecas.listar(db, d.id).map((p) => p.descricao), ['Bateria 60 Ah']);
});

test('rota de sugestões: PDF já enviado antes da leitura é lido do bucket na hora', async () => {
  const db = banco();
  const c = db.prepare('SELECT * FROM kb_cards WHERE fase_id = 2 ORDER BY id LIMIT 1').get();
  mover(db, c.id, F.ORCAMENTO, { pecas: [{ descricao: 'Buchas da bandeja' }] });
  const orc = await arquivos.salvarPdfDoCard(db, storage, { cardId: c.id, tipo: 'orcamento', bytes: ORCAMENTO, operador: 'Cauã', agora: AGORA });
  db.prepare('UPDATE kb_midias SET pdf_pecas = NULL WHERE id = ?').run(orc.midia_id); // como os enviados antes desta versão
  mover(db, c.id, F.APROVACAO, { pdfMidiaId: orc.midia_id });
  mover(db, c.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'integral' });
  assert.deepEqual(pecas.listar(db, c.id).map((p) => p.descricao), ['Buchas da bandeja'], 'sem leitura ainda, vale a solicitação');

  const app = express();
  app.use(express.json());
  app.use('/api/kanban', criarRouter({ db, log: () => {}, criarCliente: () => null, storage }));
  const srv = app.listen(0);
  try {
    const sug = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/kanban/cards/${c.id}/pecas-sugeridas`)).json();
    assert.deepEqual(sug.pdf.map((p) => p.descricao), ['FILTRO DE ÓLEO DO MOTOR MANN — 1 UN', 'MOTUL 8100 X-POWER 10W60 — 7 LT', 'JUNTA DO CAVALETE (ELRING) — 1,5 PC']);
    assert.deepEqual(sug.ultima_solicitacao.map((p) => p.descricao), ['Buchas da bandeja']);
    assert.equal(JSON.parse(db.prepare('SELECT pdf_pecas FROM kb_midias WHERE id = ?').get(orc.midia_id).pdf_pecas).length, 3, 'guardou a leitura');
  } finally {
    srv.close();
  }
});
