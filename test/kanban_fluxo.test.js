// Setor de orçamento e peças (pedido de 11/11/2026): quem move cards e o que cada passagem exige.
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
const fluxo = require('../kanban/fluxo');
const { criarRouter } = require('../kanban/routes');
const { criarStorage } = require('../kanban/storage');
const { iniciarS3Dev } = require('../tools/s3-dev');

const AGORA = '2026-11-11T12:00:00.000Z';
const F = fluxo.FASE;

let s3;
let storage;
let pasta;
before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-fluxo-'));
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
const umCard = (db) => db.prepare('SELECT * FROM kb_cards WHERE fase_id = 2 ORDER BY id LIMIT 1').get();
const ler = (db, id) => db.prepare('SELECT * FROM kb_cards WHERE id = ?').get(id);
const ultimoEvento = (db, id) => db.prepare('SELECT * FROM kb_eventos WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(id);
const PECAS = [{ descricao: 'Pastilhas dianteiras', origem: 'checklist' }, { descricao: 'Sensor de ângulo de direção', origem: 'manual' }];
const PDF = Buffer.from('%PDF-1.4\n% orcamento\n%%EOF\n');
const mover = (db, id, faseId, extra = {}) => acoes.moverCard(db, id, { faseId, operador: 'Teste', ...extra }, { agora: AGORA });
// PDF ligado ao card sem passar pelo bucket (as exigências só olham kb_midias)
const pdfFalso = (db, cardId) => db.prepare(`INSERT INTO kb_midias (cliente_id, chave_objeto, tipo, mime, card_id, status, autor_nome, criado_em, enviado_em)
    VALUES (?, ?, 'pdf', 'application/pdf', ?, 'enviado', 'Cauã', ?, ?)`).run(`t-${Math.random()}`, `t/${Math.random()}.pdf`, cardId, AGORA, AGORA).lastInsertRowid;

test('papéis: o que cada um pode mover', () => {
  const todas = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  assert.equal(fluxo.destinosPermitidos('total', 2, todas).length, 9);
  assert.deepEqual(fluxo.destinosPermitidos('orcamento', F.ORCAMENTO, todas), [F.APROVACAO]);
  assert.deepEqual(fluxo.destinosPermitidos('orcamento', F.AQUISICAO, todas), [F.AGUARDANDO_PECAS, F.AGENDAMENTO]);
  assert.deepEqual(fluxo.destinosPermitidos('orcamento', F.AGUARDANDO_PECAS, todas), [F.AGENDAMENTO, F.AQUISICAO]);
  assert.deepEqual(fluxo.destinosPermitidos('orcamento', F.APROVACAO, todas), []);
  assert.deepEqual(fluxo.destinosPermitidos('aprovacao', F.APROVACAO, todas), [F.AQUISICAO, F.ORCAMENTO]);
  assert.deepEqual(fluxo.destinosPermitidos('aprovacao', F.ORCAMENTO, todas), []);
  assert.deepEqual(fluxo.destinosPermitidos('registro', 2, todas), []);
});

test('migração 014: papel inicial pelo nome e a conta gerencia move tudo', () => {
  const db = bancoDeTeste();
  // desfaz a 014, cria os usuários como estão hoje em produção e aplica de novo
  const { reverter, aplicar } = require('../migrations');
  assert.deepEqual(reverter(db, undefined, 5), ['018_peca_chegou.js', '017_card_urgente.js', '016_pdf_pecas.js', '015_pecas_separacao.js', '014_orcamento_pecas.js']);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kb_fases').get().n, 9);
  const ins = db.prepare("INSERT INTO usuarios (login, nome, perfil, senha_hash, criado_em, criado_por) VALUES (?, ?, ?, 'x', '2026-11-11', 't')");
  // contas de setor como estão em produção (compras = Cauã, pátio = Vanilton, recepção = Luan,
  // gerência = Guilherme e Lucas) + um login individual pelo nome + um mecânico
  for (const [l, n, p] of [['recepcao', 'Recepção', 'recepcao'], ['compras', 'Compras', 'compras'], ['patio', 'Pátio', 'patio'],
    ['gerencia', 'Gerência', 'gerencia'], ['edson', 'Edson', 'mecanico'], ['lucas.s', 'Lucas Souza', 'gerencia']]) ins.run(l, n, p);
  assert.deepEqual(aplicar(db), ['014_orcamento_pecas.js', '015_pecas_separacao.js', '016_pdf_pecas.js', '017_card_urgente.js', '018_peca_chegou.js']);
  const papeis = Object.fromEntries(db.prepare('SELECT login, kb_papel FROM usuarios').all().map((u) => [u.login, u.kb_papel]));
  assert.deepEqual(papeis, { recepcao: 'aprovacao', compras: 'orcamento', patio: 'total', gerencia: 'total', edson: 'registro', 'lucas.s': 'total' });
  assert.equal(fluxo.papelDoUsuario(db, null), 'total');
  assert.equal(fluxo.papelDoUsuario(db, { id: 0 }), 'total'); // acesso inicial
  const edson = db.prepare("SELECT id FROM usuarios WHERE login = 'edson'").get();
  assert.equal(fluxo.papelDoUsuario(db, edson), 'registro');
  db.prepare("UPDATE usuarios SET kb_papel = 'orcamento' WHERE id = ?").run(edson.id);
  assert.equal(fluxo.papelDoUsuario(db, edson), 'orcamento', 'mudança na Administração vale na hora');
  db.prepare('UPDATE usuarios SET ativo = 0 WHERE id = ?').run(edson.id);
  assert.equal(fluxo.papelDoUsuario(db, edson), 'registro');
});

test('registro não move; Cauã não move fora do setor; Luan só da aprovação', () => {
  const db = banco();
  const c = umCard(db);
  assert.throws(() => mover(db, c.id, 7, { papel: 'registro' }), (e) => e.status === 403 && /não move cards/.test(e.message));
  assert.throws(() => mover(db, c.id, F.ORCAMENTO, { papel: 'orcamento', pecas: PECAS }), (e) => e.status === 403);
  assert.throws(() => mover(db, c.id, F.ORCAMENTO, { papel: 'aprovacao', pecas: PECAS }), (e) => e.status === 403);
  assert.equal(ler(db, c.id).fase_id, 2);
});

test('entrar em Orçamento exige as peças; sem elas o card fica onde está', () => {
  const db = banco();
  const c = umCard(db);
  assert.throws(() => mover(db, c.id, F.ORCAMENTO), (e) => e.status === 400 && e.exige === 'pecas');
  assert.throws(() => mover(db, c.id, F.ORCAMENTO, { pecas: [{ descricao: '   ' }] }), (e) => e.exige === 'pecas');
  assert.equal(ler(db, c.id).fase_id, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kb_orcamentos').get().n, 0);

  mover(db, c.id, F.ORCAMENTO, { pecas: PECAS });
  assert.equal(ler(db, c.id).fase_id, F.ORCAMENTO);
  const orc = db.prepare('SELECT * FROM kb_orcamentos WHERE card_id = ?').get(c.id);
  assert.deepEqual(JSON.parse(orc.pecas), PECAS);
  assert.equal(orc.solicitado_por, 'Teste');
  const ev = ultimoEvento(db, c.id);
  assert.match(ev.texto, /Peças para orçamento \(2\):\n• Pastilhas dianteiras\n• Sensor de ângulo de direção/);
  assert.deepEqual(JSON.parse(ev.dados).pecas, PECAS);
});

test('Orçamento → Aprovação só com o PDF do orçamento (de qualquer papel)', () => {
  const db = banco();
  const c = umCard(db);
  mover(db, c.id, F.ORCAMENTO, { pecas: PECAS });
  assert.throws(() => mover(db, c.id, F.AGENDAMENTO, { papel: 'orcamento' }), (e) => e.status === 403, 'Cauã só manda para a Aprovação');
  assert.throws(() => mover(db, c.id, F.APROVACAO, { papel: 'orcamento' }), (e) => e.status === 400 && e.exige === 'pdf');
  const outro = umCard(banco());
  assert.ok(outro);
  const deOutroCard = pdfFalso(db, db.prepare('SELECT id FROM kb_cards WHERE id <> ? LIMIT 1').get(c.id).id);
  assert.throws(() => mover(db, c.id, F.APROVACAO, { papel: 'orcamento', pdfMidiaId: deOutroCard }), (e) => e.exige === 'pdf');
  assert.equal(ler(db, c.id).fase_id, F.ORCAMENTO);

  const pdf = pdfFalso(db, c.id);
  mover(db, c.id, F.APROVACAO, { papel: 'orcamento', pdfMidiaId: pdf, observacao: 'Fornecedor X' });
  assert.equal(ler(db, c.id).fase_id, F.APROVACAO);
  const ev = ultimoEvento(db, c.id);
  assert.equal(ev.midia_id, pdf, 'o PDF aparece na linha do tempo junto com a mudança de fase');
  assert.match(ev.texto, /Orçamento em PDF anexado\.\nObservação: Fornecedor X/);
  assert.equal(db.prepare('SELECT pdf_midia_id FROM kb_orcamentos WHERE card_id = ?').get(c.id).pdf_midia_id, pdf);
  // o mesmo PDF não serve para outro orçamento
  mover(db, c.id, F.ORCAMENTO, { papel: 'aprovacao', pecas: PECAS, observacao: 'Cliente pediu revisão' });
  assert.throws(() => mover(db, c.id, F.APROVACAO, { papel: 'orcamento', pdfMidiaId: pdf }), (e) => /já foi usado/.test(e.message));
});

test('Aprovação → Aquisição: integral sem documento; parcial exige o orçamento aprovado pelo cliente', () => {
  const db = banco();
  const [a, b] = db.prepare('SELECT * FROM kb_cards WHERE fase_id = 2 ORDER BY id LIMIT 2').all();
  for (const c of [a, b]) {
    mover(db, c.id, F.ORCAMENTO, { pecas: PECAS });
    mover(db, c.id, F.APROVACAO, { pdfMidiaId: pdfFalso(db, c.id) });
  }
  assert.throws(() => mover(db, a.id, F.AQUISICAO, { papel: 'aprovacao' }), (e) => e.exige === 'aprovacao');
  mover(db, a.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'integral', observacao: 'Cliente aprovou por telefone' });
  let orc = db.prepare('SELECT * FROM kb_orcamentos WHERE card_id = ? ORDER BY id DESC').get(a.id);
  assert.equal(orc.decisao, 'integral');
  assert.equal(orc.decisao_obs, 'Cliente aprovou por telefone');
  assert.equal(orc.via_cliente_midia_id, null);
  assert.match(ultimoEvento(db, a.id).texto, /aprovado integralmente/);

  assert.throws(() => mover(db, b.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'parcial' }), (e) => e.exige === 'pdf');
  assert.equal(ler(db, b.id).fase_id, F.APROVACAO);
  const via = pdfFalso(db, b.id);
  mover(db, b.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'parcial', pdfMidiaId: via });
  orc = db.prepare('SELECT * FROM kb_orcamentos WHERE card_id = ? ORDER BY id DESC').get(b.id);
  assert.equal(orc.decisao, 'parcial');
  assert.equal(orc.via_cliente_midia_id, via);
  assert.equal(ultimoEvento(db, b.id).midia_id, via);
});

