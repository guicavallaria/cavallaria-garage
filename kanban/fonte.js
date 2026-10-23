// Qual Onmotor o kanban lê: o real (padrão) ou o simulado (KANBAN_FONTE=mock),
// como o prompt pede para o desenvolvimento. O real usa o mesmo cliente HTTP e o
// mesmo cookie de sessão do pátio (conta de automação em ONMOTOR_USER/ONMOTOR_PASS).
const { OnmotorClient } = require('../patio/onmotor');
const { OnmotorMock } = require('./onmotor-mock');

function modoFonte(env = process.env) {
  return env.KANBAN_FONTE === 'mock' ? 'mock' : 'real';
}

function fonteConfigurada(env = process.env) {
  return modoFonte(env) === 'mock' || Boolean(env.ONMOTOR_USER && env.ONMOTOR_PASS);
}

// Um cliente novo por rodada: ele recarrega o cookie salvo, que o pátio também atualiza.
function criarCliente({ log = () => {}, env = process.env } = {}) {
  if (modoFonte(env) === 'mock') return new OnmotorMock({ log });
  if (!fonteConfigurada(env)) return null;
  return new OnmotorClient({ nome: 'cavallaria', baseUrl: env.ONMOTOR_BASE_URL || 'https://cavallaria.onmotor.com.br', log });
}

module.exports = { criarCliente, modoFonte, fonteConfigurada };
