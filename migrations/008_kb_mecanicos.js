// Kanban de OS — lista própria de mecânicos (pedido de 23/10/2026).
//
// O cadastro `mecanicos` é da AGENDA (colunas, inclui Estética e quem já saiu). O kanban
// passa a ter a sua lista, editável pela Gerência: Edson, Matheus, Ronaldy, Luiz e Iago.
// Cada mecânico pode estar ligado a um profissional da agenda (pelo primeiro nome), para o
// responsável definido no painel de pátio continuar aparecendo nos cards.
const MECANICOS_INICIAIS = ['Edson', 'Matheus', 'Ronaldy', 'Luiz', 'Iago'];

const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
const primeiro = (s) => semAcento(s).split(/\s+/)[0];

// Profissional ativo da agenda com o mesmo primeiro nome (só se houver exatamente um).
function acharNaAgenda(db, nome) {
  const alvo = primeiro(nome);
  const achados = db.prepare('SELECT id, nome FROM mecanicos WHERE ativo = 1').all().filter((m) => primeiro(m.nome) === alvo);
  return achados.length === 1 ? achados[0].id : null;
}

exports.MECANICOS_INICIAIS = MECANICOS_INICIAIS;
exports.acharNaAgenda = acharNaAgenda;

exports.up = (db) => {
  db.exec(`
    CREATE TABLE kb_mecanicos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      nome TEXT NOT NULL,
      ordem INTEGER NOT NULL,
      agenda_mecanico_id INTEGER REFERENCES mecanicos(id),
      criado_em TEXT NOT NULL,
      criado_por TEXT NOT NULL,
      removido_em TEXT,
      removido_por TEXT
    );
    -- um mesmo nome não pode estar ativo duas vezes; um profissional da agenda liga a um só mecânico ativo
    CREATE UNIQUE INDEX ux_kb_mecanicos_nome_ativo ON kb_mecanicos(lower(nome)) WHERE removido_em IS NULL;
    CREATE UNIQUE INDEX ux_kb_mecanicos_agenda_ativo ON kb_mecanicos(agenda_mecanico_id) WHERE removido_em IS NULL AND agenda_mecanico_id IS NOT NULL;

    -- mecânico escolhido no próprio card (substitui o uso de kb_cards.mecanico_id, que apontava para a agenda).
    -- Sem REFERENCES de propósito: o SQLite não deixa remover coluna com chave estrangeira (down).
    -- O vínculo é conferido em kanban/acoes.js (definirMecanico).
    ALTER TABLE kb_cards ADD COLUMN kb_mecanico_id INTEGER;
  `);
  const agora = new Date().toISOString();
  const ins = db.prepare(`INSERT INTO kb_mecanicos (nome, ordem, agenda_mecanico_id, criado_em, criado_por) VALUES (?, ?, ?, ?, 'migração')`);
  MECANICOS_INICIAIS.forEach((nome, i) => ins.run(nome, i + 1, acharNaAgenda(db, nome), agora));
  // Cards que já tinham mecânico escolhido (id da agenda) passam para o id do kanban, quando houver.
  db.exec(`UPDATE kb_cards SET kb_mecanico_id = (SELECT k.id FROM kb_mecanicos k WHERE k.agenda_mecanico_id = kb_cards.mecanico_id AND k.removido_em IS NULL)
           WHERE mecanico_id IS NOT NULL`);
};

exports.down = (db) => {
  db.exec(`
    ALTER TABLE kb_cards DROP COLUMN kb_mecanico_id;
    DROP INDEX IF EXISTS ux_kb_mecanicos_agenda_ativo;
    DROP INDEX IF EXISTS ux_kb_mecanicos_nome_ativo;
    DROP TABLE IF EXISTS kb_mecanicos;
  `);
};
