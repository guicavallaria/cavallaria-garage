const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { bancoDeTeste } = require('./helpers/db');
const nov = require('./helpers/novidades');
const { aplicarLeitura } = require('../kanban/sync');
const chk = require('../kanban/checklists');
const checkin = require('../kanban/checkin');

function banco() {
  const db = bancoDeTeste();
  db.transaction(() => aplicarLeitura(db, nov.linhas(), { agora: '2026-10-23T12:00:00.000Z', primeiraCarga: true }))();
  return db;
}

test('check-in: sem vistoria, em andamento e finalizada (a finalizada vence a mais nova em andamento)', () => {
  const db = banco();
  const [a, b, c] = db.prepare('SELECT * FROM kb_cards ORDER BY id LIMIT 3').all();
  chk.iniciar(db, b.id, 'entrada', { feitoPor: 'Edson', operador: 'Edson' });
  const { execucao } = chk.iniciar(db, c.id, 'entrada', { feitoPor: 'Iago', operador: 'Iago' });
  db.prepare("UPDATE kb_checklist_execucoes SET status='finalizado', finalizado_em='2026-10-24T13:00:00.000Z' WHERE id=?").run(execucao.id);
  // revisão não conta como check-in
  chk.iniciar(db, a.id, 'revisao_basica', { feitoPor: 'Luiz', operador: 'Luiz' });

  const por = Object.fromEntries(checkin.statusCheckin(db).map((r) => [r.os, r]));
  assert.equal(por[a.os_numero].checkin, null);
  assert.equal(por[b.os_numero].checkin, 'em_andamento');
  assert.equal(por[b.os_numero].feito_por, 'Edson');
  assert.equal(por[c.os_numero].checkin, 'finalizado');
  assert.equal(por[c.os_numero].finalizado_em, '2026-10-24T13:00:00.000Z');
});

test('check-in: rota exige o token', async () => {
  const db = banco();
  const app = express();
  app.get('/c', checkin.rota({ db, token: 'segredo' }));
  const srv = app.listen(0);
  try {
    const url = `http://127.0.0.1:${srv.address().port}/c`;
    assert.equal((await fetch(url)).status, 401);
    assert.equal((await fetch(url, { headers: { Authorization: 'Bearer errado' } })).status, 401);
    const ok = await fetch(url + '?empresa=cavallaria', { headers: { Authorization: 'Bearer segredo' } });
    assert.equal(ok.status, 200);
    const j = await ok.json();
    assert.ok(j.cards.length > 0);
    assert.ok(j.cards.every((r) => r.empresa === 'cavallaria'));
  } finally { srv.close(); }
});

test('check-in: sem token configurado a rota fica fechada', async () => {
  const db = banco();
  const app = express();
  app.get('/c', checkin.rota({ db, token: '' }));
  const srv = app.listen(0);
  try {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/c`, { headers: { Authorization: 'Bearer ' } });
    assert.equal(r.status, 401);
  } finally { srv.close(); }
});

test('check-in: classificação para os relatórios', () => {
  const { classificar } = checkin;
  const fin = { checkin: 'finalizado', finalizado_em: '2026-10-27T02:30:00.000Z', feito_por: 'Edson', entrada_em: '2026-10-26T12:00:00.000Z' };
  assert.equal(classificar('cavallaria', '24/10/2026', fin), null);                       // antes de 26/10: fotos
  assert.deepEqual(classificar('cavallaria', '28/10/2026', fin), { s: 'ok', em: '26/10', por: 'Edson' }); // horário de SP
  assert.equal(classificar('cavallaria', '28/10/2026', undefined).s, 'semcard');
  assert.equal(classificar('cavallaria', '28/10/2026', { checkin: 'em_andamento', feito_por: 'Iago' }).s, 'andamento');
  assert.equal(classificar('cavallaria', '28/10/2026', { checkin: null, entrada_em: '2026-10-20T10:00:00.000Z' }).s, 'antes');
  assert.equal(classificar('cavallaria', '28/10/2026', { checkin: null, entrada_em: '2026-10-26T10:00:00.000Z' }).s, 'sem');
  // AWDYNA entrou no kanban em 30/10
  assert.equal(classificar('awdyna', '30/10/2026', { checkin: null, entrada_em: '2026-10-27T10:00:00.000Z' }).s, 'antes');
  assert.equal(classificar('awdyna', '27/10/2026', undefined).s, 'antes');   // finalizada antes da AWDYNA entrar no kanban
  assert.equal(classificar('awdyna', '31/10/2026', undefined).s, 'semcard');
});
