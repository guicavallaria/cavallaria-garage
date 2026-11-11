// Kanban de OS — setor de orçamento e peças (pedido do Guilherme em 11/11/2026).
//
// - Fase nova "Aguardando Peças" (id 10), entre "Aquisição de Peças" e "Aguardando Agendamento".
//   Os ids das fases não mudam; a ordem na tela vem de kb_fases.ordem.
// - kb_cards.pecas_prazo_*: prazo em dias para a chegada das peças (pisca vencido).
// - usuarios.kb_papel: quem move cards — total, orcamento (Cauã), aprovacao (Luan) ou registro (só registra).
// - kb_orcamentos: cada entrada em Orçamento é uma solicitação com as peças pedidas, o PDF do
//   orçamento, a decisão da aprovação (integral, parcial com nova via do cliente, devolvido) e observações.
const PAPEL_POR_NOME = { guilherme: 'total', lucas: 'total', vanilton: 'total', caua: 'orcamento', luan: 'aprovacao' };
// Contas de setor e quem as usa (Guilherme, 11/11/2026): compras = Cauã, pátio = Vanilton,
// recepção = Luan, gerência = Guilherme e Lucas.
const PAPEL_POR_LOGIN = { compras: 'orcamento', patio: 'total', recepcao: 'aprovacao', gerencia: 'total' };
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();

exports.up = (db) => {
  db.exec('UPDATE kb_fases SET ordem = id * 10');
  db.prepare("INSERT INTO kb_fases (id, nome, ordem) VALUES (10, 'Aguardando Peças', 55)").run();

  db.exec(`
    ALTER TABLE kb_cards ADD COLUMN pecas_prazo_dias INTEGER;
    ALTER TABLE kb_cards ADD COLUMN pecas_prazo_em TEXT;
    ALTER TABLE usuarios ADD COLUMN kb_papel TEXT NOT NULL DEFAULT 'registro'
      CHECK (kb_papel IN ('total','orcamento','aprovacao','registro'));

    CREATE TABLE kb_orcamentos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES kb_cards(id),
      pecas TEXT NOT NULL,                 -- JSON [{descricao, origem: 'checklist'|'manual'}]
      solicitado_por TEXT,
      solicitado_em TEXT NOT NULL,
      pdf_midia_id INTEGER REFERENCES kb_midias(id),
      enviado_por TEXT,
      enviado_em TEXT,
      decisao TEXT CHECK (decisao IN ('integral','parcial','devolvido')),
      decisao_obs TEXT,
      via_cliente_midia_id INTEGER REFERENCES kb_midias(id),
      decidido_por TEXT,
      decidido_em TEXT
    );
    CREATE INDEX ix_kb_orcamentos_card ON kb_orcamentos(card_id, id);
  `);

  // Papel inicial: conta de setor pelo login, login individual pelo primeiro nome. Ajustável na Administração.
  const upd = db.prepare('UPDATE usuarios SET kb_papel = ? WHERE id = ?');
  for (const u of db.prepare('SELECT id, login, nome FROM usuarios').all()) {
    const login = semAcento(u.login);
    const papel = PAPEL_POR_LOGIN[login] || PAPEL_POR_NOME[semAcento(u.nome).split(/\s+/)[0]] || PAPEL_POR_NOME[login];
    if (papel) upd.run(papel, u.id);
  }
};

exports.down = (db) => {
  db.exec(`
    DROP TABLE IF EXISTS kb_orcamentos;
    ALTER TABLE usuarios DROP COLUMN kb_papel;
    ALTER TABLE kb_cards DROP COLUMN pecas_prazo_em;
    ALTER TABLE kb_cards DROP COLUMN pecas_prazo_dias;
  `);
  db.prepare("UPDATE kb_cards SET fase_id = 5 WHERE fase_id = 10").run();
  db.prepare('DELETE FROM kb_fases WHERE id = 10').run();
  db.exec('UPDATE kb_fases SET ordem = id');
};

exports.PAPEL_POR_NOME = PAPEL_POR_NOME;
