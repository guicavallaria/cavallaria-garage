const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizarPlaca, extrairPlaca, formatarPlaca } = require('../patio/placa');

test('normalizarPlaca aceita antiga e Mercosul, ignora caixa/hífen/espaços', () => {
  assert.equal(normalizarPlaca('abc-1234'), 'ABC1234');
  assert.equal(normalizarPlaca('ABC 1234'), 'ABC1234');
  assert.equal(normalizarPlaca('abc1d23'), 'ABC1D23');
  assert.equal(normalizarPlaca(' ABC-1D23 '), 'ABC1D23');
});

test('normalizarPlaca rejeita o que não é placa', () => {
  assert.equal(normalizarPlaca(''), null);
  assert.equal(normalizarPlaca(null), null);
  assert.equal(normalizarPlaca('ABCD123'), null);   // 4 letras
  assert.equal(normalizarPlaca('AB12345'), null);   // 2 letras
  assert.equal(normalizarPlaca('ABC12D3'), null);   // letra na posição errada
  assert.equal(normalizarPlaca('1234ABC'), null);
});

test('extrairPlaca acha a placa em texto livre do campo veículo', () => {
  assert.equal(extrairPlaca('ABC-1234 Gol 2019'), 'ABC1234');
  assert.equal(extrairPlaca('gol abc1d23 branco'), 'ABC1D23');
  assert.equal(extrairPlaca('Placa: XYZ9A87 - Civic'), 'XYZ9A87');
  assert.equal(extrairPlaca('BMW 320i / rlp7e58 / preto'), 'RLP7E58');
  assert.equal(extrairPlaca('GDJ2F98 - MBENZ GLS350D'), 'GDJ2F98');
});

test('extrairPlaca não confunde modelo+ano nem pedaços de palavras', () => {
  assert.equal(extrairPlaca('Mitsubishi ASX 2024 prata'), null);   // espaço entre letras e ano
  assert.equal(extrairPlaca('Civic 2020 cinza'), null);
  assert.equal(extrairPlaca('sem placa informada'), null);
  assert.equal(extrairPlaca('XABC1234Y'), null);                   // colado em outros caracteres
  assert.equal(extrairPlaca(''), null);
});

test('extrairPlaca devolve a PRIMEIRA placa quando há mais de uma', () => {
  assert.equal(extrairPlaca('ABC1234 (antes QWE5R67)'), 'ABC1234');
});

test('formatarPlaca: antiga com hífen, Mercosul sem', () => {
  assert.equal(formatarPlaca('ABC1234'), 'ABC-1234');
  assert.equal(formatarPlaca('abc1d23'), 'ABC1D23');
  assert.equal(formatarPlaca('inválida'), '');
});
