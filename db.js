const Database = require('better-sqlite3');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const db = new Database(path.join(DATA_DIR, 'agendamentos.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS mecanicos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT NOT NULL UNIQUE,
    cor TEXT NOT NULL DEFAULT '#5F5E5A',
    ativo INTEGER NOT NULL DEFAULT 1,
    ordem INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS agendamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mecanico_id INTEGER NOT NULL REFERENCES mecanicos(id),
    veiculo TEXT NOT NULL,
    numero_os TEXT,
    servico TEXT NOT NULL,
    categoria TEXT NOT NULL,
    data TEXT NOT NULL,
    hora_inicio TEXT NOT NULL,
    duracao_horas REAL NOT NULL DEFAULT 1,
    observacoes TEXT,
    criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  );

  CREATE TABLE IF NOT EXISTS config (
    chave TEXT PRIMARY KEY,
    valor TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS indisponibilidades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    mecanico_id INTEGER NOT NULL REFERENCES mecanicos(id),
    data_inicio TEXT NOT NULL,
    data_fim TEXT NOT NULL,
    motivo TEXT
  );
`);

const colunasExistentes = db.prepare('PRAGMA table_info(mecanicos)').all().map((c) => c.name);
if (!colunasExistentes.includes('ordem')) {
  db.exec('ALTER TABLE mecanicos ADD COLUMN ordem INTEGER NOT NULL DEFAULT 0');
}

const colunasAgendamentos = db.prepare('PRAGMA table_info(agendamentos)').all().map((c) => c.name);
if (!colunasAgendamentos.includes('concluido')) {
  db.exec('ALTER TABLE agendamentos ADD COLUMN concluido INTEGER NOT NULL DEFAULT 0');
}
if (!colunasAgendamentos.includes('hora_conclusao')) {
  db.exec('ALTER TABLE agendamentos ADD COLUMN hora_conclusao TEXT');
}
if (!colunasAgendamentos.includes('hora_inicio_planejada')) {
  db.exec('ALTER TABLE agendamentos ADD COLUMN hora_inicio_planejada TEXT');
  db.exec('UPDATE agendamentos SET hora_inicio_planejada = hora_inicio WHERE hora_inicio_planejada IS NULL');
}
if (!colunasAgendamentos.includes('telefone')) {
  db.exec('ALTER TABLE agendamentos ADD COLUMN telefone TEXT');
}
if (!colunasAgendamentos.includes('lembrete_enviado_em')) {
  db.exec('ALTER TABLE agendamentos ADD COLUMN lembrete_enviado_em TEXT');
}

// Remove CHECK constraint em categoria que causa problema de encoding
const agInfo = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='agendamentos'").get();
if (agInfo && agInfo.sql && agInfo.sql.includes('CHECK')) {
  db.exec('PRAGMA foreign_keys = OFF');
  db.exec(`
    CREATE TABLE IF NOT EXISTS agendamentos_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mecanico_id INTEGER NOT NULL REFERENCES mecanicos(id),
      veiculo TEXT NOT NULL,
      numero_os TEXT,
      servico TEXT NOT NULL,
      categoria TEXT NOT NULL,
      data TEXT NOT NULL,
      hora_inicio TEXT NOT NULL,
      duracao_horas REAL NOT NULL DEFAULT 1,
      observacoes TEXT,
      criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      concluido INTEGER NOT NULL DEFAULT 0,
      hora_conclusao TEXT,
      hora_inicio_planejada TEXT,
      telefone TEXT,
      lembrete_enviado_em TEXT
    );
    INSERT INTO agendamentos_new SELECT id, mecanico_id, veiculo, numero_os, servico, categoria, data, hora_inicio, duracao_horas, observacoes, criado_em, concluido, hora_conclusao, hora_inicio_planejada, telefone, lembrete_enviado_em FROM agendamentos;
    DROP TABLE agendamentos;
    ALTER TABLE agendamentos_new RENAME TO agendamentos;
  `);
  db.exec('PRAGMA foreign_keys = ON');
}

const seedMecanicos = [
  ['Anderson Cardoso De Quadra', '#185FA5', 0],
  ['Edson Antonio Benin Junior', '#3B6D11', 0],
  ['Matheus Henrique Tumeleiro', '#533AB7', 0],
  ['Luiz Paulo Cassemiro da Silva', '#854F0B', 0],
  ['Iago', '#5F5E5A', 0],
  ['Caio', '#E07B39', 1],
  ['Estética', '#C2185B', 1],
];
const insertMecanico = db.prepare('INSERT OR IGNORE INTO mecanicos (nome, cor, ordem) VALUES (?, ?, ?)');
for (const [nome, cor, ordem] of seedMecanicos) insertMecanico.run(nome, cor, ordem);

// Garante que Caio/Estética fiquem nas últimas colunas mesmo que já existissem com ordem antiga
const fixarOrdemFinal = db.prepare("UPDATE mecanicos SET ordem = 1 WHERE nome IN ('Caio', 'Estética') AND ordem != 1");
fixarOrdemFinal.run();

const seedConfig = {
  limite_horas_dia: '8',
  hora_abertura: '08:00',
  hora_fechamento: '18:00',
  pausa_almoco_inicio: '12:00',
  pausa_almoco_fim: '13:30',
};
const insertConfig = db.prepare('INSERT OR IGNORE INTO config (chave, valor) VALUES (?, ?)');
for (const [chave, valor] of Object.entries(seedConfig)) insertConfig.run(chave, valor);

module.exports = db;
