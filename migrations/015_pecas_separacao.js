// Kanban de OS — separação das peças do orçamento aprovado (pedido do Guilherme em 12/11/2026).
//
// Quando a recepção aprova o orçamento (integral ou parcial), as peças dele viram linhas de
// kb_pecas "a separar". O compras marca cada uma: tem em estoque, para pedir, pedido feito ou fora
// (o cliente não aprovou). As "para pedir" de todos os veículos formam o painel de peças pendentes
// de pedido na tela do compras.
exports.up = (db) => {
  db.exec(`
    CREATE TABLE kb_pecas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES kb_cards(id),
      orcamento_id INTEGER REFERENCES kb_orcamentos(id),
      descricao TEXT NOT NULL,
      origem TEXT NOT NULL DEFAULT 'orcamento' CHECK (origem IN ('orcamento','manual')),
      situacao TEXT NOT NULL DEFAULT 'a_definir' CHECK (situacao IN ('a_definir','estoque','pedir','pedido','fora')),
      criado_em TEXT NOT NULL,
      criado_por TEXT,
      atualizado_em TEXT,
      atualizado_por TEXT,
      pedido_em TEXT,
      pedido_por TEXT,
      removido_em TEXT
    );
    CREATE INDEX ix_kb_pecas_card ON kb_pecas(card_id, id);
    CREATE INDEX ix_kb_pecas_situacao ON kb_pecas(situacao) WHERE removido_em IS NULL;
  `);

  // Cards já aprovados no fluxo novo e ainda no setor de peças: as peças da aprovação entram "a separar".
  const ins = db.prepare("INSERT INTO kb_pecas (card_id, orcamento_id, descricao, criado_em, criado_por) VALUES (?, ?, ?, ?, 'Sistema')");
  const aprovados = db.prepare(`SELECT o.* FROM kb_orcamentos o JOIN kb_cards c ON c.id = o.card_id
      WHERE c.arquivado_em IS NULL AND c.fase_id IN (5, 10) AND o.decisao IN ('integral','parcial')
        AND o.id = (SELECT MAX(o2.id) FROM kb_orcamentos o2 WHERE o2.card_id = o.card_id)`).all();
  for (const o of aprovados) {
    let pecas = [];
    try { pecas = JSON.parse(o.pecas) || []; } catch (_) { pecas = []; }
    for (const p of pecas) if (p && p.descricao) ins.run(o.card_id, o.id, String(p.descricao).slice(0, 300), o.decidido_em || o.solicitado_em);
  }
};

exports.down = (db) => {
  db.exec('DROP TABLE IF EXISTS kb_pecas');
};
