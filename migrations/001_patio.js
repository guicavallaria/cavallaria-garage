// Painel de Pátio: veículos em execução (1 linha por placa ativa), OS vinculadas (1:N),
// log de sincronizações e lock do job. Também adiciona agendamentos.atualizado_em
// (necessário para "agendamento mais recente" na precedência da agenda).
function temColuna(db, tabela, coluna) {
  return db.prepare(`PRAGMA table_info(${tabela})`).all().some((c) => c.name === coluna);
}

exports.up = (db) => {
  db.exec(`
    CREATE TABLE IF NOT EXISTS patio_vehicles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      placa_normalizada TEXT NOT NULL,
      placa_exibicao TEXT NOT NULL,
      modelo TEXT,
      ano TEXT,
      cor TEXT,
      proprietario TEXT,
      telefone TEXT,
      mecanico_id INTEGER REFERENCES mecanicos(id),
      origem_atribuicao TEXT NOT NULL DEFAULT 'manual' CHECK (origem_atribuicao IN ('manual','agenda')),
      status TEXT NOT NULL DEFAULT 'ativo' CHECK (status IN ('ativo','finalizado')),
      detalhes_ok INTEGER NOT NULL DEFAULT 0,
      first_seen_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      finished_at TEXT
    );
    -- Regra absoluta de deduplicação: uma placa ativa só pode existir uma vez.
    CREATE UNIQUE INDEX IF NOT EXISTS ux_patio_vehicles_placa_ativa
      ON patio_vehicles(placa_normalizada) WHERE status = 'ativo';
    CREATE INDEX IF NOT EXISTS ix_patio_vehicles_status ON patio_vehicles(status, finished_at);

    CREATE TABLE IF NOT EXISTS patio_vehicle_orders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      vehicle_id INTEGER NOT NULL REFERENCES patio_vehicles(id) ON DELETE CASCADE,
      os_number TEXT NOT NULL,
      os_id_interno TEXT,
      entrada TEXT,
      last_seen_at TEXT NOT NULL,
      finished_at TEXT,
      UNIQUE (vehicle_id, os_number)
    );

    CREATE TABLE IF NOT EXISTS patio_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origem TEXT NOT NULL DEFAULT 'auto',
      iniciado_em TEXT NOT NULL,
      terminado_em TEXT,
      sucesso INTEGER NOT NULL DEFAULT 0,
      os_lidas INTEGER NOT NULL DEFAULT 0,
      veiculos_novos INTEGER NOT NULL DEFAULT 0,
      veiculos_finalizados INTEGER NOT NULL DEFAULT 0,
      veiculos_mantidos INTEGER NOT NULL DEFAULT 0,
      avisos TEXT,
      erro TEXT
    );

    CREATE TABLE IF NOT EXISTS patio_sync_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ate TEXT NOT NULL,
      dono TEXT
    );
  `);
  if (!temColuna(db, 'agendamentos', 'atualizado_em')) {
    db.exec('ALTER TABLE agendamentos ADD COLUMN atualizado_em TEXT');
  }
};

exports.down = (db) => {
  db.exec(`
    DROP TABLE IF EXISTS patio_sync_lock;
    DROP TABLE IF EXISTS patio_sync_log;
    DROP TABLE IF EXISTS patio_vehicle_orders;
    DROP INDEX IF EXISTS ux_patio_vehicles_placa_ativa;
    DROP INDEX IF EXISTS ix_patio_vehicles_status;
    DROP TABLE IF EXISTS patio_vehicles;
  `);
  if (temColuna(db, 'agendamentos', 'atualizado_em')) {
    db.exec('ALTER TABLE agendamentos DROP COLUMN atualizado_em');
  }
};
