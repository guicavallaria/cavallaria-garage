// Mecânicos do kanban (lista própria, editável pela Gerência). Ver migrations/008_kb_mecanicos.js.
const { ErroAcao, validarOperador } = require('./acoes');
const { acharNaAgenda } = require('../migrations/008_kb_mecanicos');

const agoraUtc = () => new Date().toISOString();

function listar(db, { incluirRemovidos = false } = {}) {
  return db.prepare(`SELECT k.id, k.nome, k.ordem, k.agenda_mecanico_id, m.nome AS agenda_nome, k.criado_em, k.criado_por, k.removido_em, k.removido_por
      FROM kb_mecanicos k LEFT JOIN mecanicos m ON m.id = k.agenda_mecanico_id
      ${incluirRemovidos ? '' : 'WHERE k.removido_em IS NULL'}
      ORDER BY (k.removido_em IS NOT NULL), k.ordem, k.nome`).all();
}

function ativo(db, id) {
  return db.prepare('SELECT * FROM kb_mecanicos WHERE id = ? AND removido_em IS NULL').get(Number(id)) || null;
}

function adicionar(db, { nome, operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  const n = String(nome || '').replace(/\s+/g, ' ').trim();
  if (n.length < 2) throw new ErroAcao(400, 'Informe o nome do mecânico');
  if (n.length > 60) throw new ErroAcao(400, 'Nome muito longo');
  if (db.prepare('SELECT 1 FROM kb_mecanicos WHERE lower(nome) = lower(?) AND removido_em IS NULL').get(n)) {
    throw new ErroAcao(409, `${n} já está na lista`);
  }
  return db.transaction(() => {
    const ordem = db.prepare('SELECT COALESCE(MAX(ordem), 0) + 1 AS n FROM kb_mecanicos').get().n;
    let agendaId = acharNaAgenda(db, n);
    // o profissional da agenda já está ligado a outro mecânico ativo: não liga de novo
    if (agendaId && db.prepare('SELECT 1 FROM kb_mecanicos WHERE agenda_mecanico_id = ? AND removido_em IS NULL').get(agendaId)) agendaId = null;
    const id = db.prepare(`INSERT INTO kb_mecanicos (nome, ordem, agenda_mecanico_id, criado_em, criado_por) VALUES (?, ?, ?, ?, ?)`)
      .run(n, ordem, agendaId, agora, op).lastInsertRowid;
    return listar(db).find((m) => m.id === id);
  })();
}

// Remover não apaga: some das listas, mas os registros antigos continuam com o nome.
function remover(db, id, { operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  const m = ativo(db, id);
  if (!m) throw new ErroAcao(404, 'Mecânico não encontrado');
  db.prepare('UPDATE kb_mecanicos SET removido_em = ?, removido_por = ? WHERE id = ?').run(agora, op, m.id);
  return { ok: true };
}

module.exports = { listar, ativo, adicionar, remover };
