// Anexo de qualquer formato no card (tipo "arquivo") e orçamento com opções de escolha pelo cliente
// (Orçamento 1, 2, 3…: na aprovação integral, o operador diz qual foi aprovado). 12/11/2026.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { bancoDeTeste } = require('./helpers/db');
const nov = require('./helpers/novidades');
const { aplicarLeitura } = require('../kanban/sync');
const acoes = require('../kanban/acoes');
const pecas = require('../kanban/pecas');
const fluxo = require('../kanban/fluxo');
const lt = require('../kanban/linha-tempo');
const { criarStorage } = require('../kanban/storage');
const { iniciarS3Dev } = require('../tools/s3-dev');
const { criarRouter } = require('../kanban/routes');

const AGORA = '2026-11-12T12:00:00.000Z';
const F = fluxo.FASE;
const PECAS = [{ descricao: 'Amortecedores dianteiros', origem: 'manual' }];

let s3;
let storage;
let pasta;
before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-opc-'));
  s3 = await iniciarS3Dev({ porta: 0, dir: pasta, log: () => {} });
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
const umCard = (db) => db.prepare('SELECT * FROM kb_cards WHERE fase_id = 2 ORDER BY id LIMIT 1').get();
const mover = (db, id, faseId, extra = {}) => acoes.moverCard(db, id, { faseId, operador: 'Teste', ...extra }, { agora: AGORA });
const pdfFalso = (db, cardId, pecasDoPdf = null) => db.prepare(`INSERT INTO kb_midias (cliente_id, chave_objeto, tipo, mime, card_id, status, autor_nome, criado_em, enviado_em, pdf_pecas)
    VALUES (?, ?, 'pdf', 'application/pdf', ?, 'enviado', 'Cauã', ?, ?, ?)`).run(`t-${Math.random()}`, `t/${Math.random()}.pdf`, cardId, AGORA, AGORA, pecasDoPdf ? JSON.stringify(pecasDoPdf) : null).lastInsertRowid;
