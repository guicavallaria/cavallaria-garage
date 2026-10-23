// Kanban de OS — Etapa 3: metadados das mídias (o arquivo em si fica no bucket S3).
//
// Fluxo: o navegador pede o envio (linha 'pendente' + URL assinada), manda o arquivo
// direto ao bucket e confirma; o servidor confere no bucket e só então publica na linha
// do tempo ('enviado'). `cliente_id` é gerado no aparelho: se o envio cair no meio e for
// retomado, o pedido devolve a mesma mídia com URLs novas, sem duplicar.
exports.up = (db) => {
  db.exec(`
    CREATE TABLE kb_midias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cliente_id TEXT NOT NULL UNIQUE,
      chave_objeto TEXT NOT NULL UNIQUE,
      chave_miniatura TEXT UNIQUE,         -- foto/vídeo: miniatura gerada no aparelho
      tipo TEXT NOT NULL CHECK (tipo IN ('foto','video','audio','pdf')),
      mime TEXT NOT NULL,
      tamanho_bytes INTEGER,
      duracao_s REAL,
      largura INTEGER,
      altura INTEGER,
      legenda TEXT,
      card_id INTEGER REFERENCES kb_cards(id),
      checklist_execucao_id INTEGER,       -- Etapas 4 e 5
      checklist_item_id INTEGER,           -- mídia de item de checklist nunca fica solta no card
      avaria_id INTEGER,
      status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviado','falhou')),
      autor_nome TEXT NOT NULL,
      usuario_id INTEGER,
      criado_em TEXT NOT NULL,
      enviado_em TEXT,
      removido_em TEXT,
      removido_por TEXT
    );
    CREATE INDEX ix_kb_midias_card ON kb_midias(card_id, status);
    CREATE INDEX ix_kb_midias_item ON kb_midias(checklist_execucao_id, checklist_item_id);
  `);
};

exports.down = (db) => {
  db.exec('DROP TABLE IF EXISTS kb_midias;');
};
