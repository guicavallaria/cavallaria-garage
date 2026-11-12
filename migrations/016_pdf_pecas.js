// Peças lidas do PDF de orçamento do Onmotor (kanban/orcamento-pdf.js), pedido do Guilherme em 12/11/2026.
// kb_midias.pdf_pecas: JSON [{codigo, descricao, quantidade, unidade}] — NULL = ainda não lido; '[]' = lido, sem peças.
exports.up = (db) => {
  db.exec('ALTER TABLE kb_midias ADD COLUMN pdf_pecas TEXT');
};

exports.down = (db) => {
  db.exec('ALTER TABLE kb_midias DROP COLUMN pdf_pecas');
};
