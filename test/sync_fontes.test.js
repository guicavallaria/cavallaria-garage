const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { bancoDeTeste } = require('./helpers/db');
const { sincronizar, estadoSync, fontes } = require('../patio/sync');

const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'novidades.html'), 'utf8');
// AWDYNA "fictícia": a mesma página com os números de OS alterados (placas iguais → dedup entre empresas)
const FIXTURE_AWD = FIXTURE.replace(/visible-xs-inline">\s*(\d+)\s*<\/span>/g, (m, n) => m.replace(n, String(Number(n) + 10000)));
const OS_HTML = '<html><select id="ipt_id_veiculo"><option selected>ABC1234 - VW GOL - 2020/2021 - Prata</option></select></html>';

function clienteFalso(nome, { novidades = FIXTURE, falhar = false } = {}) {
  const chamadas = { novidades: 0, os: [] };
  return { nome, chamadas,
    async novidadesHtml() { chamadas.novidades++; if (falhar) throw new Error(`${nome} fora do ar`); return novidades; },
    async osHtml(id) { chamadas.os.push(id); return OS_HTML; } };
}
const ativos = (db) => db.prepare("SELECT * FROM patio_vehicles WHERE status='ativo'").all();
const relogio = (ts) => () => ts;

test('fontes: Cavallaria + AWDYNA por padrão; AWDYNA desligável por env', () => {
  assert.deepEqual(fontes({}).map((f) => f.nome), ['cavallaria', 'awdyna']);
  assert.deepEqual(fontes({ PATIO_AWDYNA_ENABLED: 'false' }).map((f) => f.nome), ['cavallaria']);
  assert.equal(fontes({ ONMOTOR_AWDYNA_BASE_URL: 'https://x' })[1].baseUrl, 'https://x');
});

test('duas fontes OK: OS das duas somam, placas repetidas entre empresas viram um card', async () => {
  const db = bancoDeTeste();
  const clientes = new Map([['cavallaria', clienteFalso('cavallaria')], ['awdyna', clienteFalso('awdyna', { novidades: FIXTURE_AWD })]]);
  const r = await sincronizar(db, { clientes, log: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.os_lidas, 70);
  assert.equal(r.novos, 32, 'mesmas 32 placas nas duas empresas → 32 cards');
  assert.deepEqual(r.fontes_lidas.map((f) => `${f.nome}=${f.os}`), ['cavallaria=35', 'awdyna=35']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM patio_vehicle_orders WHERE empresa='awdyna'").get().n, 35);
  assert.deepEqual(r.fontes_falhas, []);
});

test('uma fonte falha: a outra é aplicada, veículos da que falhou ficam, log marca aviso (não erro)', async () => {
  const db = bancoDeTeste();
  const ok = new Map([['cavallaria', clienteFalso('cavallaria')], ['awdyna', clienteFalso('awdyna', { novidades: FIXTURE_AWD })]]);
  await sincronizar(db, { clientes: ok, agoraFn: relogio('2026-10-21 08:00:00'), log: () => {} });

  // rodada 2: AWDYNA fora; Cavallaria lida (iguais) → nada finaliza, aviso presente
  const parcial = new Map([['cavallaria', clienteFalso('cavallaria')], ['awdyna', clienteFalso('awdyna', { falhar: true })]]);
  const r = await sincronizar(db, { clientes: parcial, agoraFn: relogio('2026-10-21 08:30:00'), log: () => {} });
  assert.equal(r.ok, true);
  assert.equal(r.finalizados, 0);
  assert.equal(ativos(db).length, 32);
  assert.deepEqual(r.fontes_falhas.map((f) => f.nome), ['awdyna']);
  const s = estadoSync(db, { agoraFn: relogio('2026-10-21 08:31:00') });
  assert.equal(s.ultima_falhou, false);
  assert.deepEqual(s.fontes_com_falha, ['awdyna']);
});

test('todas as fontes falham: rodada conta como erro e nada muda', async () => {
  const db = bancoDeTeste();
  await sincronizar(db, { clientes: new Map([['cavallaria', clienteFalso('cavallaria')]]), log: () => {} });
  const r = await sincronizar(db, { clientes: new Map([['cavallaria', clienteFalso('cavallaria', { falhar: true })], ['awdyna', clienteFalso('awdyna', { falhar: true })]]), log: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.erro, /cavallaria: .*fora do ar/);
  assert.match(r.erro, /awdyna: .*fora do ar/);
  assert.equal(ativos(db).length, 32);
});

test('detalhes (ano/cor) são buscados no cliente da empresa de origem da OS', async () => {
  const db = bancoDeTeste();
  const cav = clienteFalso('cavallaria', { novidades: '<html>Últimas novidades<table class="table-novidades"></table></html>' });
  const awd = clienteFalso('awdyna', { novidades: FIXTURE_AWD });
  await sincronizar(db, { clientes: new Map([['cavallaria', cav], ['awdyna', awd]]), log: () => {} });
  assert.equal(cav.chamadas.os.length, 0);
  assert.equal(awd.chamadas.os.length, 15);
  assert.equal(db.prepare("SELECT cor FROM patio_vehicles WHERE detalhes_ok=1 LIMIT 1").get().cor, 'Prata');
});
