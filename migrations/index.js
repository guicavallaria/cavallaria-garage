// Runner mínimo de migrations reversíveis (up/down) para as tabelas do painel.
// Não substitui os ALTERs idempotentes do db.js — convive com eles.
// Cada arquivo migrations/NNN_nome.js exporta { up(db), down(db) }.
const fs = require('fs');
const path = require('path');

function listar(dir) {
  return fs.readdirSync(dir).filter((f) => /^\d{3}_.*\.js$/.test(f)).sort();
}

function aplicar(db, dir = __dirname) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    nome TEXT PRIMARY KEY,
    aplicada_em TEXT NOT NULL DEFAULT (datetime('now'))
  )`);
  const feitas = new Set(db.prepare('SELECT nome FROM schema_migrations').all().map((r) => r.nome));
  const aplicadas = [];
  for (const nome of listar(dir)) {
    if (feitas.has(nome)) continue;
    const m = require(path.join(dir, nome));
    db.transaction(() => {
      m.up(db);
      db.prepare('INSERT INTO schema_migrations (nome) VALUES (?)').run(nome);
    })();
    aplicadas.push(nome);
  }
  return aplicadas;
}

function reverter(db, dir = __dirname, quantas = 1) {
  const ultimas = db.prepare('SELECT nome FROM schema_migrations ORDER BY nome DESC').all().map((r) => r.nome).slice(0, quantas);
  for (const nome of ultimas) {
    const m = require(path.join(dir, nome));
    db.transaction(() => {
      m.down(db);
      db.prepare('DELETE FROM schema_migrations WHERE nome = ?').run(nome);
    })();
  }
  return ultimas;
}

module.exports = { aplicar, reverter, listar };
