// Kanban de OS — "SERVIÇO URGENTE" (pedido do Guilherme em 12/11/2026).
// Card marcado como urgente vai para o topo da coluna em qualquer fase, por cima da ordem do sistema
// (mais antigo na fase primeiro), e fica com fundo vermelho. urgente_em NULL = não urgente.
exports.up = (db) => {
  db.exec(`ALTER TABLE kb_cards ADD COLUMN urgente_em TEXT;
           ALTER TABLE kb_cards ADD COLUMN urgente_por TEXT;`);
};

exports.down = (db) => {
  db.exec(`ALTER TABLE kb_cards DROP COLUMN urgente_por;
           ALTER TABLE kb_cards DROP COLUMN urgente_em;`);
};
