// Separação das peças do orçamento aprovado (pedido de 12/11/2026): estoque / para pedir / pedido / fora,
// painel de peças pendentes de pedido e o "orçamento aprovado pelo cliente" no card.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { bancoDeTeste } = require('./helpers/db');
const nov = require('./helpers/novidades');
const { aplicarLeitura } = require('../kanban/sync');
const acoes = require('../kanban/acoes');
const pecas = require('../kanban/pecas');
const fluxo = require('../kanban/fluxo');
const { criarRouter } = require('../kanban/routes');

const AGORA = '2026-11-12T12:00:00.000Z';
const F = fluxo.FASE;
const PECAS = [{ descricao: 'Pastilhas dianteiras', origem: 'checklist' }, { descricao: 'Sensor de ângulo de direção', origem: 'manual' }, { descricao: 'Óleo 5W30', origem: 'manual' }];

function banco() {
  const db = bancoDeTeste();
  db.transaction(() => aplicarLeitura(db, nov.linhas(), { agora: '2026-11-10T12:00:00.000Z', primeiraCarga: true }))();
  return db;
}
const mover = (db, id, faseId, extra = {}) => acoes.moverCard(db, id, { faseId, operador: 'Teste', ...extra }, { agora: AGORA });
const pdfFalso = (db, cardId) => db.prepare(`INSERT INTO kb_midias (cliente_id, chave_objeto, tipo, mime, card_id, status, autor_nome, criado_em, enviado_em)
    VALUES (?, ?, 'pdf', 'application/pdf', ?, 'enviado', 'Cauã', ?, ?)`).run(`t-${Math.random()}`, `t/${Math.random()}.pdf`, cardId, AGORA, AGORA).lastInsertRowid;
const ultimoEvento = (db, id) => db.prepare('SELECT * FROM kb_eventos WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(id);

// card levado até a aprovação e aprovado (integral, ou parcial com o PDF do cliente)
function aprovado(db, decisao = 'integral') {
  const c = db.prepare('SELECT * FROM kb_cards WHERE fase_id = 2 ORDER BY id LIMIT 1').get();
  mover(db, c.id, F.ORCAMENTO, { pecas: PECAS });
  const orc = pdfFalso(db, c.id);
  mover(db, c.id, F.APROVACAO, { pdfMidiaId: orc });
  const via = decisao === 'parcial' ? pdfFalso(db, c.id) : null;
  mover(db, c.id, F.AQUISICAO, { papel: 'aprovacao', decisao, pdfMidiaId: via });
  return { card: c, orc, via };
}

test('aprovação copia as peças do orçamento para a separação, "a separar"', () => {
  const db = banco();
  const { card } = aprovado(db);
  const lista = pecas.listar(db, card.id);
  assert.deepEqual(lista.map((p) => [p.descricao, p.situacao]), PECAS.map((p) => [p.descricao, 'a_definir']));
  // aprovar de novo (após voltar ao orçamento) troca o que não foi pedido
  pecas.salvar(db, card.id, { operador: 'Cauã', itens: lista.map((p, i) => ({ id: p.id, situacao: i === 0 ? 'pedido' : 'pedir' })) }, { agora: AGORA });
  mover(db, card.id, F.ORCAMENTO, { pecas: [{ descricao: 'Bateria 60 Ah' }] });
  mover(db, card.id, F.APROVACAO, { pdfMidiaId: pdfFalso(db, card.id) });
  mover(db, card.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'integral' });
  assert.deepEqual(pecas.listar(db, card.id).map((p) => [p.descricao, p.situacao]), [['Pastilhas dianteiras', 'pedido'], ['Bateria 60 Ah', 'a_definir']]);
});

