// "SERVIÇO URGENTE" no card (pedido do Guilherme em 12/11/2026).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { bancoDeTeste } = require('./helpers/db');
const nov = require('./helpers/novidades');
const { aplicarLeitura } = require('../kanban/sync');
const acoes = require('../kanban/acoes');
const linhaTempo = require('../kanban/linha-tempo');
const { criarRouter } = require('../kanban/routes');

const AGORA = '2026-11-12T12:00:00.000Z';

function banco() {
  const db = bancoDeTeste();
  db.transaction(() => aplicarLeitura(db, nov.linhas(), { agora: '2026-11-10T12:00:00.000Z', primeiraCarga: true }))();
  return db;
}
const ultimoEvento = (db, id) => db.prepare('SELECT * FROM kb_eventos WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(id);

test('urgente: liga e desliga com registro na linha do tempo (automático, não se edita)', () => {
  const db = banco();
  const c = db.prepare('SELECT * FROM kb_cards ORDER BY id LIMIT 1').get();
  assert.throws(() => acoes.definirUrgente(db, c.id, { urgente: true, operador: '' }), /operador/);
  let r = acoes.definirUrgente(db, c.id, { urgente: true, operador: 'Luan' }, { agora: AGORA });
  assert.equal(r.mudou, true);
  assert.equal(r.card.urgente_em, AGORA);
  assert.equal(r.card.urgente_por, 'Luan');
  const ev = ultimoEvento(db, c.id);
  assert.equal(ev.texto, '🚨 Marcado como SERVIÇO URGENTE.');
  assert.equal(ev.operador_nome, 'Luan');
  assert.throws(() => linhaTempo.removerRegistro(db, ev.id, { operador: 'Luan' }), /automáticos/);
  // ligar de novo: nada muda, nada registra
  assert.equal(acoes.definirUrgente(db, c.id, { urgente: true, operador: 'Luan' }).mudou, false);
  assert.equal(ultimoEvento(db, c.id).id, ev.id);
  r = acoes.definirUrgente(db, c.id, { urgente: false, operador: 'Cauã' }, { agora: AGORA });
  assert.equal(r.card.urgente_em, null);
  assert.equal(r.card.urgente_por, null);
  assert.match(ultimoEvento(db, c.id).texto, /^Urgência desativada/);
  // arquivado não liga
  acoes.arquivarCard(db, c.id, { operador: 'Cauã' }, { agora: AGORA });
  assert.throws(() => acoes.definirUrgente(db, c.id, { urgente: true, operador: 'Cauã' }), (e) => e.status === 409);
});

test('urgente: rota e ordem do quadro (urgentes no topo, o último marcado primeiro; desligar volta à ordem do sistema)', async () => {
  const db = banco();
  const app = express();
  app.use(express.json());
  app.use('/api/kanban', criarRouter({ db, log: () => {}, criarCliente: () => null }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api/kanban`;
  const urg = (id, urgente) => fetch(`${base}/cards/${id}/urgente`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urgente, operador: 'Luan' }) });
  try {
    const ordem = async () => (await (await fetch(`${base}/estado`)).json()).cards.map((c) => c.id);
    const antes = await ordem();
    assert.ok(antes.length >= 3);
    const [, b, c] = antes;
    let res = await urg(c, true);
    assert.equal(res.status, 200);
    const corpo = await res.json();
    assert.equal(corpo.card.urgente_por, 'Luan');
    assert.ok(corpo.card.urgente_em);
    db.prepare("UPDATE kb_cards SET urgente_em = '2026-11-12T11:00:00.000Z' WHERE id = ?").run(c); // c marcado antes de b
    await urg(b, true);
    let depois = await ordem();
    assert.deepEqual(depois.slice(0, 2), [b, c]);
    assert.deepEqual(depois.slice(2), antes.filter((id) => id !== b && id !== c));
    await urg(b, false);
    await urg(c, false);
    assert.deepEqual(await ordem(), antes);
    res = await urg(999999, true);
    assert.equal(res.status, 404);
  } finally {
    srv.close();
  }
});

test('estado: o km do card é o registrado no check-in de entrada (o da OS do Onmotor fica em km_onmotor)', async () => {
  const chk = require('../kanban/checklists');
  const db = banco();
  const c = db.prepare('SELECT id FROM kb_cards ORDER BY id LIMIT 1').get();
  db.prepare("UPDATE kb_cards SET km = '96361' WHERE id = ?").run(c.id);
  const app = express();
  app.use(express.json());
  app.use('/api/kanban', criarRouter({ db, log: () => {}, criarCliente: () => null }));
  const srv = app.listen(0);
  const doCard = async () => (await (await fetch(`http://127.0.0.1:${srv.address().port}/api/kanban/estado`)).json()).cards.find((x) => x.id === c.id);
  try {
    let card = await doCard();
    assert.equal(card.km, null, 'sem check-in: sem km no card');
    assert.equal(card.km_onmotor, '96361');
    const exec = chk.iniciar(db, c.id, 'entrada', { feitoPor: 'Edson', operador: 'Luan' }, { agora: AGORA });
    const itens = chk.itensDoModelo(chk.modeloAtivo(db, 'entrada'));
    const itemKm = itens.find((i) => (i.componentes || []).some((x) => x.rotulo === 'KM')) || itens[0];
    chk.responder(db, exec.execucao ? exec.execucao.id : exec.id, itemKm.id, { valor: { medidas: { KM: '97.012' } }, operador: 'Edson' }, { agora: AGORA });
    card = await doCard();
    assert.equal(Number(card.km), 97012, 'vale o km digitado no check-in, mesmo com a vistoria em andamento');
    const det = await (await fetch(`http://127.0.0.1:${srv.address().port}/api/kanban/cards/${c.id}`)).json();
    assert.equal(Number(det.card.km), 97012);
    assert.equal(det.card.km_onmotor, '96361');
  } finally {
    srv.close();
  }
});
