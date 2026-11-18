// Qual Onmotor cada empresa usa, e em qual endereço.
//
// Em 18/11/2026 o Onmotor da Cavallaria virou um sistema novo (API JSON em https://cavallaria.onmotor.com,
// sem ".br"). O da AWDYNA continuou no antigo (HTML em https://awdyna.onmotor.com.br). Quando a AWDYNA
// migrar, basta ONMOTOR_AWDYNA_TIPO=api (ou trocar o padrão aqui).
//
//   ONMOTOR_CAVALLARIA_TIPO / ONMOTOR_AWDYNA_TIPO = api | html
//   api:  ONMOTOR_API_BASE_URL (Cavallaria) / ONMOTOR_AWDYNA_API_BASE_URL
//   html: ONMOTOR_BASE_URL     (Cavallaria) / ONMOTOR_AWDYNA_BASE_URL
// As variáveis antigas (ONMOTOR_BASE_URL…) só valem para o sistema antigo: um endereço ".com.br"
// salvo no Railway não atrapalha a leitura da API nova.
const PADRAO_TIPO = { cavallaria: 'api', awdyna: 'html' };

function tipoDaFonte(empresa, env = process.env) {
  const v = String(env[`ONMOTOR_${String(empresa).toUpperCase()}_TIPO`] || '').toLowerCase();
  if (v === 'api' || v === 'html') return v;
  return PADRAO_TIPO[empresa] || 'html';
}

function baseDaFonte(empresa, env = process.env) {
  const cav = empresa === 'cavallaria';
  if (tipoDaFonte(empresa, env) === 'api') {
    return (cav ? env.ONMOTOR_API_BASE_URL : env[`ONMOTOR_${String(empresa).toUpperCase()}_API_BASE_URL`]) || `https://${empresa}.onmotor.com`;
  }
  return (cav ? env.ONMOTOR_BASE_URL : env[`ONMOTOR_${String(empresa).toUpperCase()}_BASE_URL`]) || `https://${empresa}.onmotor.com.br`;
}

module.exports = { tipoDaFonte, baseDaFonte, PADRAO_TIPO };
