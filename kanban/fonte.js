// Quais Onmotor o kanban lê: Cavallaria e AWDYNA (mesmo login), reais (padrão) ou simulados
// (KANBAN_FONTE=mock), como o prompt pede para o desenvolvimento. O real usa o mesmo cliente HTTP
// e o mesmo cookie de sessão do pátio (conta de automação em ONMOTOR_USER/ONMOTOR_PASS).
// KANBAN_AWDYNA_ENABLED=false tira a AWDYNA da leitura sem mexer nos cards que já existem.
const { OnmotorClient } = require('../patio/onmotor');
const { OnmotorMock } = require('./onmotor-mock');

function modoFonte(env = process.env) {
  return env.KANBAN_FONTE === 'mock' ? 'mock' : 'real';
}

function fonteConfigurada(env = process.env) {
  return modoFonte(env) === 'mock' || Boolean(env.ONMOTOR_USER && env.ONMOTOR_PASS);
}

// Empresas lidas. No modo simulado, a AWDYNA só entra se houver um arquivo próprio da Novidades.
function empresasAtivas(env = process.env) {
  const lista = ['cavallaria'];
  if (env.KANBAN_AWDYNA_ENABLED === 'false') return lista;
  if (modoFonte(env) === 'real' || env.KANBAN_MOCK_NOVIDADES_AWDYNA) lista.push('awdyna');
  return lista;
}

function criarClienteDe(empresa, { log = () => {}, env = process.env } = {}) {
  if (modoFonte(env) === 'mock') {
    return new OnmotorMock({ log, ...(empresa === 'awdyna' ? { arquivo: env.KANBAN_MOCK_NOVIDADES_AWDYNA } : {}) });
  }
  if (!fonteConfigurada(env)) return null;
  const baseUrl = empresa === 'awdyna'
    ? env.ONMOTOR_AWDYNA_BASE_URL || 'https://awdyna.onmotor.com.br'
    : env.ONMOTOR_BASE_URL || 'https://cavallaria.onmotor.com.br';
  return new OnmotorClient({ nome: empresa, baseUrl, log });
}

// Clientes novos por rodada: eles recarregam o cookie salvo, que o pátio também atualiza.
function criarClientes({ log = () => {}, env = process.env } = {}) {
  return empresasAtivas(env)
    .map((empresa) => ({ empresa, client: criarClienteDe(empresa, { log, env }) }))
    .filter((c) => c.client);
}

module.exports = { criarClientes, empresasAtivas, modoFonte, fonteConfigurada };
