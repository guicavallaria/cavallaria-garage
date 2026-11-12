// Kanban de OS — pedidos do Guilherme em 12/11/2026:
// 1) Anexo de qualquer formato no card (PDF, XML, planilha…): tipo 'arquivo' em kb_midias e kb_eventos
//    (o SQLite não altera CHECK: as duas tabelas são refeitas) + nome original do arquivo.
// 2) Orçamento com opções para o cliente (ex.: amortecedor novo x recondicionado): Orçamento 1, 2, 3…
//    kb_orcamentos.opcoes = JSON [midia_id, ...] na ordem (o 1º é o pdf_midia_id);
//    kb_orcamentos.opcao_aprovada = número (1, 2, …) escolhido na aprovação integral.
const { refazerTabela } = require('./refazer-tabela');

exports.semChavesEstrangeiras = true;

const MIDIAS_DE = "CHECK (tipo IN ('foto','video','audio','pdf'))";
const MIDIAS_PARA = "CHECK (tipo IN ('foto','video','audio','pdf','arquivo'))";
const EVENTOS_DE = "'os_finalizada_onmotor','os_alterada_onmotor')";
const EVENTOS_PARA = "'os_finalizada_onmotor','os_alterada_onmotor','arquivo')";

exports.up = (db) => {
  refazerTabela(db, 'kb_midias', MIDIAS_DE, MIDIAS_PARA);
  refazerTabela(db, 'kb_eventos', EVENTOS_DE, EVENTOS_PARA);
  db.exec(`ALTER TABLE kb_midias ADD COLUMN nome_arquivo TEXT;
           ALTER TABLE kb_orcamentos ADD COLUMN opcoes TEXT;
           ALTER TABLE kb_orcamentos ADD COLUMN opcao_aprovada INTEGER;`);
};

exports.down = (db) => {
  if (db.prepare("SELECT 1 FROM kb_midias WHERE tipo = 'arquivo'").get()) {
    throw new Error('Há anexos de arquivo no kanban: não dá para desfazer a 019 sem perder esses anexos');
  }
  db.exec(`ALTER TABLE kb_orcamentos DROP COLUMN opcao_aprovada;
           ALTER TABLE kb_orcamentos DROP COLUMN opcoes;
           ALTER TABLE kb_midias DROP COLUMN nome_arquivo;`);
  refazerTabela(db, 'kb_eventos', EVENTOS_PARA, EVENTOS_DE);
  refazerTabela(db, 'kb_midias', MIDIAS_PARA, MIDIAS_DE);
};
