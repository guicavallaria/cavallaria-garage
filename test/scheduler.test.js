const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bancoDeTeste } = require('./helpers/db');
const { criarScheduler } = require('../patio/scheduler');
const { adquirirLock, liberarLock } = require('../patio/lock');

// Relógio controlável (instantes em UTC; SP = UTC-3)
function relogio(inicialIso) {
  let atual = new Date(inicialIso);
  return { agoraFn: () => atual, avancarMin: (m) => { atual = new Date(atual.getTime() + m * 60_000); } };
}

function montar(db, rel, extra = {}) {
  const execucoes = [];
  const s = criarScheduler({ db, sincronizar: async (o) => { execucoes.push({ ...o, em: rel.agoraFn().toISOString() }); return { ok: true }; }, intervaloMin: 30, agoraFn: rel.agoraFn, log: () => {}, ...extra });
  return { s, execucoes };
}

test('roda dentro da janela, respeita o intervalo de 30 min e pula fora da janela', async () => {
  const db = bancoDeTeste();
  const rel = relogio('2026-10-21T10:00:00Z'); // qua 07:00 SP — antes da janela
  const { s, execucoes } = montar(db, rel);

  assert.deepEqual(await s.tick(), { pulou: 'fora da janela' });
  rel.avancarMin(30); // 07:30
  assert.equal((await s.tick()).ok, true);
  rel.avancarMin(10); // 07:40
  assert.deepEqual(await s.tick(), { pulou: 'intervalo' });
  rel.avancarMin(20); // 08:00
  assert.equal((await s.tick()).ok, true);
  assert.equal(execucoes.length, 2);
  assert.equal(execucoes[0].origem, 'auto');

  // 19:00 em diante não roda
  rel.avancarMin(11 * 60); // 19:00
  assert.deepEqual(await s.tick(), { pulou: 'fora da janela' });
});

test('sábado e domingo não rodam (seg–sex)', async () => {
  const db = bancoDeTeste();
  const rel = relogio('2026-10-24T15:00:00Z'); // sáb 12:00 SP
  const { s, execucoes } = montar(db, rel);
  assert.deepEqual(await s.tick(), { pulou: 'fora da janela' });
  rel.avancarMin(24 * 60); // dom
  assert.deepEqual(await s.tick(), { pulou: 'fora da janela' });
  rel.avancarMin(24 * 60); // seg 12:00
  assert.equal((await s.tick()).ok, true);
  assert.equal(execucoes.length, 1);
});

test('lock: se outro dono segura o lock, o tick pula; lock expirado é tomado; lock é liberado no fim', async () => {
  const db = bancoDeTeste();
  const rel = relogio('2026-10-21T15:00:00Z'); // qua 12:00 SP
  const { s, execucoes } = montar(db, rel);

  assert.equal(adquirirLock(db, 'manual', 600, rel.agoraFn().getTime()), true);
  assert.deepEqual(await s.tick(), { pulou: 'lock' });
  liberarLock(db, 'manual');

  // lock "fantasma" de um processo que morreu: já expirou → é tomado
  assert.equal(adquirirLock(db, 'morto', 1, rel.agoraFn().getTime() - 10_000), true);
  assert.equal((await s.tick()).ok, true);
  assert.equal(execucoes.length, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM patio_sync_lock').get().n, 0, 'lock liberado após rodar');
});

test('não roda duas vezes em paralelo', async () => {
  const db = bancoDeTeste();
  const rel = relogio('2026-10-21T15:00:00Z');
  let liberar;
  const pendente = new Promise((res) => { liberar = res; });
  const s = criarScheduler({ db, sincronizar: () => pendente, intervaloMin: 0.0001, agoraFn: rel.agoraFn, log: () => {} });
  const p1 = s.tick();
  rel.avancarMin(1);
  assert.deepEqual(await s.tick(), { pulou: 'em andamento' });
  liberar({ ok: true });
  assert.equal((await p1).ok, true);
});

test('kanban: lock próprio, janela 07:00–19:00 e folga de um tick (intervalo real ≤ 2 min)', async () => {
  const db = bancoDeTeste();
  const { JANELA_KANBAN } = require('../kanban/sync');
  const rel = relogio('2026-10-23T10:00:00Z'); // sex 07:00 SP — já dentro da janela do kanban
  const avancarSeg = (s) => rel.avancarMin(s / 60);
  const { s, execucoes } = montar(db, rel, { intervaloMin: 2, janela: JANELA_KANBAN, tickMs: 10_000, folgaMs: 10_000, rotulo: 'kanban', tabelaLock: 'kb_sync_lock' });

  assert.equal((await s.tick()).ok, true);
  avancarSeg(100);
  assert.deepEqual(await s.tick(), { pulou: 'intervalo' });
  avancarSeg(10); // 110 s: dentro da folga, já roda
  assert.equal((await s.tick()).ok, true);
  assert.equal(execucoes.length, 2);

  // o lock do pátio não bloqueia o kanban, e vice-versa
  assert.ok(adquirirLock(db, 'outro', 600, rel.agoraFn().getTime(), 'patio_sync_lock'));
  avancarSeg(120);
  assert.equal((await s.tick()).ok, true);
  assert.ok(adquirirLock(db, 'outro', 600, rel.agoraFn().getTime(), 'kb_sync_lock'));
  avancarSeg(120);
  assert.deepEqual(await s.tick(), { pulou: 'lock' });
  liberarLock(db, 'outro', 'kb_sync_lock');
});

test('lock só aceita as tabelas conhecidas', () => {
  const db = bancoDeTeste();
  assert.throws(() => adquirirLock(db, 'x', 600, Date.now(), 'agendamentos; DROP TABLE x'), /desconhecida/);
});
