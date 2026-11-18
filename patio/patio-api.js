// Tradução da Pátio do Onmotor novo (POST /api/v1/service/core/services-news) para o MESMO
// formato de linha que o parser da Novidades antiga devolvia (patio/parser.js → parseLinhas).
// Assim o kanban e o painel de pátio não mudam: só a fonte.
//
// Etapas (ícones da Novidades antiga → campos da API nova):
//   entrada        ← entry_date              orcamento  ← approved_budget_date
//   aguardandoPeca ← awaiting_part_date      emExecucao ← execution_date
//   finalizado     ← end_date                retirado   ← pickup_date
// Na Pátio as datas vêm sem o ano ("18/11 08:59"). As datas completas ("2026-11-18 08:59") saem
// da OS inteira (GET /api/v1/service/core/<uid>), que o cliente guarda em cache.
const { normalizarPlaca, formatarPlaca } = require('./placa');

const ETAPAS = [
  ['entrada', 'entry_date'],
  ['orcamento', 'approved_budget_date'],
  ['aguardandoPeca', 'awaiting_part_date'],
  ['emExecucao', 'execution_date'],
  ['finalizado', 'end_date'],
  ['retirado', 'pickup_date'],
];

const limpo = (v) => {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s ? s : null;
};

// "2026-11-18 08:59:00" → "2026-11-18 08:59" (hora de SP, sem fuso, igual à Novidades antiga)
function dataCompleta(v) {
  const m = String(v || '').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2}))?/);
  return m ? (m[2] ? `${m[1]} ${m[2]}` : m[1]) : null;
}

// "+55(11)99999-9999" → "(11)99999-9999", o formato que a Novidades antiga mostrava.
function telefone(v) {
  const s = limpo(v);
  if (!s) return null;
  const m = s.replace(/^\+?55\s*/, '').match(/\(\d{2}\)\s?\d{4,5}-?\d{4}/);
  return m ? m[0] : s;
}

function km(v) {
  const d = String(v ?? '').replace(/\D/g, '');
  return d && Number(d) > 0 ? String(Number(d)) : null;
}

// `os` = OS inteira (pode faltar se a leitura dela falhou: aí as datas ficam null nesta rodada).
function linhaDoPatio(s, os = null) {
  const placaTexto = limpo(s.vehicle_plate) || '';
  const placa = normalizarPlaca(placaTexto);
  const etapas = {};
  const datas = {};
  for (const [nome, campo] of ETAPAS) {
    etapas[nome] = Boolean(limpo(s[campo]));
    datas[nome] = os ? dataCompleta(os[campo]) : null;
  }
  return {
    osId: limpo(s.uid),
    osNumber: s.code === null || s.code === undefined ? null : String(s.code),
    proprietario: limpo(s.customer_name) || '',
    placaTexto, placa, placaExibicao: placa ? formatarPlaca(placa) : placaTexto,
    modelo: limpo(s.vehicle_model) || '',
    km: km(s.vehicle_odometer) || (os ? km(os.odometer) : null),
    telefone: telefone(s.customer_mobile_number) || telefone(s.customer_phone),
    entrada: os ? dataCompleta(os.entry_date) : null, // sem entrada: o card mantém a data que já tinha
    etapas, datas,
    chassi: limpo(s.vehicle_chassi),
    fabricante: limpo(s.vehicle_manufacturer),
  };
}

// Sanidade antes de confiar na leitura (nunca "zerar" o quadro por resposta quebrada).
function validarServicos(servicos) {
  if (!Array.isArray(servicos)) return ['a Pátio do Onmotor não veio com a lista de serviços (data.services)'];
  const ruins = servicos.filter((s) => !s || typeof s !== 'object' || !s.uid || s.code === null || s.code === undefined);
  return ruins.length ? [`${ruins.length} serviço(s) da Pátio sem uid ou número da OS (a API mudou?)`] : [];
}

// Regra de negócio: está no pátio = deu entrada e ainda não finalizou.
const noPatio = (l) => l.etapas.entrada === true && l.etapas.finalizado === false;

module.exports = { linhaDoPatio, validarServicos, noPatio, dataCompleta, telefone, ETAPAS };