test('Luan devolve ao Orçamento: motivo obrigatório e as peças viram nova solicitação', () => {
  const db = banco();
  const c = umCard(db);
  mover(db, c.id, F.ORCAMENTO, { pecas: PECAS });
  mover(db, c.id, F.APROVACAO, { pdfMidiaId: pdfFalso(db, c.id) });
  assert.throws(() => mover(db, c.id, F.ORCAMENTO, { papel: 'aprovacao', pecas: PECAS }), (e) => e.exige === 'observacao');
  mover(db, c.id, F.ORCAMENTO, { papel: 'aprovacao', pecas: PECAS.slice(0, 1), observacao: 'Cliente quer só as pastilhas' });
  const orcs = db.prepare('SELECT * FROM kb_orcamentos WHERE card_id = ? ORDER BY id').all(c.id);
  assert.equal(orcs.length, 2);
  assert.equal(orcs[0].decisao, 'devolvido');
  assert.equal(orcs[0].decisao_obs, 'Cliente quer só as pastilhas');
  assert.equal(JSON.parse(orcs[1].pecas).length, 1);
});

test('Aguardando Peças exige o prazo em dias; sair da fase limpa o prazo', () => {
  const db = banco();
  const c = umCard(db);
  mover(db, c.id, F.AQUISICAO);
  assert.throws(() => mover(db, c.id, F.AGUARDANDO_PECAS, { papel: 'orcamento' }), (e) => e.exige === 'prazo');
  assert.throws(() => mover(db, c.id, F.AGUARDANDO_PECAS, { papel: 'orcamento', prazoDias: 0 }), (e) => e.exige === 'prazo');
  assert.throws(() => mover(db, c.id, F.AGUARDANDO_PECAS, { papel: 'orcamento', prazoDias: 2.5 }), (e) => e.exige === 'prazo');
  mover(db, c.id, F.AGUARDANDO_PECAS, { papel: 'orcamento', prazoDias: 3 });
  let d = ler(db, c.id);
  assert.equal(d.pecas_prazo_dias, 3);
  assert.equal(d.pecas_prazo_em, '2026-11-14T12:00:00.000Z');
  assert.match(ultimoEvento(db, c.id).texto, /Prazo para as peças chegarem: 3 dias \(até 14\/11\/2026 09:00\)/);
  mover(db, c.id, F.AGENDAMENTO, { papel: 'orcamento' });
  d = ler(db, c.id);
  assert.equal(d.pecas_prazo_em, null);
  assert.equal(d.pecas_prazo_dias, null);
});

