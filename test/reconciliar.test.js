const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bancoDeTeste, osLida } = require('./helpers/db');
const { aplicarSync, agruparPorVeiculo } = require('../patio/reconciliar');

const ativos = (db) => db.prepare("SELECT * FROM patio_vehicles WHERE status='ativo' ORDER BY placa_normalizada").all();
const todos = (db) => db.prepare('SELECT * FROM patio_vehicles ORDER BY id').all();
const ordens = (db, vid) => db.prepare('SELECT * FROM patio_vehicle_orders WHERE vehicle_id = ? ORDER BY os_number').all(vid);

test('agruparPorVeiculo: duas OS da mesma placa viram um veículo; dados vêm da OS mais recente', () => {
  const g = agruparPorVeiculo([
    osLida({ osNumber: 7001, placa: 'ABC1234', modelo: 'GOL antigo' }),
    osLida({ osNumber: 7050, placa: 'ABC1234', modelo: 'GOL 1.6' }),
    osLida({ osNumber: 7002, placa: 'XYZ9A87' }),
  ]);
  assert.equal(g.size, 2);
  assert.equal(g.get('ABC1234').os.length, 2);
  assert.equal(g.get('ABC1234').modelo, 'GOL 1.6');
  assert.equal(g.get('ABC1234').placaExibicao, 'ABC-1234');
});

test('1º sync: veículo novo entra sem responsável, com suas OS vinculadas', () => {
  const db = bancoDeTeste();
  const r = aplicarSync(db, [osLida({ osNumber: 7001, placa: 'ABC1234' }), osLida({ osNumber: 7002, placa: 'ABC1234' }), osLida({ osNumber: 7003, placa: 'XYZ9A87' })], { agora: 'T1' });
  assert.deepEqual({ novos: r.novos, mantidos: r.mantidos, finalizados: r.finalizados, os_lidas: r.os_lidas }, { novos: 2, mantidos: 0, finalizados: 0, os_lidas: 3 });
  const a = ativos(db);
  assert.equal(a.length, 2);
  assert.equal(a[0].mecanico_id, null);
  assert.equal(a[0].origem_atribuicao, 'manual');
  assert.equal(a[0].first_seen_at, 'T1');
  assert.equal(ordens(db, a[0].id).map((o) => o.os_number).join(','), '7001,7002');
});

test('dedup: mesma placa em 2 OS = 1 card; 1 OS finaliza → card fica; as 2 finalizam → card sai', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [osLida({ osNumber: 7001, placa: 'ABC1234' }), osLida({ osNumber: 7002, placa: 'ABC1234' })], { agora: 'T1' });
  assert.equal(ativos(db).length, 1);

  // só a 7001 some
  let r = aplicarSync(db, [osLida({ osNumber: 7002, placa: 'ABC1234' })], { agora: 'T2' });
  assert.equal(r.mantidos, 1);
  assert.equal(r.finalizados, 0);
  assert.equal(ativos(db).length, 1, 'veículo permanece enquanto houver OS em execução');
  const o = ordens(db, ativos(db)[0].id);
  assert.equal(o.find((x) => x.os_number === '7001').finished_at, 'T2');
  assert.equal(o.find((x) => x.os_number === '7002').finished_at, null);

  // a 7002 também some
  r = aplicarSync(db, [], { agora: 'T3' });
  assert.equal(r.finalizados, 1);
  assert.equal(ativos(db).length, 0);
  const hist = todos(db);
  assert.equal(hist.length, 1, 'registro não é apagado');
  assert.equal(hist[0].status, 'finalizado');
  assert.equal(hist[0].finished_at, 'T3');
});

test('veículo conhecido mantém o mecânico e a origem; dados descritivos são atualizados', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [osLida({ osNumber: 7001, placa: 'ABC1234', modelo: 'GOL', proprietario: 'Ana' })], { agora: 'T1' });
  db.prepare("UPDATE patio_vehicles SET mecanico_id = 2, origem_atribuicao = 'manual' WHERE placa_normalizada = 'ABC1234'").run();
  const r = aplicarSync(db, [osLida({ osNumber: 7001, placa: 'ABC1234', modelo: 'GOL 1.6', proprietario: 'Ana Maria' })], { agora: 'T2' });
  assert.equal(r.mantidos, 1);
  const v = ativos(db)[0];
  assert.equal(v.mecanico_id, 2);
  assert.equal(v.modelo, 'GOL 1.6');
  assert.equal(v.proprietario, 'Ana Maria');
  assert.equal(v.last_seen_at, 'T2');
  assert.equal(v.first_seen_at, 'T1');
});

test('veículo que sai e volta (nova OS) vira registro novo; o histórico anterior é preservado', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [osLida({ osNumber: 7001, placa: 'ABC1234' })], { agora: 'T1' });
  aplicarSync(db, [], { agora: 'T2' });
  const r = aplicarSync(db, [osLida({ osNumber: 7100, placa: 'ABC1234' })], { agora: 'T3' });
  assert.equal(r.novos, 1);
  const hist = todos(db);
  assert.equal(hist.length, 2);
  assert.deepEqual(hist.map((v) => v.status), ['finalizado', 'ativo']);
  assert.equal(ativos(db)[0].mecanico_id, null, 'nova entrada começa sem responsável');
});

test('OS sem placa válida não some: entra com chave sintética e gera aviso', () => {
  const db = bancoDeTeste();
  const r = aplicarSync(db, [osLida({ osNumber: 7009, placa: null })], { agora: 'T1' });
  assert.equal(r.novos, 1);
  assert.equal(ativos(db)[0].placa_normalizada, 'OS7009');
  assert.match(r.avisos[0], /sem placa/);
});

test('uma leitura nunca cria duas linhas ativas da mesma placa (índice único + agrupamento)', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [osLida({ osNumber: 1, placa: 'AAA1A11' }), osLida({ osNumber: 2, placa: 'aaa-1a11' })], { agora: 'T1' });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM patio_vehicles WHERE status='ativo' AND placa_normalizada='AAA1A11'").get().n, 1);
});
