// Banco SQLite em memória com o esquema mínimo do app + migrations do pátio.
const Database = require('better-sqlite3');
const { aplicar } = require('../../migrations');

function bancoDeTeste() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE mecanicos (
      id INTEGER PRIMARY KEY AUTOINCREMENT, nome TEXT NOT NULL UNIQUE,
      cor TEXT NOT NULL DEFAULT '#5F5E5A', ativo INTEGER NOT NULL DEFAULT 1, ordem INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE agendamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mecanico_id INTEGER NOT NULL REFERENCES mecanicos(id),
      veiculo TEXT NOT NULL, numero_os TEXT, servico TEXT NOT NULL DEFAULT 'x', categoria TEXT NOT NULL DEFAULT 'Diagnóstico',
      data TEXT NOT NULL, hora_inicio TEXT NOT NULL DEFAULT '08:00', duracao_horas REAL NOT NULL DEFAULT 1,
      observacoes TEXT, criado_em TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      concluido INTEGER NOT NULL DEFAULT 0, hora_conclusao TEXT, hora_inicio_planejada TEXT,
      telefone TEXT, lembrete_enviado_em TEXT, nome_cliente TEXT
    );
    INSERT INTO mecanicos (nome, cor, ordem) VALUES ('Luiz Paulo', '#854F0B', 0), ('Iago', '#5F5E5A', 0), ('Edson', '#3B6D11', 0);
  `);
  aplicar(db);
  return db;
}

// OS "lida do Onmotor" mínima para os testes de reconciliação/agenda.
function osLida({ osNumber, placa, modelo = 'MODELO', proprietario = 'Fulano', telefone = '(46)99999-0000', entrada = '2026-10-21 08:00', osId = null }) {
  return { osNumber: String(osNumber), osId, placa, placaTexto: placa || 'SEM PLACA', modelo, proprietario, telefone, entrada, etapas: { entrada: true, finalizado: false } };
}

module.exports = { bancoDeTeste, osLida };
