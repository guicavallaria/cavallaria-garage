// Datas do kanban: gravadas em UTC (ISO 8601) e exibidas em America/Sao_Paulo.
// O Onmotor fala em hora local de SP sem fuso ("2026-10-20 16:06"). O Brasil não
// tem horário de verão desde 2019, então SP é sempre UTC−03:00.
const TZ = 'America/Sao_Paulo';
const OFFSET_SP = '-03:00';

function spParaUtc(valor) {
  const m = String(valor || '').match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}:\d{2})(?::(\d{2}))?)?/);
  if (!m) return null;
  const d = new Date(`${m[1]}T${m[2] || '00:00'}:${m[3] || '00'}${OFFSET_SP}`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

const fmt = new Intl.DateTimeFormat('pt-BR', {
  timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric',
  hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
});

// "2026-10-23T14:05:00.000Z" → "23/10/2026 11:05"
function formatarBR(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const p = Object.fromEntries(fmt.formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.day}/${p.month}/${p.year} ${p.hour}:${p.minute}`;
}

module.exports = { TZ, spParaUtc, formatarBR };
