const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { bancoDeTeste } = require('./helpers/db');
const nov = require('./helpers/novidades');
const { aplicarLeitura } = require('../kanban/sync');
const acoes = require('../kanban/acoes');
const { criarRouter } = require('../kanban/routes');

const AGORA = '2026-10-23T15:00:00.000Z'; // 12:00 em SP

function bancoComCards() {
  const db = bancoDeTeste();
  db.transaction(() => aplicarLeitura(db, nov.linhas(), { agora: '2026-10-23T12:00:00.000Z', primeiraCarga: true }))();
  return db;
}
const card = (db, os) => db.prepare('SELECT * FROM kb_cards WHERE os_numero = ?').get(String(os));
const ultimoEvento = (db, id) => db.prepare('SELECT * FROM kb_eventos WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(id);
const LINHAS = nov.linhas();
const OS = LINHAS.find((l) => !l.etapas.finalizado && l.etapas.entrada && !l.etapas.emExecucao).osNumber; // fase 2

test('mover: muda a fase, zera o tempo na fase e registra "Movido de X para Y por <operador> em …"', () => {
  const db = bancoComCards();
  const c = card(db, OS);
  const r = acoes.moverCard(db, c.id, { faseId: 4, faseAtual: 2, operador: '  Vanilton  ' }, { agora: AGORA });
  assert.equal(r.movido, true);
  const depois = card(db, OS);
  assert.equal(depois.fase_id, 4);
  assert.equal(depois.fase_desde, AGORA);
  const ev = ultimoEvento(db, c.id);
  assert.equal(ev.tipo, 'fase');
  assert.equal(ev.operador_nome, 'Vanilton');
  assert.equal(ev.texto, 'Movido de Avaliação/Diagnóstico para Aprovação de Orçamento por Vanilton em 23/10/2026 12:00');
  assert.deepEqual(JSON.parse(ev.dados), { de: 2, para: 4 });
});

test('mover para a mesma fase não gera registro', () => {
  const db = bancoComCards();
  const c = card(db, OS);
  const antes = db.prepare('SELECT COUNT(*) AS n FROM kb_eventos').get().n;
  assert.equal(acoes.moverCard(db, c.id, { faseId: 2, operador: 'Luan' }).movido, false);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kb_eventos').get().n, antes);
});

test('mover com a tela desatualizada (outra pessoa já moveu) devolve 409 e não sobrescreve', () => {
  const db = bancoComCards();
  const c = card(db, OS);
  acoes.moverCard(db, c.id, { faseId: 3, faseAtual: 2, operador: 'Luan' });
  assert.throws(() => acoes.moverCard(db, c.id, { faseId: 7, faseAtual: 2, operador: 'Edson' }),
    (e) => e.status === 409 && /já foi movido para "Orçamento"/.test(e.message));
  assert.equal(card(db, OS).fase_id, 3);
});

test('validações: operador obrigatório, fase inválida, card inexistente', () => {
  const db = bancoComCards();
  const c = card(db, OS);
  assert.throws(() => acoes.moverCard(db, c.id, { faseId: 3, operador: '   ' }), (e) => e.status === 400);
  assert.throws(() => acoes.moverCard(db, c.id, { faseId: 3, operador: 'Sistema' }), (e) => e.status === 400);
  assert.throws(() => acoes.moverCard(db, c.id, { faseId: 10, operador: 'Luan' }), (e) => e.status === 400);
  assert.throws(() => acoes.moverCard(db, 99999, { faseId: 3, operador: 'Luan' }), (e) => e.status === 404);
});

test('mover para a fase 9 com a OS já finalizada no Onmotor arquiva na hora', () => {
  const db = bancoComCards();
  const c = card(db, OS);
  db.prepare("UPDATE kb_cards SET os_finalizada_em = '2026-10-23T13:30:00.000Z' WHERE id = ?").run(c.id);
  const r = acoes.moverCard(db, c.id, { faseId: 9, operador: 'Pátio' }, { agora: AGORA });
  assert.equal(r.arquivado, true);
  const depois = card(db, OS);
  assert.equal(depois.arquivado_motivo, 'automatico');
  assert.equal(ultimoEvento(db, c.id).texto, 'Arquivado automaticamente — OS finalizada no Onmotor em 23/10/2026 10:30');
});

test('arquivar e desarquivar: registram quem e quando, e o card volta para a fase em que estava', () => {
  const db = bancoComCards();
  const c = card(db, OS);
  acoes.moverCard(db, c.id, { faseId: 5, operador: 'Compras' });
  acoes.arquivarCard(db, c.id, { operador: 'Gerência' }, { agora: AGORA });
  let x = card(db, OS);
  assert.equal(x.arquivado_em, AGORA);
  assert.equal(x.arquivado_por, 'Gerência');
  assert.equal(x.arquivado_motivo, 'manual');
  assert.equal(ultimoEvento(db, c.id).texto, 'Arquivado por Gerência em 23/10/2026 12:00 (fase: Aquisição de Peças)');
  assert.throws(() => acoes.arquivarCard(db, c.id, { operador: 'Gerência' }), (e) => e.status === 409);
  assert.throws(() => acoes.moverCard(db, c.id, { faseId: 6, operador: 'Luan' }), (e) => e.status === 409);

  acoes.desarquivarCard(db, c.id, { operador: 'Recepção' }, { agora: AGORA });
  x = card(db, OS);
  assert.equal(x.arquivado_em, null);
  assert.equal(x.fase_id, 5);
  assert.equal(x.auto_arquivar_bloqueado, 1);
  assert.equal(ultimoEvento(db, c.id).texto, 'Desarquivado por Recepção em 23/10/2026 12:00 — voltou para Aquisição de Peças');
  assert.throws(() => acoes.desarquivarCard(db, c.id, { operador: 'Recepção' }), (e) => e.status === 409);
});

test('desarquivar um card que o sistema arquivou não deixa o sync arquivar de novo; mover libera a regra', () => {
  const db = bancoComCards();
  const { arquivarFinalizadosNaFase9 } = require('../kanban/sync');
  const c = card(db, OS);
  db.prepare("UPDATE kb_cards SET os_finalizada_em = ?, fase_id = 9 WHERE id = ?").run(AGORA, c.id);
  assert.equal(arquivarFinalizadosNaFase9(db, AGORA), 1);
  acoes.desarquivarCard(db, c.id, { operador: 'Gerência' });
  assert.equal(arquivarFinalizadosNaFase9(db, AGORA), 0);
  acoes.moverCard(db, c.id, { faseId: 8, operador: 'Pátio' });
  assert.equal(acoes.moverCard(db, c.id, { faseId: 9, operador: 'Pátio' }).arquivado, true);
});

test('mecânico do card: troca manual e volta para o do pátio', () => {
  const db = bancoComCards();
  const c = card(db, OS);
  const edson = db.prepare("SELECT id FROM mecanicos WHERE nome = 'Edson'").get().id;
  assert.equal(acoes.definirMecanico(db, c.id, { mecanicoId: edson, operador: 'Vanilton' }).mecanico_id, edson);
  assert.equal(acoes.definirMecanico(db, c.id, { mecanicoId: null, operador: 'Vanilton' }).mecanico_id, null);
  assert.throws(() => acoes.definirMecanico(db, c.id, { mecanicoId: 999, operador: 'Vanilton' }), (e) => e.status === 400);
});

test('busca: número da OS, placa com ou sem hífen, modelo, cliente sem acento e chassi', () => {
  const db = bancoComCards();
  const l = LINHAS.find((x) => x.osNumber === OS);
  const c = card(db, OS);
  db.prepare("UPDATE kb_cards SET chassi = 'WBAGL61002DM57925', cliente_nome = 'José Antônio da Silva' WHERE id = ?").run(c.id);

  assert.equal(acoes.buscar(db, { q: OS })[0].os_numero, OS, 'OS exata vem primeiro');
  const placa = l.placa;
  const comHifen = placa.slice(0, 3) + '-' + placa.slice(3);
  assert.ok(acoes.buscar(db, { q: comHifen.toLowerCase() }).some((x) => x.id === c.id));
  assert.ok(acoes.buscar(db, { q: 'jose antonio' }).some((x) => x.id === c.id));
  assert.ok(acoes.buscar(db, { q: 'dm57925' }).some((x) => x.id === c.id));
  assert.ok(acoes.buscar(db, { q: l.modelo.split(' ')[0] }).length > 0);
  assert.deepEqual(acoes.buscar(db, { q: 'zzzzzz' }), []);
  assert.deepEqual(acoes.buscar(db, { q: '' }), [], 'ativos sem termo não lista nada');
});

test('busca separa ativos e arquivados; arquivados do mais recente para o mais antigo', () => {
  const db = bancoComCards();
  const [a, b] = db.prepare('SELECT * FROM kb_cards ORDER BY id LIMIT 2').all();
  acoes.arquivarCard(db, a.id, { operador: 'Luan' }, { agora: '2026-10-20T12:00:00.000Z' });
  acoes.arquivarCard(db, b.id, { operador: 'Luan' }, { agora: '2026-10-22T12:00:00.000Z' });
  const arq = acoes.buscar(db, { modo: 'arquivados' });
  assert.deepEqual(arq.map((x) => x.id), [b.id, a.id]);
  assert.ok(!acoes.buscar(db, { q: a.os_numero }).some((x) => x.id === a.id), 'arquivado não aparece em ativos');
  assert.ok(acoes.buscar(db, { q: a.os_numero, modo: 'arquivados' }).some((x) => x.id === a.id));
});

test('operadores conhecidos: mecânicos ativos + quem já registrou algo, sem repetir', () => {
  const db = bancoComCards();
  const c = card(db, OS);
  acoes.moverCard(db, c.id, { faseId: 3, operador: 'Luan' });
  acoes.moverCard(db, c.id, { faseId: 4, operador: 'luan' });
  const ops = acoes.operadoresConhecidos(db);
  assert.ok(ops.includes('Edson'));
  assert.equal(ops.filter((n) => n.toLowerCase() === 'luan').length, 1);
  assert.ok(!ops.includes('Sistema'));
});

test('rotas HTTP: status certos e broadcast só quando algo muda', async () => {
  const db = bancoComCards();
  const eventos = [];
  const app = express();
  app.use(express.json());
  app.use('/api/kanban', criarRouter({ db, broadcast: (e) => eventos.push(e), log: () => {}, criarCliente: () => null }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api/kanban`;
  const post = (p, body) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    const c = card(db, OS);
    let r = await post(`/cards/${c.id}/mover`, { fase_id: 3, fase_atual: 2, operador: 'Luan' });
    assert.equal(r.status, 200);
    const corpo = await r.json();
    assert.equal(corpo.card.fase_id, 3);
    assert.equal(corpo.card.fase_nome, 'Orçamento');
    assert.deepEqual(eventos, ['kanban']);

    r = await post(`/cards/${c.id}/mover`, { fase_id: 5, fase_atual: 2, operador: 'Luan' });
    assert.equal(r.status, 409);
    r = await post(`/cards/${c.id}/mover`, { fase_id: 5 });
    assert.equal(r.status, 400);
    assert.equal((await r.json()).erro, 'Informe o nome do operador');

    r = await post(`/cards/${c.id}/arquivar`, { operador: 'Gerência' });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/busca?modo=arquivados`);
    const busca = await r.json();
    assert.equal(busca.total, 1);
    assert.equal(busca.cards[0].arquivado_por, 'Gerência');

    r = await post(`/cards/${c.id}/desarquivar`, { operador: 'Gerência' });
    assert.equal((await r.json()).card.fase_id, 3);
    assert.equal((await (await fetch(`${base}/busca?q=${OS}`)).json()).cards[0].id, c.id);
  } finally {
    srv.close();
  }
});
