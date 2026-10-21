const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseVeiculoOnmotor, anoCurto } = require('../patio/veiculo');

test('string completa da OS: placa, marca/modelo, ano e cor', () => {
  const v = parseVeiculoOnmotor('QPV3A78 - BMW M3 - s55 - Gasolina - 2018/2018 - Automático - 4P - Azul');
  assert.deepEqual(v, { placa: 'QPV3A78', marcaModelo: 'BMW M3', ano: '2018/2018', cor: 'Azul' });
});

test('string curta sem cor e sem especificações', () => {
  assert.deepEqual(parseVeiculoOnmotor('ABC1234 - GOL 1.0 - 2019/2020'), { placa: 'ABC1234', marcaModelo: 'GOL 1.0', ano: '2019/2020', cor: '' });
  assert.deepEqual(parseVeiculoOnmotor('abc-1234 - CIVIC'), { placa: 'ABC1234', marcaModelo: 'CIVIC', ano: '', cor: '' });
});

test('placa inválida ou texto vazio não quebram', () => {
  assert.equal(parseVeiculoOnmotor('SEM PLACA - FUSCA - 1975/1975').placa, null);
  assert.deepEqual(parseVeiculoOnmotor(''), { placa: null, marcaModelo: '', ano: '', cor: '' });
});

test('anoCurto usa o ano-modelo', () => {
  assert.equal(anoCurto('2018/2019'), '2019');
  assert.equal(anoCurto('2018/2018'), '2018');
  assert.equal(anoCurto('2020'), '2020');
  assert.equal(anoCurto(''), '');
});
