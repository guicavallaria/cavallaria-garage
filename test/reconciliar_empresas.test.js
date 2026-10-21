const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bancoDeTeste, osLida } = require('./helpers/db');
const { aplicarSync } = require('../patio/reconciliar');

const ativos = (db) => db.prepare("SELECT * FROM patio_vehicles WHERE status='ativo' ORDER BY placa_normalizada").all();
const ordens = (db, vid) => db.prepare('SELECT * FROM patio_vehicle_orders WHERE vehicle_id = ? ORDER BY os_number').all(vid);
const cav = (o) => ({ ...osLida(o), empresa: 'cavallaria' });
const awd = (o) => ({ ...osLida(o), empresa: 'awdyna' });

test('OS das duas empresas entram no mesmo pátio e contam no mesmo total', () => {
  const db = bancoDeTeste();
  const r = aplicarSync(db, [cav({ osNumber: 7001, placa: 'ABC1234' }), awd({ osNumber: 650, placa: 'XYZ9A87' })], { agora: 'T1', empresasLidas: ['cavallaria', 'awdyna'] });
  assert.equal(r.novos, 2);
  const a = ativos(db);
  assert.equal(a.length, 2);
  assert.deepEqual(ordens(db, a[1].id).map((o) => o.empresa), ['awdyna']);
});

test('mesma placa nas duas empresas = um único card com as duas OS', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [cav({ osNumber: 7001, placa: 'ABC1234' }), awd({ osNumber: 650, placa: 'abc-1234' })], { agora: 'T1', empresasLidas: ['cavallaria', 'awdyna'] });
  const a = ativos(db);
  assert.equal(a.length, 1);
  assert.deepEqual(ordens(db, a[0].id).map((o) => `${o.empresa}:${o.os_number}`), ['awdyna:650', 'cavallaria:7001']);
});

test('fonte que falhou na rodada: seus veículos e OS ficam intactos (não são finalizados)', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [cav({ osNumber: 7001, placa: 'ABC1234' }), awd({ osNumber: 650, placa: 'XYZ9A87' })], { agora: 'T1', empresasLidas: ['cavallaria', 'awdyna'] });

  // rodada 2: só a Cavallaria foi lida, e a 7001 sumiu de lá
  const r = aplicarSync(db, [], { agora: 'T2', empresasLidas: ['cavallaria'] });
  assert.equal(r.finalizados, 1, 'só o veículo da Cavallaria finaliza');
  const a = ativos(db);
  assert.deepEqual(a.map((v) => v.placa_normalizada), ['XYZ9A87']);
  assert.equal(ordens(db, a[0].id)[0].finished_at, null);
  assert.equal(r.avisos.length, 1);
  assert.match(r.avisos[0], /fonte não lida/);
});

test('veículo com OS nas duas empresas só sai quando as duas forem lidas e ambas sumirem', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [cav({ osNumber: 7001, placa: 'ABC1234' }), awd({ osNumber: 650, placa: 'ABC1234' })], { agora: 'T1', empresasLidas: ['cavallaria', 'awdyna'] });

  // só Cavallaria lida e sem a 7001: a OS da Cavallaria finaliza, o card fica (AWDYNA não foi lida)
  let r = aplicarSync(db, [], { agora: 'T2', empresasLidas: ['cavallaria'] });
  assert.equal(r.finalizados, 0);
  assert.equal(ativos(db).length, 1);
  let o = ordens(db, ativos(db)[0].id);
  assert.equal(o.find((x) => x.empresa === 'cavallaria').finished_at, 'T2');
  assert.equal(o.find((x) => x.empresa === 'awdyna').finished_at, null);

  // as duas lidas, nenhuma OS: agora sai
  r = aplicarSync(db, [], { agora: 'T3', empresasLidas: ['cavallaria', 'awdyna'] });
  assert.equal(r.finalizados, 1);
  assert.equal(ativos(db).length, 0);
});

test('compatibilidade: lista sem empresa é tratada como cavallaria', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [osLida({ osNumber: 7001, placa: 'ABC1234' })], { agora: 'T1' });
  assert.equal(ordens(db, ativos(db)[0].id)[0].empresa, 'cavallaria');
  const r = aplicarSync(db, [], { agora: 'T2' });
  assert.equal(r.finalizados, 1);
});