test('rotas: estado traz papel, destinos e exigências; PDF do orçamento sobe e move o card', async () => {
  const db = banco();
  const c = umCard(db);
  mover(db, c.id, F.ORCAMENTO, { pecas: PECAS });
  const app = express();
  app.use(express.json());
  app.use('/api/kanban', criarRouter({ db, log: () => {}, criarCliente: () => null, storage }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api/kanban`;
  try {
    const est = await (await fetch(`${base}/estado`)).json();
    assert.equal(est.eu.papel, 'total');
    assert.deepEqual(est.fases.slice(4, 7).map((f) => f.id), [5, 10, 6]);
    assert.deepEqual(est.fluxo.exigencias[2][3], ['pecas']);
    assert.deepEqual(est.fluxo.exigencias[4][5], ['aprovacao']);
    const resumo = est.cards.find((x) => x.id === c.id);
    assert.equal(resumo.orcamento.pecas.length, 2);
    assert.ok(resumo.ultimo_evento_em);

    const sug = await (await fetch(`${base}/cards/${c.id}/pecas-sugeridas`)).json();
    assert.equal(sug.ultima_solicitacao.length, 2);
    assert.ok(Array.isArray(sug.checklist));

    let r = await fetch(`${base}/cards/${c.id}/orcamento-pdf?tipo=orcamento&operador=Cauã`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: Buffer.from('nada') });
    assert.equal(r.status, 415);
    r = await fetch(`${base}/cards/${c.id}/orcamento-pdf?tipo=orcamento&operador=Cauã`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: PDF });
    assert.equal(r.status, 200);
    const { midia_id: midiaId } = await r.json();
    r = await fetch(`${base}/cards/${c.id}/mover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fase_id: 4, fase_atual: 3, operador: 'Cauã' }) });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).erro, 'Anexe o PDF do orçamento');
    r = await fetch(`${base}/cards/${c.id}/mover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fase_id: 4, fase_atual: 3, operador: 'Cauã', pdf_midia_id: midiaId }) });
    assert.equal(r.status, 200);
    const card = (await r.json()).card;
    assert.equal(card.fase_id, 4);
    assert.match(card.orcamento.pdf_url, /\/midias\/\d+\/abrir$/);
    // nome do arquivo no download: orcamento-os<N>-<id>.pdf
    const abrir = await fetch(`http://127.0.0.1:${srv.address().port}${card.orcamento.pdf_url}`, { redirect: 'manual' });
    assert.match(abrir.headers.get('location'), new RegExp(`orcamento-os${c.os_numero}-${midiaId}\\.pdf`));
    const det = await (await fetch(`${base}/cards/${c.id}`)).json();
    assert.equal(det.orcamentos[0].pdf_url, card.orcamento.pdf_url);
  } finally {
    srv.close();
  }
});
