// Kanban de OS — AWDYNA no mesmo quadro da Cavallaria (30/10/2026).
//
// Os cards já são por empresa (UNIQUE empresa + os_numero): um veículo com OS nas duas empresas
// fica com um card em cada uma. Falta só o log de sincronização saber de qual empresa é cada
// rodada, para o aviso "sincronização parada" dizer qual das duas parou.
exports.up = (db) => {
  db.exec("ALTER TABLE kb_sync_log ADD COLUMN empresa TEXT NOT NULL DEFAULT 'cavallaria'");
};

exports.down = (db) => {
  db.exec('ALTER TABLE kb_sync_log DROP COLUMN empresa');
};
