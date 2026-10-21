// Datas/horas em America/Sao_Paulo, independentes do TZ do container
// (o Railway roda em UTC). Toda noção de "hoje" e de janela do job usa isto.
const TZ = 'America/Sao_Paulo';
const DIAS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
});

function partesSP(d = new Date()) {
  const p = Object.fromEntries(fmt.formatToParts(d).filter((x) => x.type !== 'literal').map((x) => [x.type, x.value]));
  const hora = p.hour === '24' ? '00' : p.hour;
  return {
    data: `${p.year}-${p.month}-${p.day}`,
    hora: `${hora}:${p.minute}`,
    minutos: Number(hora) * 60 + Number(p.minute),
    diaSemana: DIAS.indexOf(p.weekday), // 0=domingo … 6=sábado
    timestamp: `${p.year}-${p.month}-${p.day} ${hora}:${p.minute}:${p.second}`,
  };
}

const hojeSP = (d) => partesSP(d).data;
const agoraSP = (d) => partesSP(d).timestamp;

// Janela do job de sincronização: segunda a sexta, 07:30 (inclusive) a 19:00 (exclusive).
const JANELA = { diasSemana: [1, 2, 3, 4, 5], inicioMin: 7 * 60 + 30, fimMin: 19 * 60 };

function dentroDaJanela(d = new Date(), janela = JANELA) {
  const p = partesSP(d);
  return janela.diasSemana.includes(p.diaSemana) && p.minutos >= janela.inicioMin && p.minutos < janela.fimMin;
}

module.exports = { TZ, JANELA, partesSP, hojeSP, agoraSP, dentroDaJanela };
