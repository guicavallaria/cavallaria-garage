// Placas brasileiras: padrão antigo AAA9999 e Mercosul AAA9A99.
// Chave do painel = placa normalizada (maiúsculas, só letras/dígitos).
//
// Forma unificada: 3 letras + dígito + (letra|dígito) + 2 dígitos.
// Na extração de texto livre exigimos a placa "colada" (hífen opcional, sem
// espaço no meio) para não confundir "ASX 2024" (modelo + ano) com placa.
const RX_PLACA_NORMALIZADA = /^[A-Z]{3}\d[A-Z0-9]\d{2}$/;
const RX_PLACA_NO_TEXTO = /(?<![A-Z0-9])([A-Z]{3})-?(\d[A-Z0-9]\d{2})(?![A-Z0-9])/i;

function normalizarPlaca(valor) {
  const limpa = String(valor || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return RX_PLACA_NORMALIZADA.test(limpa) ? limpa : null;
}

// Primeira placa encontrada num texto livre (ex.: campo "veículo" da agenda).
function extrairPlaca(texto) {
  const m = String(texto || '').match(RX_PLACA_NO_TEXTO);
  return m ? normalizarPlaca(m[1] + m[2]) : null;
}

// Exibição: antiga com hífen (ABC-1234), Mercosul sem (ABC1D23), como se usa no Brasil.
function formatarPlaca(normalizada) {
  const p = normalizarPlaca(normalizada);
  if (!p) return '';
  return /^[A-Z]{3}\d{4}$/.test(p) ? `${p.slice(0, 3)}-${p.slice(3)}` : p;
}

module.exports = { normalizarPlaca, extrairPlaca, formatarPlaca };
