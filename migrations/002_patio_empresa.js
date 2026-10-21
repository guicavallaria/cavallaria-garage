// Cada OS vinculada passa a registrar de qual Onmotor veio (cavallaria | awdyna).
// Necessário para buscar detalhes na página certa e para não finalizar veículos
// de uma empresa cujo site estava fora na leitura.
function temColuna(db, tabela, coluna) {
  return db.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === coluna);
}
exports.up = (db) => {
  if (!temColuna(db, 'patio_vehicle_orders', 'empresa')) {
    db.exec("ALTER TABLE patio_vehicle_orders ADD COLUMN empresa TEXT NOT NULL DEFAULT 'cavallaria'");
  }
};
exports.down = (db) => {
  if (temColuna(db, 'patio_vehicle_orders', 'empresa')) {
    db.exec('ALTER TABLE patio_vehicle_orders DROP COLUMN empresa');
  }
};
