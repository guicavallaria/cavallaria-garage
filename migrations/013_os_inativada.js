// Kanban de OS — OS inativada no Onmotor (03/11/2026).
//
// No Onmotor, OS inativada sai da Novidades sem ser finalizada. O card dela é arquivado sozinho
// (arquivado_motivo = 'automatico') e esta coluna guarda quando: se a OS voltar a aparecer
// (reativada), o card é desarquivado sozinho.
exports.up = (db) => {
  db.exec('ALTER TABLE kb_cards ADD COLUMN os_inativada_em TEXT');
};

exports.down = (db) => {
  db.exec('ALTER TABLE kb_cards DROP COLUMN os_inativada_em');
};
