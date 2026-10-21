// Texto do veículo na página da OS (select ipt_id_veiculo), ex.:
//   "QPV3A78 - BMW M3 - s55 - Gasolina - 2018/2018 - Automático - 4P - Azul"
//   "ABC1234 - GOL 1.0 - 2019/2020"
// Nem todo cadastro tem todas as partes. Placa é sempre a 1ª; ano é a parte
// AAAA/AAAA; cor é a ÚLTIMA parte quando existe algo depois do ano.
const { normalizarPlaca } = require('./placa');

function parseVeiculoOnmotor(texto) {
  const partes = String(texto || '').split(' - ').map((s) => s.trim()).filter(Boolean);
  if (!partes.length) return { placa: null, marcaModelo: '', ano: '', cor: '' };
  const anoIdx = partes.findIndex((p) => /^\d{4}(\/\d{4})?$/.test(p));
  const placa = normalizarPlaca(partes[0]);
  const marcaModelo = anoIdx > 1 ? partes[1] : (partes[1] && anoIdx !== 1 ? partes[1] : '');
  const ano = anoIdx >= 0 ? partes[anoIdx] : '';
  const cor = anoIdx >= 0 && partes.length > anoIdx + 1 ? partes[partes.length - 1] : '';
  return { placa, marcaModelo, ano, cor };
}

// Ano para exibição curta no card: "2018/2019" → "2019" (ano-modelo).
function anoCurto(ano) {
  const m = String(ano || '').match(/(\d{4})(?:\/(\d{4}))?/);
  return m ? (m[2] || m[1]) : '';
}

module.exports = { parseVeiculoOnmotor, anoCurto };
