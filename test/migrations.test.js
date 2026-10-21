const { test } = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { aplicar, reverter } = require('../migrations');

function bancoBase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE mecanicos (id INTEGER PRIMARY KEY, nome TEXT NOT NULL UNIQUE, cor TEXT, ativo INTEGER DEFAULT 1, ordem INTEGER DEFAULT 0);
    CREATE TABLE agendamentos (id INTEGER PRIMARY KEY, mecanico_id INTEGER, veiculo TEXT, data TEXT);
  `);
  return db;
}
const tabelas = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map((r) => r.name);
const colunas = (db, t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

test('up cria as tabelas do pátio, a coluna atualizado_em e é idempotente', () => {
  const db = bancoBase();
  assert.deepEqual(aplicar(db), ['001_patio.js', '002_patio_empresa.js']);
  const t = tabelas(db);
  for (const esperada of ['patio_vehicles', 'patio_vehicle_orders', 'patio_sync_log', 'patio_sync_lock', 'schema_migrations']) {
    assert.ok(t.includes(esperada), `faltou ${esperada}`);
  }
  assert.ok(colunas(db, 'agendamentos').includes('atualizado_em'));
  assert.ok(colunas(db, 'patio_vehicle_orders').includes('empresa'));
  assert.deepEqual(aplicar(db), []); // segunda vez não reaplica
});

test('índice único parcial: a mesma placa não pode estar ativa duas vezes, mas pode após finalizar', () => {
  const db = bancoBase();
  aplicar(db);
  const ins = db.prepare(`INSERT INTO patio_vehicles (placa_normalizada, placa_exibicao, status, first_seen_at, last_seen_at)
                          VALUES (?, ?, ?, 'x', 'x')`);
  ins.run('ABC1D23', 'ABC1D23', 'ativo');
  assert.throws(() => ins.run('ABC1D23', 'ABC1D23', 'ativo'), /UNIQUE/);
  db.prepare("UPDATE patio_vehicles SET status='finalizado', finished_at='x' WHERE placa_normalizada='ABC1D23'").run();
  ins.run('ABC1D23', 'ABC1D23', 'ativo'); // histórico preservado + nova entrada ativa
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM patio_vehicles').get().n, 2);
});

test('orders: única por (veículo, OS) e apagada em cascata com o veículo', () => {
  const db = bancoBase();
  aplicar(db);
  const vid = db.prepare(`INSERT INTO patio_vehicles (placa_normalizada, placa_exibicao, first_seen_at, last_seen_at) VALUES ('ABC1234','ABC-1234','x','x')`).run().lastInsertRowid;
  const insO = db.prepare('INSERT INTO patio_vehicle_orders (vehicle_id, os_number, last_seen_at) VALUES (?, ?, ?)');
  insO.run(vid, '7001', 'x');
  insO.run(vid, '7002', 'x');
  assert.throws(() => insO.run(vid, '7001', 'x'), /UNIQUE/);
  db.prepare('DELETE FROM patio_vehicles WHERE id = ?').run(vid);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM patio_vehicle_orders').get().n, 0);
});

test('down remove tudo o que o up criou (reversível)', () => {
  const db = bancoBase();
  aplicar(db);
  assert.deepEqual(reverter(db), ['002_patio_empresa.js']); // uma por vez, da última para a primeira
  assert.ok(!colunas(db, 'patio_vehicle_orders').includes('empresa'));
  assert.deepEqual(reverter(db), ['001_patio.js']);
  const t = tabelas(db);
  assert.ok(!t.some((n) => n.startsWith('patio_')));
  assert.ok(!colunas(db, 'agendamentos').includes('atualizado_em'));
  assert.deepEqual(aplicar(db), ['001_patio.js', '002_patio_empresa.js']); // reaplica limpo
});
