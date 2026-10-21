// Agendador in-process do sync (a cada N min, dentro da janela seg–sex 07:30–19:00).
//
// Por que in-process e não um cron/worker do Railway: o banco é SQLite num
// volume que só UM serviço pode montar — outro serviço não enxergaria os dados.
// Com uma réplica + lock em tabela (patio_sync_lock) não há execução duplicada.
const { dentroDaJanela, JANELA } = require('./tz');
const { adquirirLock, liberarLock } = require('./lock');

function criarScheduler({ db, sincronizar, intervaloMin, janela = JANELA, agoraFn = () => new Date(), log = console.log, tickMs = 60_000 }) {
  const intervalo = Number(intervaloMin || process.env.PATIO_SYNC_INTERVAL_MIN) || 30;
  let ultimaExecucaoMs = null;
  let rodando = false;
  let timer = null;
  const dono = `scheduler-${process.pid}`;

  async function tick() {
    const agora = agoraFn();
    if (!dentroDaJanela(agora, janela)) return { pulou: 'fora da janela' };
    if (ultimaExecucaoMs !== null && agora.getTime() - ultimaExecucaoMs < intervalo * 60_000) return { pulou: 'intervalo' };
    if (rodando) return { pulou: 'em andamento' };
    if (!adquirirLock(db, dono, 600, agora.getTime())) return { pulou: 'lock' };
    rodando = true;
    ultimaExecucaoMs = agora.getTime();
    try {
      return await sincronizar({ origem: 'auto' });
    } finally {
      rodando = false;
      liberarLock(db, dono);
    }
  }

  function iniciar() {
    if (timer) return;
    timer = setInterval(() => tick().catch((e) => log('patio scheduler: ' + e.message)), tickMs);
    timer.unref();
    // primeira rodada logo após subir (se estiver na janela), pra TV não ficar vazia depois de um deploy
    setTimeout(() => tick().catch((e) => log('patio scheduler: ' + e.message)), 5000).unref();
    log(`patio scheduler: a cada ${intervalo} min, dias ${janela.diasSemana.join(',')} (${janela.inicioMin / 60}h–${janela.fimMin / 60}h SP)`);
  }

  function parar() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  return { tick, iniciar, parar, intervalo, get ultimaExecucaoMs() { return ultimaExecucaoMs; } };
}

module.exports = { criarScheduler };
