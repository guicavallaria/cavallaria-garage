// Kanban de OS — "Peça chegou" na separação de peças (pedido do Guilherme em 12/11/2026).
// "Pedido feito" não quer dizer que a peça chegou: nova situação 'chegou' (com quem marcou e quando),
// e o card só sai de Aguardando Peças / Separação para frente quando nenhuma peça está pendente
// de pedido ou de chegada (kanban/acoes.js). O SQLite não altera CHECK: a tabela é refeita.
const COLUNAS = 'id, card_id, orcamento_id, descricao, origem, situacao, criado_em, criado_por, atualizado_em, atualizado_por, pedido_em, pedido_por, removido_em';

function refazer(db, situacoes, extra, selecao) {
  db.exec(`
    CREATE TABLE kb_pecas_novo (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES kb_cards(id),
      orcamento_id INTEGER REFERENCES kb_orcamentos(id),
      descricao TEXT NOT NULL,
      origem TEXT NOT NULL DEFAULT 'orcamento' CHECK (origem IN ('orcamento','manual')),
      situacao TEXT NOT NULL DEFAULT 'a_definir' CHECK (situacao IN (${situacoes.map((s) => `'${s}'`).join(',')})),
      criado_em TEXT NOT NULL,
      criado_por TEXT,
      atualizado_em TEXT,
      atualizado_por TEXT,
      pedido_em TEXT,
      pedido_por TEXT,
      removido_em TEXT${extra}
    );
    INSERT INTO kb_pecas_novo (${COLUNAS}) SELECT ${selecao} FROM kb_pecas;
    DROP TABLE kb_pecas;
    ALTER TABLE kb_pecas_novo RENAME TO kb_pecas;
    CREATE INDEX ix_kb_pecas_card ON kb_pecas(card_id, id);
    CREATE INDEX ix_kb_pecas_situacao ON kb_pecas(situacao) WHERE removido_em IS NULL;
  `);
}

exports.up = (db) => {
  refazer(db, ['a_definir', 'estoque', 'pedir', 'pedido', 'chegou', 'fora'], ',\n      chegou_em TEXT,\n      chegou_por TEXT', COLUNAS);
};

exports.down = (db) => {
  // sem a situação 'chegou', a peça que chegou volta a "pedido feito"
  refazer(db, ['a_definir', 'estoque', 'pedir', 'pedido', 'fora'], '',
    COLUNAS.replace('situacao', "CASE situacao WHEN 'chegou' THEN 'pedido' ELSE situacao END"));
};
