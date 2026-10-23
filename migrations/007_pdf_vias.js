// Kanban de OS — PDFs das revisões em duas vias (pedido de 23/10/2026):
//   - via "orcamento": uso interno, com "Peças defeituosas" e tempos de troca em horas;
//   - via "cliente":   sem a lista de peças e sem tempos.
// A vistoria de entrada tem via "unica". Cada geração cria as vias com o mesmo número de versão.
// SQLite não altera UNIQUE: a tabela é recriada com (execucao_id, versao, via).
exports.up = (db) => {
  db.exec(`
    CREATE TABLE kb_pdfs_novo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES kb_cards(id),
      tipo TEXT NOT NULL CHECK (tipo IN ('vistoria_entrada','revisao_basica','revisao_completa')),
      via TEXT NOT NULL DEFAULT 'unica' CHECK (via IN ('unica','orcamento','cliente')),
      execucao_id INTEGER REFERENCES kb_checklist_execucoes(id),
      versao INTEGER NOT NULL,
      midia_id INTEGER NOT NULL REFERENCES kb_midias(id),
      gerado_por TEXT NOT NULL,
      gerado_em TEXT NOT NULL,
      UNIQUE (execucao_id, versao, via)
    );
    INSERT INTO kb_pdfs_novo (id, card_id, tipo, via, execucao_id, versao, midia_id, gerado_por, gerado_em)
      SELECT id, card_id, tipo, CASE tipo WHEN 'vistoria_entrada' THEN 'unica' ELSE 'orcamento' END,
             execucao_id, versao, midia_id, gerado_por, gerado_em FROM kb_pdfs;
    DROP TABLE kb_pdfs;
    ALTER TABLE kb_pdfs_novo RENAME TO kb_pdfs;
  `);
};

exports.down = (db) => {
  db.exec(`
    CREATE TABLE kb_pdfs_antigo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES kb_cards(id),
      tipo TEXT NOT NULL CHECK (tipo IN ('vistoria_entrada','revisao_basica','revisao_completa')),
      execucao_id INTEGER REFERENCES kb_checklist_execucoes(id),
      versao INTEGER NOT NULL,
      midia_id INTEGER NOT NULL REFERENCES kb_midias(id),
      gerado_por TEXT NOT NULL,
      gerado_em TEXT NOT NULL,
      UNIQUE (execucao_id, versao)
    );
    INSERT INTO kb_pdfs_antigo (id, card_id, tipo, execucao_id, versao, midia_id, gerado_por, gerado_em)
      SELECT id, card_id, tipo, execucao_id, versao, midia_id, gerado_por, gerado_em FROM kb_pdfs WHERE via <> 'cliente';
    DROP TABLE kb_pdfs;
    ALTER TABLE kb_pdfs_antigo RENAME TO kb_pdfs;
  `);
};
