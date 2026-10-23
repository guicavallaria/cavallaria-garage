// Kanban de OS — início real da OS (23/10/2026).
//
// Algumas OS no Onmotor não têm a etapa "entrada" (ex.: foram direto para orçamento ou aguardando
// peça). Sem data de entrada, o período da OS para casar relatórios Launch caía na data de criação
// do card (o dia em que o kanban entrou no ar) e recusava os escaneamentos anteriores.
// os_inicio_em = a data mais antiga entre as etapas da Novidades (entrada, orçamento, peça, execução...).
exports.up = (db) => {
  db.exec('ALTER TABLE kb_cards ADD COLUMN os_inicio_em TEXT');
};

exports.down = (db) => {
  db.exec('ALTER TABLE kb_cards DROP COLUMN os_inicio_em');
};
