// Log de auditoria (seção 12): quem fez o quê, em qual card, quando — criação, mudança de
// fase, edição de checklist, arquivamento, download de PDF, login, administração.
// NUNCA grava dados de cliente: só ids, códigos e o caminho da ação.
const agoraUtc = () => new Date().toISOString();

function registrar(db, { usuario = null, operador = null, acao, cardId = null, entidade = null, entidadeId = null, detalhes = null, ip = null, quando = agoraUtc() }) {
  try {
    db.prepare(`INSERT INTO auditoria (quando, usuario_id, usuario_login, operador, acao, card_id, entidade, entidade_id, detalhes, ip)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      quando, usuario && usuario.id ? usuario.id : null, usuario ? usuario.login : null, operador ? String(operador).slice(0, 60) : null,
      acao, cardId, entidade, entidadeId === null || entidadeId === undefined ? null : String(entidadeId),
      detalhes ? JSON.stringify(detalhes) : null, ip,
    );
  } catch (_) { /* auditoria nunca derruba a ação */ }
}

// Ações do kanban: nome da ação + como achar o card a partir dos parâmetros da rota.
const ACOES = [
  [/^\/cards\/:id\/mover$/, 'fase_alterada'],
  [/^\/cards\/:id\/arquivar$/, 'card_arquivado'],
  [/^\/cards\/:id\/desarquivar$/, 'card_desarquivado'],
  [/^\/cards\/:id\/mecanico$/, 'mecanico_alterado'],
  [/^\/cards\/:id\/textos$/, 'texto_postado'],
  [/^\/cards\/:id\/midias$/, 'midia_envio_pedido'],
  [/^\/cards\/:id\/checklists$/, 'checklist_iniciado'],
  [/^\/cards\/:id\/launch$/, 'launch_enviado'],
  [/^\/eventos\/:id$/, 'texto_editado'],
  [/^\/eventos\/:id\/remover$/, 'registro_removido'],
  [/^\/midias\/:id\/confirmar$/, 'midia_enviada'],
  [/^\/checklists\/:id\/respostas\/:itemId$/, 'checklist_resposta'],
  [/^\/checklists\/:id\/finalizar$/, 'checklist_finalizado'],
  [/^\/checklists\/:id\/pdf$/, 'pdf_gerado'],
  [/^\/checklists\/:id\/avarias$/, 'avaria_registrada'],
  [/^\/checklists\/avarias\/:id\/remover$/, 'avaria_removida'],
  [/^\/checklists\/:id\/itens\/:itemId\/comentarios$/, 'checklist_comentario'],
  [/^\/checklists\/comentarios\/:id\/remover$/, 'checklist_comentario_removido'],
  [/^\/checklists\/midias\/:id\/remover$/, 'checklist_midia_removida'],
  [/^\/checklists\/:id\/pecas$/, 'peca_adicionada'],
  [/^\/checklists\/pecas\/:id$/, 'peca_alterada'],
  [/^\/checklists\/pecas\/:id\/remover$/, 'peca_removida'],
  [/^\/pdfs\/:id\/link$/, 'link_cliente_criado'],
  [/^\/links\/:id\/revogar$/, 'link_revogado'],
  [/^\/launch\/:id\/vincular$/, 'launch_vinculado'],
  [/^\/launch\/:id\/desvincular$/, 'launch_desvinculado'],
  [/^\/launch\/sync$/, 'launch_leitura_manual'],
  [/^\/sync$/, 'onmotor_sincronizacao_manual'],
  [/^\/admin\/mecanicos/, 'admin_mecanicos'],
  [/^\/admin\/modelos/, 'admin_modelos'],
  [/^\/admin\/usuarios/, 'admin_usuarios'],
];

// Card da ação, pelo tipo de recurso da rota.
function cardDaRota(db, rota, params) {
  const id = Number(params.id);
  if (!Number.isFinite(id)) return null;
  const um = (sql) => { try { const r = db.prepare(sql).get(id); return r ? r.card_id : null; } catch (_) { return null; } };
  if (rota.startsWith('/cards/')) return id;
  if (rota.startsWith('/eventos/')) return um('SELECT card_id FROM kb_eventos WHERE id = ?');
  if (rota.startsWith('/midias/') || rota.startsWith('/checklists/midias/')) return um('SELECT card_id FROM kb_midias WHERE id = ?');
  if (rota.startsWith('/checklists/avarias/')) return um('SELECT e.card_id FROM kb_checklist_avarias a JOIN kb_checklist_execucoes e ON e.id = a.execucao_id WHERE a.id = ?');
  if (rota.startsWith('/checklists/comentarios/')) return um('SELECT e.card_id FROM kb_checklist_comentarios c JOIN kb_checklist_execucoes e ON e.id = c.execucao_id WHERE c.id = ?');
  if (rota.startsWith('/checklists/pecas/')) return um('SELECT e.card_id FROM kb_checklist_pecas p JOIN kb_checklist_execucoes e ON e.id = p.execucao_id WHERE p.id = ?');
  if (rota.startsWith('/checklists/')) return um('SELECT card_id FROM kb_checklist_execucoes WHERE id = ?');
  if (rota.startsWith('/pdfs/')) return um('SELECT card_id FROM kb_pdfs WHERE id = ?');
  if (rota.startsWith('/links/')) return um('SELECT m.card_id FROM kb_links l JOIN kb_midias m ON m.id = l.midia_id WHERE l.id = ?');
  if (rota.startsWith('/launch/')) return um('SELECT card_id FROM launch_relatorios WHERE id = ?');
  return null;
}

// Só campos sem dado de cliente entram nos detalhes.
const CAMPOS_SEGUROS = ['fase_id', 'fase_atual', 'codigo', 'card_id', 'mecanico_id', 'tipo', 'perfil', 'login'];

// Middleware do router do kanban: registra toda ação que alterou algo e deu certo.
function middlewareKanban(db) {
  return (req, res, next) => {
    if (!['POST', 'PUT', 'DELETE'].includes(req.method)) return next();
    res.on('finish', () => {
      if (res.statusCode >= 400 || !req.route) return;
      const rota = req.route.path;
      const achado = ACOES.find(([rx]) => rx.test(rota));
      const corpo = req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body) ? req.body : {};
      const detalhes = { rota: `${req.method} ${rota}`, params: req.params };
      for (const k of CAMPOS_SEGUROS) if (corpo[k] !== undefined && corpo[k] !== null && typeof corpo[k] !== 'object') detalhes[k] = corpo[k];
      registrar(db, {
        usuario: req.session && req.session.usuario,
        operador: corpo.operador || (req.query && req.query.operador) || null,
        acao: achado ? achado[1] : `${req.method.toLowerCase()} ${rota}`,
        cardId: cardDaRota(db, rota, req.params),
        entidade: rota.split('/')[1] || null,
        entidadeId: req.params.id || null,
        detalhes,
        ip: req.ip,
      });
    });
    return next();
  };
}

function listar(db, { os = null, login = null, acao = null, limite = 300 } = {}) {
  const where = [];
  const args = [];
  if (os) { where.push('c.os_numero = ?'); args.push(String(os).trim()); }
  if (login) { where.push('lower(a.usuario_login) = lower(?)'); args.push(String(login).trim()); }
  if (acao) { where.push('a.acao = ?'); args.push(String(acao)); }
  return db.prepare(`SELECT a.id, a.quando, a.usuario_login, a.operador, a.acao, a.card_id, c.os_numero, a.entidade, a.entidade_id, a.detalhes, a.ip
      FROM auditoria a LEFT JOIN kb_cards c ON c.id = a.card_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.id DESC LIMIT ?`).all(...args, Math.min(Number(limite) || 300, 1000))
    .map((r) => ({ ...r, detalhes: (() => { try { return JSON.parse(r.detalhes); } catch (_) { return null; } })() }));
}

module.exports = { registrar, middlewareKanban, listar, cardDaRota, ACOES };
