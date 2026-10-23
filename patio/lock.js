// Lock em tabela para a sincronização nunca rodar em paralelo (dois ticks,
// manual + automática, ou mais de uma réplica no futuro). O `ate` expira o
// lock caso quem o pegou tenha morrido no meio (TTL em segundos).
//
// Cada job tem sua tabela de lock (uma linha, id = 1). O nome da tabela não
// vem de entrada do usuário, mas mesmo assim só aceita os nomes conhecidos.
const TABELAS = new Set(['patio_sync_lock', 'kb_sync_lock', 'kb_launch_lock']);

function tabelaValida(tabela) {
  if (!TABELAS.has(tabela)) throw new Error(`tabela de lock desconhecida: ${tabela}`);
  return tabela;
}

function adquirirLock(db, dono, ttlSegundos = 600, agoraMs = Date.now(), tabela = 'patio_sync_lock') {
  const t = tabelaValida(tabela);
  const agora = new Date(agoraMs).toISOString();
  const ate = new Date(agoraMs + ttlSegundos * 1000).toISOString();
  return db.transaction(() => {
    const atual = db.prepare(`SELECT ate FROM ${t} WHERE id = 1`).get();
    if (atual && atual.ate > agora) return false;
    db.prepare(`INSERT INTO ${t} (id, ate, dono) VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET ate = excluded.ate, dono = excluded.dono`).run(ate, dono);
    return true;
  })();
}

function liberarLock(db, dono, tabela = 'patio_sync_lock') {
  db.prepare(`DELETE FROM ${tabelaValida(tabela)} WHERE id = 1 AND dono = ?`).run(dono);
}

module.exports = { adquirirLock, liberarLock };
