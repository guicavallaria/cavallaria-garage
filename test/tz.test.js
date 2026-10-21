const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hojeSP, agoraSP, partesSP, dentroDaJanela } = require('../patio/tz');

// Brasil não tem horário de verão desde 2019: São Paulo = UTC-3 o ano todo.
const utc = (s) => new Date(s);

test('hojeSP vira o dia às 00:00 de São Paulo, não de UTC', () => {
  assert.equal(hojeSP(utc('2026-10-21T02:30:00Z')), '2026-10-20'); // 23:30 em SP
  assert.equal(hojeSP(utc('2026-10-21T03:00:00Z')), '2026-10-21'); // 00:00 em SP
  assert.equal(hojeSP(utc('2026-10-21T12:00:00Z')), '2026-10-21');
});

test('agoraSP/partesSP devolvem hora local de SP e dia da semana', () => {
  assert.equal(agoraSP(utc('2026-10-21T13:05:09Z')), '2026-10-21 10:05:09');
  const p = partesSP(utc('2026-10-24T15:00:00Z')); // sábado
  assert.equal(p.diaSemana, 6);
  assert.equal(p.hora, '12:00');
});

test('janela: seg–sex, 07:30 inclusive até 19:00 exclusive (horário de SP)', () => {
  assert.equal(dentroDaJanela(utc('2026-10-21T10:29:00Z')), false); // qua 07:29
  assert.equal(dentroDaJanela(utc('2026-10-21T10:30:00Z')), true);  // qua 07:30
  assert.equal(dentroDaJanela(utc('2026-10-21T15:00:00Z')), true);  // qua 12:00
  assert.equal(dentroDaJanela(utc('2026-10-21T21:59:00Z')), true);  // qua 18:59
  assert.equal(dentroDaJanela(utc('2026-10-21T22:00:00Z')), false); // qua 19:00
  assert.equal(dentroDaJanela(utc('2026-10-23T15:00:00Z')), true);  // sex 12:00
  assert.equal(dentroDaJanela(utc('2026-10-24T15:00:00Z')), false); // sáb 12:00
  assert.equal(dentroDaJanela(utc('2026-10-25T15:00:00Z')), false); // dom 12:00
});

test('janela aceita configuração alternativa (ex.: incluir sábado)', () => {
  const j = { diasSemana: [1, 2, 3, 4, 5, 6], inicioMin: 8 * 60, fimMin: 18 * 60 };
  assert.equal(dentroDaJanela(utc('2026-10-24T15:00:00Z'), j), true);  // sáb 12:00
  assert.equal(dentroDaJanela(utc('2026-10-24T10:30:00Z'), j), false); // sáb 07:30
});
