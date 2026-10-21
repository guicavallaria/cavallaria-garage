const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseNovidades, validarPagina, dataBR, texto } = require('../patio/parser');

// Página real da aba Novidades, anonimizada (test/fixtures/gerar-novidades.js):
// 37 OS = 35 em execução + 1 finalizada (7320) + 1 aguardando entrada (7288).
const FIXTURE = fs.readFileSync(path.join(__dirname, 'fixtures', 'novidades.html'), 'utf8');

test('fixture: 37 linhas, 35 em execução, 32 placas distintas (dedup real: uma placa com 3 OS e outra com 2)', () => {
  const r = parseNovidades(FIXTURE);
  assert.equal(r.ok, true, r.problemas.join('; '));
  assert.equal(r.totalLido, 37);
  assert.equal(r.emExecucao.length, 35);
  const porPlaca = new Map();
  for (const l of r.emExecucao) porPlaca.set(l.placa, (porPlaca.get(l.placa) || 0) + 1);
  assert.equal(porPlaca.size, 32);
  assert.deepEqual([...porPlaca.values()].filter((n) => n > 1).sort((a, b) => b - a), [3, 2]);
  assert.equal(r.emExecucao.filter((l) => !l.placa).length, 0);
});

test('fixture: OS finalizada e OS aguardando entrada ficam FORA do pátio (mas são lidas)', () => {
  const r = parseNovidades(FIXTURE);
  const nums = (lista) => lista.map((l) => l.osNumber);
  assert.ok(nums(r.linhas).includes('7320') && nums(r.linhas).includes('7288'));
  assert.ok(!nums(r.emExecucao).includes('7320'), 'finalizada não pode estar no pátio');
  assert.ok(!nums(r.emExecucao).includes('7288'), 'sem entrada não pode estar no pátio');
  const fin = r.linhas.find((l) => l.osNumber === '7320');
  assert.equal(fin.etapas.entrada, true);
  assert.equal(fin.etapas.finalizado, true);
  const ag = r.linhas.find((l) => l.osNumber === '7288');
  assert.equal(ag.etapas.entrada, false);
  assert.equal(ag.entrada, null);
});

test('fixture: campos da primeira linha', () => {
  const l = parseNovidades(FIXTURE).linhas[0];
  assert.equal(l.osNumber, '7426');
  assert.equal(l.osId, '9495122');
  assert.equal(l.modelo, 'M3');
  assert.equal(l.km, '0');
  assert.equal(l.entrada, '2026-10-20 16:06');
  assert.equal(l.proprietario, 'Cliente Teste 1');
  assert.match(l.telefone, /^\(46\)9\d{4}-0000$/);
  assert.match(l.placa, /^[A-Z]{3}\d[A-Z0-9]\d{2}$/);
  assert.deepEqual(l.etapas, { entrada: true, orcamento: false, aguardandoPeca: false, emExecucao: false, finalizado: false, retirado: false });
});

test('fixture: placa antiga com hífen é normalizada e exibida com hífen', () => {
  const comHifen = parseNovidades(FIXTURE).linhas.filter((l) => /-/.test(l.placaTexto));
  assert.ok(comHifen.length >= 3);
  for (const l of comHifen) {
    assert.match(l.placa, /^[A-Z]{3}\d{4}$/);
    assert.match(l.placaExibicao, /^[A-Z]{3}-\d{4}$/);
  }
});

test('dataBR: dd/mm/aa com hora, dd/mm/aaaa sem hora, inválido', () => {
  assert.equal(dataBR('20/10/26 16:06'), '2026-10-20 16:06');
  assert.equal(dataBR('20/10/2026'), '2026-10-20');
  assert.equal(dataBR('Sem previsão'), null);
});

test('texto: remove tags e decodifica entidades', () => {
  assert.equal(texto('  A &amp; B <b>x</b>\n y '), 'A & B x y');
});

test('validação: página estranha não é aceita', () => {
  const v = validarPagina('<html><body>erro 500</body></html>');
  assert.equal(v.ok, false);
  assert.equal(v.problemas.length, 2);
});

test('validação: layout mudado (linhas não parseadas) falha em vez de devolver pátio vazio', () => {
  const quebrado = FIXTURE.replace(/tr-servico-bg/g, 'tr-outra-classe');
  const r = parseNovidades(quebrado);
  assert.equal(r.ok, false);
  assert.equal(r.totalLido, 0);
  assert.match(r.problemas.join(' '), /inconsistência/);
});
