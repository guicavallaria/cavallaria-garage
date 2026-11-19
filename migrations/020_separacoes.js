// Kanban de OS — listas de separação de peças por rodada (pedido do Guilherme em 18/11/2026).
//
// Cada entrada do card em Separação/Aquisição de peças abre uma lista nova (Separação nº 1, 2, 3…),
// com as peças migradas da OS ou informadas à mão. Quando o card volta para Orçamento/Aprovação a
// lista é encerrada e fica no histórico do card (itens_json guarda como ela estava). Serviço em
// execução que precisa de peça nova passa por outra rodada sem apagar a anterior.
//
// Peças já existentes viram a "Separação nº 1" do card. Cards que estão em Entrada, Diagnóstico,
// Orçamento ou Aprovação têm essa lista encerrada aqui mesmo: eram as peças a separar que
// apareciam no Orçamento depois de o card voltar da Separação.
exports.up = (db) => {
  db.exec(`
    CREATE TABLE kb_separacoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES kb_cards(id),
      numero INTEGER NOT NULL,
      modo TEXT NOT NULL CHECK (modo IN ('os','manual','anterior')),
      fase_origem INTEGER,
      iniciada_em TEXT NOT NULL,
      iniciada_por TEXT,
      encerrada_em TEXT,
      encerrada_por TEXT,
      encerrada_motivo TEXT,
      itens_json TEXT
    );
    CREATE INDEX ix_kb_separacoes_card ON kb_separacoes(card_id, numero);
    CREATE UNIQUE INDEX ux_kb_separacoes_aberta ON kb_separacoes(card_id) WHERE encerrada_em IS NULL;
    ALTER TABLE kb_pecas ADD COLUMN separacao_id INTEGER;
  `);

  const agora = new Date().toISOString();
  const cards = db.prepare(`SELECT c.id, c.fase_id, MIN(p.criado_em) AS desde FROM kb_pecas p JOIN kb_cards c ON c.id = p.card_id
      GROUP BY c.id ORDER BY c.id`).all();
  const ins = db.prepare(`INSERT INTO kb_separacoes (card_id, numero, modo, iniciada_em, iniciada_por) VALUES (?, 1, 'anterior', ?, 'Sistema')`);
  const ligar = db.prepare('UPDATE kb_pecas SET separacao_id = ? WHERE card_id = ?');
  const itens = db.prepare('SELECT descricao, situacao, origem FROM kb_pecas WHERE separacao_id = ? AND removido_em IS NULL ORDER BY id');
  const encerrar = db.prepare(`UPDATE kb_separacoes SET encerrada_em = ?, encerrada_por = 'Sistema', encerrada_motivo = ?, itens_json = ? WHERE id = ?`);
  for (const c of cards) {
    const id = ins.run(c.id, c.desde || agora).lastInsertRowid;
    ligar.run(id, c.id);
    if ([1, 2, 3, 4].includes(c.fase_id)) {
      encerrar.run(agora, 'o card estava fora da Separação/Aquisição quando as listas por rodada começaram', JSON.stringify(itens.all(id)), id);
    }
  }

  // O Onmotor novo (no ar desde 17/11/2026 ~19h de Brasília) mudou a Via Cliente: "Informações das peças",
  // quantidade com ponto. A leitura antiga gravou '[]' nesses PDFs; NULL faz o app ler de novo do bucket
  // na primeira vez que precisar (kanban/arquivos.js → pecasDaMidia).
  db.prepare("UPDATE kb_midias SET pdf_pecas = NULL WHERE tipo = 'pdf' AND pdf_pecas = '[]' AND criado_em >= '2026-11-17T21:00:00'").run();
};

exports.down = (db) => {
  db.exec(`
    ALTER TABLE kb_pecas DROP COLUMN separacao_id;
    DROP TABLE IF EXISTS kb_separacoes;
  `);
};
