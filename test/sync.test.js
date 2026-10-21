const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bancoDeTeste } = require('./helpers/db');
const { sincronizar, estadoSync, extrairVeiculoDaOS } = require('../patio/sync');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'novidades.html'), 'utf8');
const OS_HTML = `<html><select id="ipt_id_veiculo"><option value="1">x</option>
<option value="2" selected>ABC1234 - BMW M3 - s55 - Gasolina - 2018/2019 - Automático - 4P - Azul</option></select></html>`;

const relogio = (ts) => () => ts;
const ativos = (db) => db.prepare("SELECT * FROM patio_vehicles WHERE status='ativo'").all();
const logs = (db) => db.prepare('SELECT * FROM patio_sync_log ORDER BY id').all();

function clienteFalso({ novidades = FIXTURE, os = OS_HTML, falhar = false } = {}) {
  const chamadas = { novidades: 0, os: [] };
  return {
    chamadas,
    async novidadesHtml() { chamadas.novidades++; if (falhar) throw new Error('Onmotor fora do ar'); return novidades; },
    async osHtml(id) { chamadas.os.push(id); return os; },
  };
}

test('sync com sucesso: 35 OS → 32 veículos, detalhes enriquecidos, log gravado, broadcast disparado', async () => {
  const db = bancoDeTeste();
  const eventos = [];
  const client = clienteFalso();
  const r = await sincronizar(db, { client, agoraFn: relogio('2026-10-21 08:00:00'), broadcast: (e) => eventos.push(e), log: () => {} });
  assert.equal(r.ok, true);
  assert.deepEqual({ os: r.os_lidas, novos: r.novos, mantidos: r.mantidos, fin: r.finalizados }, { os: 35, novos: 32, mantidos: 0, fin: 0 });
  assert.equal(ativos(db).length, 32);
  assert.deepEqual(eventos, ['patio']);

  // detalhes: limitado a 15 por rodada; os enriquecidos ganham ano/cor e detalhes_ok
  assert.equal(client.chamadas.os.length, 15);
  const comDetalhe = db.prepare('SELECT * FROM patio_vehicles WHERE detalhes_ok = 1').all();
  assert.equal(comDetalhe.length, 15);
  assert.equal(comDetalhe[0].ano, '2018/2019');
  assert.equal(comDetalhe[0].cor, 'Azul');
  assert.notEqual(comDetalhe[0].modelo, 'BMW M3', 'modelo curto da listagem é preservado');

  const l = logs(db);
  assert.equal(l.length, 1);
  assert.equal(l[0].sucesso, 1);
  assert.equal(l[0].os_lidas, 35);
  assert.equal(l[0].veiculos_novos, 32);
  assert.equal(l[0].origem, 'auto');
});

test('rodadas seguintes completam os detalhes restantes sem repetir os já feitos', async () => {
  const db = bancoDeTeste();
  const client = clienteFalso();
  await sincronizar(db, { client, log: () => {} });
  await sincronizar(db, { client, log: () => {} });
  await sincronizar(db, { client, log: () => {} });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM patio_vehicles WHERE detalhes_ok = 0').get().n, 0);
  assert.equal(client.chamadas.os.length, 32);
});

test('falha de leitura: pátio fica como estava, log com erro, sem finalizar ninguém', async () => {
  const db = bancoDeTeste();
  await sincronizar(db, { client: clienteFalso(), agoraFn: relogio('2026-10-21 08:00:00'), log: () => {} });
  assert.equal(ativos(db).length, 32);

  const r1 = await sincronizar(db, { client: clienteFalso({ falhar: true }), origem: 'manual', agoraFn: relogio('2026-10-21 08:30:00'), log: () => {} });
  assert.equal(r1.ok, false);
  assert.match(r1.erro, /fora do ar/);

  const r2 = await sincronizar(db, { client: clienteFalso({ novidades: '<html>Erro 500</html>' }), agoraFn: relogio('2026-10-21 09:00:00'), log: () => {} });
  assert.equal(r2.ok, false);
  assert.match(r2.erro, /inválida/);

  assert.equal(ativos(db).length, 32, 'nenhum veículo finalizado por erro de leitura');
  const l = logs(db);
  assert.deepEqual(l.map((x) => x.sucesso), [1, 0, 0]);
  assert.equal(l[1].origem, 'manual');
  assert.ok(l[1].erro && l[2].erro);
});

test('estadoSync: última ok, falha recente e aviso de >1h sem sucesso', async () => {
  const db = bancoDeTeste();
  assert.deepEqual(estadoSync(db, { agoraFn: relogio('2026-10-21 08:00:00') }).desatualizado, true);

  await sincronizar(db, { client: clienteFalso(), agoraFn: relogio('2026-10-21 08:00:00'), log: () => {} });
  let s = estadoSync(db, { agoraFn: relogio('2026-10-21 08:20:00') });
  assert.equal(s.ultima_ok_em, '2026-10-21 08:00:00');
  assert.equal(s.minutos_desde_ok, 20);
  assert.equal(s.desatualizado, false);
  assert.equal(s.ultima_falhou, false);

  await sincronizar(db, { client: clienteFalso({ falhar: true }), agoraFn: relogio('2026-10-21 08:30:00'), log: () => {} });
  s = estadoSync(db, { agoraFn: relogio('2026-10-21 08:40:00') });
  assert.equal(s.ultima_falhou, true);
  assert.match(s.ultimo_erro, /fora do ar/);
  assert.equal(s.desatualizado, false, 'última ok ainda tem menos de 1h');

  s = estadoSync(db, { agoraFn: relogio('2026-10-21 09:01:00') });
  assert.equal(s.desatualizado, true);
});

test('extrairVeiculoDaOS lê a option selecionada do select do veículo', () => {
  assert.deepEqual(extrairVeiculoDaOS(OS_HTML), { placa: 'ABC1234', marcaModelo: 'BMW M3', ano: '2018/2019', cor: 'Azul' });
  assert.equal(extrairVeiculoDaOS('<html>sem select</html>').placa, null);
});
