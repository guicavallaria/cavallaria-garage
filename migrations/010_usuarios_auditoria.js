// Etapa 7: logins individuais, sessões gravadas no banco e log de auditoria.
//
// Perfis (pedido de 23/10/2026): gerencia, recepcao, compras, patio, mecanico — ver acesso/perfis.js.
// Senhas só como hash bcrypt. Enquanto não existir nenhum usuário ativo, o login antigo
// (APP_PASSWORD) entra como Gerência, só para criar as contas; depois disso ele deixa de valer.
exports.up = (db) => {
  db.exec(`
    CREATE TABLE usuarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      login TEXT NOT NULL,
      nome TEXT NOT NULL,
      perfil TEXT NOT NULL CHECK (perfil IN ('gerencia','recepcao','compras','patio','mecanico')),
      senha_hash TEXT NOT NULL,
      trocar_senha INTEGER NOT NULL DEFAULT 1,   -- senha inicial/resetada: troca no primeiro acesso
      kb_mecanico_id INTEGER,                    -- login de mecânico ↔ mecânico do kanban
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT NOT NULL,
      criado_por TEXT NOT NULL,
      atualizado_em TEXT,
      ultimo_login_em TEXT
    );
    CREATE UNIQUE INDEX ux_usuarios_login ON usuarios(lower(login));

    -- sessões do express-session: um deploy/reinício não desloga ninguém
    CREATE TABLE sessoes (
      sid TEXT PRIMARY KEY,
      dados TEXT NOT NULL,
      expira_em INTEGER NOT NULL
    );
    CREATE INDEX ix_sessoes_expira ON sessoes(expira_em);

    -- quem fez o quê, em qual card, quando (sem dados de cliente)
    CREATE TABLE auditoria (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      quando TEXT NOT NULL,
      usuario_id INTEGER,
      usuario_login TEXT,
      operador TEXT,
      acao TEXT NOT NULL,
      card_id INTEGER,
      entidade TEXT,
      entidade_id TEXT,
      detalhes TEXT,
      ip TEXT
    );
    CREATE INDEX ix_auditoria_quando ON auditoria(quando);
    CREATE INDEX ix_auditoria_card ON auditoria(card_id, quando);
  `);
};

exports.down = (db) => {
  db.exec(`
    DROP TABLE IF EXISTS auditoria;
    DROP TABLE IF EXISTS sessoes;
    DROP TABLE IF EXISTS usuarios;
  `);
};
