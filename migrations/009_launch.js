// Kanban de OS — Etapa 6: relatórios de escaneamento LAUNCH (seção 11 do prompt).
//
// launch_emails: cada e-mail lido do Gmail (controle por message_id: nunca processa duas vezes).
// launch_relatorios: cada PDF (do e-mail ou enviado à mão), com marca e chassi tirados do nome
// do arquivo (Marca_Chassi_AllSystems…pdf). card_id NULL = "Relatórios não vinculados".
// O PDF fica no bucket (kb_midias, tipo 'pdf', sem card enquanto não vincula).
exports.up = (db) => {
  db.exec(`
    CREATE TABLE launch_emails (
      message_id TEXT PRIMARY KEY,
      recebido_em TEXT NOT NULL,
      assunto TEXT,
      remetente TEXT,
      processado_em TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('ok','sem_anexo','ignorado','erro')),
      anexos INTEGER NOT NULL DEFAULT 0,
      erro TEXT
    );

    CREATE TABLE launch_relatorios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origem TEXT NOT NULL CHECK (origem IN ('email','manual')),
      message_id TEXT,  -- e-mail de origem (o registro em launch_emails entra depois, ao fim do e-mail)
      nome_arquivo TEXT NOT NULL,
      marca TEXT,
      chassi TEXT,
      relatorio_em TEXT NOT NULL,
      midia_id INTEGER NOT NULL REFERENCES kb_midias(id),
      card_id INTEGER REFERENCES kb_cards(id),
      principal INTEGER NOT NULL DEFAULT 0,
      vinculado_em TEXT,
      vinculado_por TEXT,
      criado_em TEXT NOT NULL,
      criado_por TEXT NOT NULL,
      removido_em TEXT,
      removido_por TEXT,
      UNIQUE (message_id, nome_arquivo)
    );
    CREATE INDEX ix_launch_chassi ON launch_relatorios(chassi);
    CREATE INDEX ix_launch_card ON launch_relatorios(card_id);

    CREATE TABLE kb_launch_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ate TEXT NOT NULL,
      dono TEXT
    );

    CREATE TABLE launch_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origem TEXT NOT NULL,
      iniciado_em TEXT NOT NULL,
      terminado_em TEXT,
      sucesso INTEGER NOT NULL DEFAULT 0,
      emails_lidos INTEGER NOT NULL DEFAULT 0,
      relatorios_novos INTEGER NOT NULL DEFAULT 0,
      vinculados INTEGER NOT NULL DEFAULT 0,
      erro TEXT
    );
  `);
};

exports.down = (db) => {
  db.exec(`
    DROP TABLE IF EXISTS launch_sync_log;
    DROP TABLE IF EXISTS kb_launch_lock;
    DROP TABLE IF EXISTS launch_relatorios;
    DROP TABLE IF EXISTS launch_emails;
  `);
};
