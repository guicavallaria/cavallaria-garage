const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { bancoDeTeste } = require('./helpers/db');
const nov = require('./helpers/novidades');
const { aplicarLeitura } = require('../kanban/sync');
const mec = require('../kanban/mecanicos');
const acoes = require('../kanban/acoes');
const { criarRouter } = require('../kanban/routes');

// bancoDeTeste: a agenda tem "Luiz Paulo", "Iago" e "Edson" (sem Matheus/Ronaldy).
function banco() {
  const db = bancoDeTeste();
  db.transaction(() => aplicarLeitura(db, nov.linhas(), { agora: '2026-10-23T12:00:00.000Z', primeiraCarga: true }))();
  return db;
}

test('lista inicial: Edson, Matheus, Ronaldy, Luiz e Iago, ligados à agenda pelo primeiro nome quando existe', () => {
  const db = banco();
  const lista = mec.listar(db);
  assert.deepEqual(lista.map((m) => m.nome), ['Edson', 'Matheus', 'Ronaldy', 'Luiz', 'Iago']);
  const agenda = Object.fromEntries(lista.map((m) => [m.nome, m.agenda_nome]));
  assert.deepEqual(agenda, { Edson: 'Edson', Matheus: null, Ronaldy: null, Luiz: 'Luiz Paulo', Iago: 'Iago' });
});

test('adicionar e remover; nome repetido é recusado; removido sai das listas mas fica registrado', () => {
  const db = banco();
  const caio = mec.adicionar(db, { nome: '  Caio  ', operador: 'Gerência' });
  assert.equal(caio.nome, 'Caio');
  assert.throws(() => mec.adicionar(db, { nome: 'caio', operador: 'Gerência' }), (e) => e.status === 409);
  assert.throws(() => mec.adicionar(db, { nome: 'x', operador: 'Gerência' }), (e) => e.status === 400);
  mec.remover(db, caio.id, { operador: 'Gerência' });
  assert.ok(!mec.listar(db).some((m) => m.nome === 'Caio'));
  const todos = mec.listar(db, { incluirRemovidos: true });
  assert.equal(todos.find((m) => m.nome === 'Caio').removido_por, 'Gerência');
  // pode voltar depois
  assert.equal(mec.adicionar(db, { nome: 'Caio', operador: 'Gerência' }).nome, 'Caio');
});

test('o card usa a lista do kanban: escolha manual, ou o mecânico do pátio traduzido pelo vínculo com a agenda', async () => {
  const db = banco();
  const c = db.prepare('SELECT * FROM kb_cards ORDER BY id LIMIT 1').get();
  // o pátio diz que o carro está com o "Edson" da agenda
  const agendaEdson = db.prepare("SELECT id FROM mecanicos WHERE nome = 'Edson'").get().id;
  db.prepare(`INSERT INTO patio_vehicles (placa_normalizada, placa_exibicao, mecanico_id, status, first_seen_at, last_seen_at)
              VALUES (?, ?, ?, 'ativo', 'x', 'x')`).run(c.placa_normalizada, c.placa, agendaEdson);

  const app = express();
  app.use(express.json());
  app.use('/api/kanban', criarRouter({ db, log: () => {}, criarCliente: () => null }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api/kanban`;
  const estado = async () => (await (await fetch(`${base}/estado`)).json());
  try {
    let e = await estado();
    assert.deepEqual(e.mecanicos.map((m) => m.nome), ['Edson', 'Matheus', 'Ronaldy', 'Luiz', 'Iago']);
    let card = e.cards.find((x) => x.id === c.id);
    assert.equal(card.mecanico_nome, 'Edson');
    assert.equal(card.mecanico_do_card, false, 'veio do painel de pátio');

    const ronaldy = e.mecanicos.find((m) => m.nome === 'Ronaldy').id;
    acoes.definirMecanico(db, c.id, { mecanicoId: ronaldy, operador: 'Vanilton' });
    card = (await estado()).cards.find((x) => x.id === c.id);
    assert.equal(card.mecanico_nome, 'Ronaldy');
    assert.equal(card.mecanico_do_card, true);

    // Gerência remove o Ronaldy da lista: some da lista e do filtro
    const r = await fetch(`${base}/admin/mecanicos/${ronaldy}/remover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operador: 'Gerência' }) });
    assert.equal(r.status, 200);
    assert.ok(!(await estado()).mecanicos.some((m) => m.nome === 'Ronaldy'));
    assert.throws(() => acoes.definirMecanico(db, c.id, { mecanicoId: ronaldy, operador: 'Vanilton' }), (x) => x.status === 400);

    // adicionar pela rota de administração
    const novo = await fetch(`${base}/admin/mecanicos`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome: 'Ronaldy', operador: 'Gerência' }) });
    assert.equal(novo.status, 200);
    assert.ok((await estado()).mecanicos.some((m) => m.nome === 'Ronaldy'));
  } finally {
    srv.close();
  }
});

test('lista de nomes do aparelho: mecânicos do kanban primeiro, sem repetir o nome completo do mesmo mecânico', () => {
  const db = banco();
  const c = db.prepare('SELECT * FROM kb_cards ORDER BY id LIMIT 1').get();
  acoes.moverCard(db, c.id, { faseId: 3, operador: 'Edson Antonio Benin Junior' });
  acoes.moverCard(db, c.id, { faseId: 4, operador: 'Luan' });
  const ops = acoes.operadoresConhecidos(db);
  assert.deepEqual(ops.slice(0, 5), ['Edson', 'Matheus', 'Ronaldy', 'Luiz', 'Iago']);
  assert.ok(ops.includes('Luan'));
  assert.ok(!ops.includes('Edson Antonio Benin Junior'));
});