const ultimoOrc = (db, id) => db.prepare('SELECT * FROM kb_orcamentos WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(id);
const eventos = (db, id) => db.prepare('SELECT * FROM kb_eventos WHERE card_id = ? ORDER BY id').all(id);

function servidor(db) {
  const app = express();
  app.use(express.json());
  app.use('/api/kanban', criarRouter({ db, log: () => {}, criarCliente: () => null, storage }));
  const srv = app.listen(0);
  return { srv, base: `http://127.0.0.1:${srv.address().port}/api/kanban` };
}

// ---------- anexo de arquivo ----------
test('anexo de arquivo (XML): pedir → enviar → confirmar; aparece com o nome original e baixa', async () => {
  const db = banco();
  const c = umCard(db);
  const XML = Buffer.from('<?xml version="1.0"?><nfe><item>Amortecedor</item></nfe>');
  await assert.rejects(lt.pedirEnvio(db, storage, c.id, { cliente_id: 'arq-sem-nome', tipo: 'arquivo', mime: 'text/xml', tamanho: XML.length, operador: 'Cauã' }), (e) => e.status === 400 && /sem nome/.test(e.message));
  await assert.rejects(lt.pedirEnvio(db, storage, c.id, { cliente_id: 'arq-grande1', tipo: 'arquivo', mime: 'text/xml', nome: 'x.xml', tamanho: 51 * 1024 * 1024, operador: 'Cauã' }), (e) => e.status === 413);

  const p = await lt.pedirEnvio(db, storage, c.id, { cliente_id: 'arq-xml-0001', tipo: 'arquivo', mime: 'text/xml', nome: 'C:\\fakepath\\NF fornecedor 123.xml', tamanho: XML.length, operador: 'Cauã' });
  const m = db.prepare('SELECT * FROM kb_midias WHERE id = ?').get(p.midia_id);
  assert.equal(m.tipo, 'arquivo');
  assert.equal(m.nome_arquivo, 'NF fornecedor 123.xml', 'sem a pasta');
  assert.match(m.chave_objeto, /\.xml$/);
  assert.equal((await fetch(p.upload_url, { method: 'PUT', headers: { 'Content-Type': 'text/xml' }, body: XML })).status, 200);
  const conf = await lt.confirmarEnvio(db, storage, p.midia_id, { operador: 'Cauã' });

  const ev = (await lt.listarEventos(db, storage, c.id)).find((e) => e.id === conf.evento_id);
  assert.equal(ev.tipo, 'arquivo');
  assert.equal(ev.midia.nome, 'NF fornecedor 123.xml');
  assert.equal(ev.midia.url, `/api/kanban/midias/${p.midia_id}/baixar`);

  const { srv, base } = servidor(db);
  try {
    const r = await fetch(`${base}/midias/${p.midia_id}/baixar`, { redirect: 'manual' });
    assert.equal(r.status, 302);
    const assinada = r.headers.get('location');
    assert.match(decodeURIComponent(assinada), /filename\*=UTF-8''NF%20fornecedor%20123\.xml/, 'nome original com espaço no download');
    const baixado = await fetch(assinada);
    assert.equal(Buffer.from(await baixado.arrayBuffer()).toString(), XML.toString());
    // anexo pode ser removido da linha do tempo
    const rem = await fetch(`${base}/eventos/${conf.evento_id}/remover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operador: 'Gerência' }) });
    assert.equal(rem.status, 200);
  } finally { srv.close(); }
});

test('anexo de arquivo: mime estranho vira octet-stream, sem extensão vira .bin, e não entra em item de checklist', async () => {
  const db = banco();
  const c = umCard(db);
  const p = await lt.pedirEnvio(db, storage, c.id, { cliente_id: 'arq-bin-0001', tipo: 'arquivo', mime: 'isso não é mime', nome: 'LEIAME', tamanho: 10, operador: 'Cauã' });
  const m = db.prepare('SELECT * FROM kb_midias WHERE id = ?').get(p.midia_id);
  assert.equal(m.mime, 'application/octet-stream');
  assert.match(m.chave_objeto, /\.bin$/);
  await assert.rejects(lt.pedirEnvio(db, storage, c.id, { cliente_id: 'arq-chk-0001', tipo: 'arquivo', mime: 'application/pdf', nome: 'a.pdf', tamanho: 10, checklist_item_id: 1, operador: 'Cauã' }), (e) => e.status === 400);
});

// ---------- orçamento com opções ----------
function comOpcoes(db, n = 2) {
  const c = umCard(db);
  mover(db, c.id, F.ORCAMENTO, { pecas: PECAS });
  const ids = Array.from({ length: n }, (_, i) => pdfFalso(db, c.id, [{ descricao: `Amortecedor opção ${i + 1}` }]));
  mover(db, c.id, F.APROVACAO, { papel: 'orcamento', pdfMidiaIds: ids });
  return { card: c, ids };
}

test('Orçamento → Aprovação com Orçamento 1 e 2: guarda as opções e registra cada PDF', () => {
  const db = banco();
  const { card, ids } = comOpcoes(db, 2);
  const orc = ultimoOrc(db, card.id);
  assert.equal(orc.pdf_midia_id, ids[0]);
  assert.deepEqual(JSON.parse(orc.opcoes), ids);
  const evs = eventos(db, card.id);
  const fase = evs.find((e) => e.tipo === 'fase' && JSON.parse(e.dados).para === F.APROVACAO);
  assert.equal(fase.midia_id, ids[0]);
  assert.match(fase.texto, /2 orçamentos em PDF anexados — opções de escolha pelo cliente/);
  const op2 = evs.find((e) => e.tipo === 'pdf' && e.midia_id === ids[1]);
  assert.match(op2.texto, /Orçamento 2 \(opção de escolha pelo cliente\)/);
});

test('opções: repetidas, de outro card ou mais de 5 são recusadas', () => {
  const db = banco();
  const c = umCard(db);
  mover(db, c.id, F.ORCAMENTO, { pecas: PECAS });
  const a = pdfFalso(db, c.id);
  assert.throws(() => mover(db, c.id, F.APROVACAO, { pdfMidiaIds: [a, a] }), (e) => e.status === 400 && /duas vezes/.test(e.message));
  const outro = pdfFalso(db, db.prepare('SELECT id FROM kb_cards WHERE id <> ? LIMIT 1').get(c.id).id);
  assert.throws(() => mover(db, c.id, F.APROVACAO, { pdfMidiaIds: [a, outro] }), (e) => e.exige === 'pdf' && /Orçamento 2/.test(e.message));
  const seis = Array.from({ length: 6 }, () => pdfFalso(db, c.id));
  assert.throws(() => mover(db, c.id, F.APROVACAO, { pdfMidiaIds: seis }), (e) => e.status === 400 && /No máximo 5/.test(e.message));
  assert.equal(db.prepare('SELECT fase_id FROM kb_cards WHERE id = ?').get(c.id).fase_id, F.ORCAMENTO);
});

test('aprovação integral com opções exige qual foi aprovado; a separação usa as peças da opção escolhida', () => {
  const db = banco();
  const { card, ids } = comOpcoes(db, 3);
  assert.throws(() => mover(db, card.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'integral' }), (e) => e.exige === 'opcao' && e.status === 400);
  assert.throws(() => mover(db, card.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'integral', opcaoAprovada: 4 }), (e) => e.exige === 'opcao');
  mover(db, card.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'integral', opcaoAprovada: 2 });
  const orc = ultimoOrc(db, card.id);
  assert.equal(orc.opcao_aprovada, 2);
  assert.equal(pecas.midiaAprovada(orc), ids[1]);
  const ev = eventos(db, card.id).filter((e) => e.tipo === 'fase').pop();
  assert.match(ev.texto, /o cliente escolheu o Orçamento 2 \(de 3 opções\)/);
  assert.equal(ev.midia_id, ids[1], 'o PDF escolhido vai junto no registro');
  assert.deepEqual(pecas.listar(db, card.id).map((p) => p.descricao), ['Amortecedor opção 2']);
});

test('aprovação parcial com opções segue anexando o PDF do cliente (sem escolher opção)', () => {
  const db = banco();
  const { card } = comOpcoes(db, 2);
  const via = pdfFalso(db, card.id);
  mover(db, card.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'parcial', pdfMidiaId: via });
  const orc = ultimoOrc(db, card.id);
  assert.equal(orc.opcao_aprovada, null);
  assert.equal(pecas.midiaAprovada(orc), via);
});

test('orçamento sem opções: aprovação integral como sempre, sem perguntar a opção', () => {
  const db = banco();
  const c = umCard(db);
  mover(db, c.id, F.ORCAMENTO, { pecas: PECAS });
  const pdf = pdfFalso(db, c.id);
  mover(db, c.id, F.APROVACAO, { pdfMidiaId: pdf });
  mover(db, c.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'integral' });
  const orc = ultimoOrc(db, c.id);
  assert.equal(orc.opcoes, null);
  assert.equal(orc.opcao_aprovada, null);
  assert.equal(pecas.midiaAprovada(orc), pdf);
});

test('rota: Orçamento N depois do envio, aviso no /estado e opção aprovada marcada no card', async () => {
  const db = banco();
  const c = umCard(db);
  mover(db, c.id, F.ORCAMENTO, { pecas: PECAS });
  const pdf1 = pdfFalso(db, c.id);
  mover(db, c.id, F.APROVACAO, { pdfMidiaId: pdf1 });
  const orcId = ultimoOrc(db, c.id).id;
  const { srv, base } = servidor(db);
  const post = (url, corpo) => fetch(`${base}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  try {
    const card = async () => (await (await fetch(`${base}/estado`)).json()).cards.find((x) => x.id === c.id);
    assert.deepEqual((await card()).orcamento.opcoes, [], 'um PDF só: sem opções');
    const pdf2 = pdfFalso(db, c.id);
    let r = await post(`/cards/${c.id}/orcamentos/${orcId}/opcoes`, { pdf_midia_id: pdf2, operador: 'Cauã' });
    assert.equal(r.status, 200);
    assert.equal((await r.json()).opcao, 2);
    r = await post(`/cards/${c.id}/orcamentos/${orcId}/opcoes`, { pdf_midia_id: pdf2, operador: 'Cauã' });
    assert.equal(r.status, 400, 'o mesmo PDF não vale duas vezes');
    const est = await card();
    assert.deepEqual(est.orcamento.opcoes.map((o) => [o.numero, o.aprovada]), [[1, false], [2, false]]);
    assert.equal(est.orcamento.opcoes[1].url, `/api/kanban/midias/${pdf2}/abrir`);
    assert.ok(eventos(db, c.id).some((e) => e.tipo === 'pdf' && e.midia_id === pdf2 && /Orçamento 2/.test(e.texto)));

    mover(db, c.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'integral', opcaoAprovada: 2 });
    const depois = await card();
    assert.equal(depois.orcamento.opcao_aprovada, 2);
    assert.equal(depois.orcamento.aprovado_url, `/api/kanban/midias/${pdf2}/abrir`);
    assert.deepEqual(depois.orcamento.opcoes.map((o) => o.aprovada), [false, true]);
    const det = await (await fetch(`${base}/cards/${c.id}`)).json();
    assert.equal(det.orcamentos[0].opcao_aprovada, 2);
    // orçamento já decidido não recebe opção nova
    r = await post(`/cards/${c.id}/orcamentos/${orcId}/opcoes`, { pdf_midia_id: pdfFalso(db, c.id), operador: 'Cauã' });
    assert.equal(r.status, 409);
  } finally { srv.close(); }
});

test('opção depois do envio: só compras ou movimentação total', () => {
  const db = banco();
  const c = umCard(db);
  mover(db, c.id, F.ORCAMENTO, { pecas: PECAS });
  mover(db, c.id, F.APROVACAO, { pdfMidiaId: pdfFalso(db, c.id) });
  const orcId = ultimoOrc(db, c.id).id;
  assert.throws(() => acoes.adicionarOpcaoOrcamento(db, c.id, orcId, { pdfMidiaId: pdfFalso(db, c.id), operador: 'Luan', papel: 'aprovacao' }), (e) => e.status === 403);
  assert.equal(acoes.adicionarOpcaoOrcamento(db, c.id, orcId, { pdfMidiaId: pdfFalso(db, c.id), operador: 'Cauã', papel: 'orcamento' }, { agora: AGORA }).opcao, 2);
});

test('migração 019 desfaz e refaz (sem anexos de arquivo)', () => {
  const db = bancoDeTeste();
  const { reverter, aplicar } = require('../migrations');
  reverter(db); // a última é a 019
  assert.ok(!db.prepare('PRAGMA table_info(kb_orcamentos)').all().some((c) => c.name === 'opcoes'));
  aplicar(db);
  assert.ok(db.prepare('PRAGMA table_info(kb_orcamentos)').all().some((c) => c.name === 'opcao_aprovada'));
  assert.ok(db.prepare('PRAGMA table_info(kb_midias)').all().some((c) => c.name === 'nome_arquivo'));
});
