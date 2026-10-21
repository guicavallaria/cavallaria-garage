// Lock em tabela para a sincronização nunca rodar em paralelo (dois ticks,
// manual + automática, ou mais de uma réplica no futuro). O `ate` expira o
// lock caso quem o pegou tenha morrido no meio (TTL em segundos).
function adquirirLock(db, dono, ttlSegundos = 600, agoraMs = Date.now()) {
  const agora = new Date(agoraMs).toISOString();
  const ate = new Date(agoraMs + ttlSegundos * 1000).toISOString();
  return db.transaction(() => {
    const atual = db.prepare('SELECT ate FROM patio_sync_lock WHERE id = 1').get();
    if (atual && atual.ate > agora) return false;
    db.prepare(`INSERT INTO patio_sync_lock (id, ate, dono) VALUES (1, ?, ?)
                ON CONFLICT(id) DO UPDATE SET ate = excluded.ate, dono = excluded.dono`).run(ate, dono);
    return true;
  })();
}

function liberarLock(db, dono) {
  db.prepare('DELETE FROM patio_sync_lock WHERE id = 1 AND dono = ?').run(dono);
}

module.exports = { adquirirLock, liberarLock };