test('separar: estoque / para pedir / fora, incluir e retirar; registra na linha do tempo', () => {
  const db = banco();
  const { card } = aprovado(db, 'parcial');
  const [a, b, c] = pecas.listar(db, card.id);
  assert.throws(() => pecas.salvar(db, card.id, { operador: 'Edson', papel: 'registro', itens: [] }), (e) => e.status === 403);
  assert.throws(() => pecas.salvar(db, card.id, { operador: 'Cauã', papel: 'aprovacao', itens: [] }), (e) => e.status === 403);
  assert.throws(() => pecas.salvar(db, card.id, { operador: 'Cauã', papel: 'orcamento', itens: [{ id: a.id, situacao: 'xx' }] }), /Situação/);
  const r = pecas.salvar(db, card.id, {
    operador: 'Cauã', papel: 'orcamento',
    itens: [{ id: a.id, situacao: 'estoque' }, { id: b.id, situacao: 'pedir' }, { descricao: '  Filtro   de cabine ', situacao: 'pedir' }],
  }, { agora: AGORA });
  assert.equal(r.alteradas, 4); // 2 mudanças + 1 incluída + 1 retirada (c)
  assert.deepEqual(r.pecas.map((p) => [p.descricao, p.situacao, p.origem]), [
    ['Pastilhas dianteiras', 'estoque', 'orcamento'], ['Sensor de ângulo de direção', 'pedir', 'orcamento'], ['Filtro de cabine', 'pedir', 'manual']]);
  assert.ok(db.prepare('SELECT removido_em FROM kb_pecas WHERE id = ?').get(c.id).removido_em);
  const ev = ultimoEvento(db, card.id);
  assert.equal(ev.tipo, 'texto');
  assert.equal(ev.operador_nome, 'Cauã');
  assert.match(ev.texto, /^Separação de peças — 1 em estoque · 2 para pedir/);
  assert.match(ev.texto, /Óleo 5W30: retirada da lista/);
  // registro automático: não se edita nem remove
  const linhaTempo = require('../kanban/linha-tempo');
  assert.throws(() => linhaTempo.editarTexto(db, ev.id, { texto: 'outro', operador: 'Cauã' }), /Só textos/);
  assert.throws(() => linhaTempo.removerRegistro(db, ev.id, { operador: 'Cauã' }), /automáticos/);
  // gravar igual não registra nada
  const n = db.prepare('SELECT COUNT(*) AS n FROM kb_eventos WHERE card_id = ?').get(card.id).n;
  assert.equal(pecas.salvar(db, card.id, { operador: 'Cauã', itens: r.pecas.map((p) => ({ id: p.id, situacao: p.situacao })) }, { agora: AGORA }).alteradas, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kb_eventos WHERE card_id = ?').get(card.id).n, n);
});

test('marcar pedidas (painel do compras): só as "para pedir", com registro em cada card', () => {
  const db = banco();
  const { card } = aprovado(db);
  const l = pecas.listar(db, card.id);
  pecas.salvar(db, card.id, { operador: 'Cauã', itens: l.map((p, i) => ({ id: p.id, situacao: i ? 'pedir' : 'estoque' })) }, { agora: AGORA });
  assert.throws(() => pecas.marcarPedidas(db, [l[1].id], { operador: 'Luan', papel: 'aprovacao' }), (e) => e.status === 403);
  assert.throws(() => pecas.marcarPedidas(db, [l[0].id], { operador: 'Cauã' }), (e) => e.status === 409); // estoque não é pendente
  const r = pecas.marcarPedidas(db, [l[1].id, l[2].id, l[0].id], { operador: 'Cauã', papel: 'orcamento' }, { agora: AGORA });
  assert.equal(r.marcadas, 2);
  const depois = pecas.listar(db, card.id);
  assert.deepEqual(depois.map((p) => p.situacao), ['estoque', 'pedido', 'pedido']);
  assert.equal(depois[1].pedido_por, 'Cauã');
  assert.match(ultimoEvento(db, card.id).texto, /^Pedido feito \(2\):\n• Sensor de ângulo de direção\n• Óleo 5W30$/);
});

test('migração 015: cards já aprovados no setor de peças ganham as peças "a separar"', () => {
  const db = banco();
  const { card } = aprovado(db);
  const { reverter, aplicar } = require('../migrations');
  assert.deepEqual(reverter(db, undefined, 1), ['015_pecas_separacao.js']);
  assert.deepEqual(aplicar(db), ['015_pecas_separacao.js']);
  assert.deepEqual(pecas.listar(db, card.id).map((p) => p.situacao), ['a_definir', 'a_definir', 'a_definir']);
});

test('rotas: peças no estado, gravar a separação, marcar pedidas e o orçamento aprovado pelo cliente', async () => {
  const db = banco();
  const { card, via } = aprovado(db, 'parcial');
  const integral = (() => { // outro card aprovado integralmente: o aprovado é o próprio orçamento
    const c = db.prepare('SELECT * FROM kb_cards WHERE fase_id = 2 ORDER BY id LIMIT 1').get();
    mover(db, c.id, F.ORCAMENTO, { pecas: PECAS });
    const orc = pdfFalso(db, c.id);
    mover(db, c.id, F.APROVACAO, { pdfMidiaId: orc });
    mover(db, c.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'integral' });
    return { id: c.id, orc };
  })();
  const app = express();
  app.use(express.json());
  app.use('/api/kanban', criarRouter({ db, log: () => {}, criarCliente: () => null }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api/kanban`;
  const json = (metodo, url, corpo) => fetch(`${base}${url}`, { method: metodo, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
  try {
    let est = await (await fetch(`${base}/estado`)).json();
    let resumo = est.cards.find((x) => x.id === card.id);
    assert.equal(resumo.pecas.length, 3);
    assert.equal(resumo.pecas[0].situacao, 'a_definir');
    assert.match(resumo.orcamento.aprovado_url, new RegExp(`/midias/${via}/abrir$`));
    assert.match(est.cards.find((x) => x.id === integral.id).orcamento.aprovado_url, new RegExp(`/midias/${integral.orc}/abrir$`));
    // nome do arquivo: orcamento-aprovado-cliente-os<N>-<id>.pdf (só a legenda; a rota exige o bucket)
    db.prepare('UPDATE kb_midias SET legenda = ? WHERE id = ?').run(`orcamento-aprovado-cliente-os${card.os_numero}-${via}.pdf`, via);

    const ids = resumo.pecas.map((p) => p.id);
    let r = await json('PUT', `/cards/${card.id}/pecas`, { operador: 'Cauã', itens: [{ id: ids[0], situacao: 'pedir' }, { id: ids[1], situacao: 'pedir' }, { id: ids[2], situacao: 'estoque' }] });
    assert.equal(r.status, 200);
    const out = await r.json();
    assert.equal(out.alteradas, 3);
    assert.equal(out.card.pecas.filter((p) => p.situacao === 'pedir').length, 2);
    const det = await (await fetch(`${base}/cards/${card.id}`)).json();
    assert.equal(det.card.pecas.length, 3);
    assert.match(det.orcamentos[0].aprovado_url, new RegExp(`/midias/${via}/abrir$`));

    r = await json('POST', '/pecas/pedidas', { operador: 'Cauã', ids: [ids[0]] });
    assert.equal(r.status, 200);
    est = await (await fetch(`${base}/estado`)).json();
    resumo = est.cards.find((x) => x.id === card.id);
    assert.deepEqual(resumo.pecas.map((p) => p.situacao), ['pedido', 'pedir', 'estoque']);
    r = await json('POST', '/pecas/pedidas', { operador: 'Cauã', ids: [] });
    assert.equal(r.status, 400);
  } finally {
    srv.close();
  }
});

test('card que pula o Orçamento (Aquisição → Aprovação direto) não perde as peças', () => {
  const db = banco();
  const { card } = aprovado(db, 'parcial');
  // volta direto para a Aprovação (movimentação total), sem passar pelo Orçamento, e é aprovado de novo
  mover(db, card.id, F.APROVACAO, { pdfMidiaId: pdfFalso(db, card.id) });
  const orc = db.prepare('SELECT * FROM kb_orcamentos WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(card.id);
  assert.deepEqual(JSON.parse(orc.pecas).map((p) => p.descricao), PECAS.map((p) => p.descricao), 'a solicitação nova herda as peças');
  mover(db, card.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'integral' });
  assert.deepEqual(pecas.listar(db, card.id).map((p) => [p.descricao, p.situacao]), PECAS.map((p) => [p.descricao, 'a_definir']));
  // solicitação antiga já vazia (como as criadas antes da correção): a aprovação busca a última com peças
  db.prepare("UPDATE kb_orcamentos SET pecas = '[]' WHERE id = (SELECT MAX(id) FROM kb_orcamentos WHERE card_id = ?)").run(card.id);
  db.prepare('UPDATE kb_pecas SET removido_em = ? WHERE card_id = ?').run(AGORA, card.id);
  assert.equal(pecas.semearDaAprovacao(db, card, db.prepare('SELECT * FROM kb_orcamentos WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(card.id), { op: 'T', agora: AGORA }), 3);
  assert.equal(JSON.parse(acoes.ultimasPecas(db, card.id)).length, 3);
  // peça trazida na janela de separação guarda a origem "orcamento"
  const r = pecas.salvar(db, card.id, { operador: 'Cauã', itens: [...pecas.listar(db, card.id).map((p) => ({ id: p.id, situacao: 'pedir' })), { descricao: 'Bucha', situacao: 'estoque', origem: 'orcamento' }] }, { agora: AGORA });
  assert.equal(r.pecas.at(-1).origem, 'orcamento');
  assert.doesNotMatch(ultimoEvento(db, card.id).texto, /Bucha \(incluída\)/);
});
