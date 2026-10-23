// Rotas do kanban de OS (montadas em /api/kanban, atrás do login do app).
// Etapa 1: leitura dos cards e da linha do tempo + sincronização manual.
const express = require('express');
const { sincronizarKanban, estadoSyncKanban } = require('./sync');
const { adquirirLock, liberarLock } = require('../patio/lock');
const { modoFonte, fonteConfigurada } = require('./fonte');
const { anoCurto } = require('../patio/veiculo');
const acoes = require('./acoes');

const primeiroNome = (s) => String(s || '').trim().split(/\s+/)[0] || '';
const json = (s) => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };

// Mecânico do card: o definido no próprio card (Etapa 2) ou, na falta, o do painel de pátio.
const SQL_CARDS = `
  SELECT c.*, f.nome AS fase_nome,
         COALESCE(c.mecanico_id, pv.mecanico_id) AS mecanico_efetivo_id,
         m.nome AS mecanico_nome
  FROM kb_cards c
  JOIN kb_fases f ON f.id = c.fase_id
  LEFT JOIN patio_vehicles pv ON pv.placa_normalizada = c.placa_normalizada AND pv.status = 'ativo'
  LEFT JOIN mecanicos m ON m.id = COALESCE(c.mecanico_id, pv.mecanico_id)`;

function resumoCard(c) {
  return {
    id: c.id,
    os_numero: c.os_numero,
    placa: c.placa,
    marca: c.marca,
    modelo: c.modelo,
    ano: anoCurto(c.ano),
    primeiro_nome: primeiroNome(c.cliente_nome),
    fase_id: c.fase_id,
    fase_nome: c.fase_nome,
    fase_desde: c.fase_desde,
    os_finalizada_em: c.os_finalizada_em,
    os_sumiu_em: c.os_sumiu_em,
    mecanico_id: c.mecanico_efetivo_id,
    mecanico_nome: c.mecanico_nome,
    mecanico_do_card: c.mecanico_id !== null && c.mecanico_id !== undefined, // false = vem do painel de pátio
    tem_chassi: Boolean(c.chassi),
    arquivado_em: c.arquivado_em,
    arquivado_por: c.arquivado_por,
  };
}

// Responde a ação; ErroAcao vira o status certo, qualquer outro erro vira 500 sem detalhes do cliente.
function responder(res, fn, log) {
  try {
    res.json(fn());
  } catch (e) {
    if (e instanceof acoes.ErroAcao) return res.status(e.status).json({ erro: e.message, fase_id: e.fase_id });
    log('kanban: erro na ação: ' + e.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

function criarRouter({ db, broadcast = () => {}, log = console.log, criarCliente, intervaloMin = 2 }) {
  const r = express.Router();

  r.get('/estado', (req, res) => {
    const fases = db.prepare('SELECT id, nome FROM kb_fases ORDER BY ordem').all();
    const cards = db.prepare(`${SQL_CARDS} WHERE c.arquivado_em IS NULL ORDER BY c.fase_desde ASC`).all().map(resumoCard);
    const mecanicos = db.prepare('SELECT id, nome, cor FROM mecanicos WHERE ativo = 1 ORDER BY ordem, nome').all();
    res.json({
      agora: new Date().toISOString(),
      fonte: modoFonte(),
      fonte_configurada: fonteConfigurada(),
      fases,
      cards,
      mecanicos,
      sync: estadoSyncKanban(db, { intervaloMin }),
    });
  });

  r.get('/cards/:id', (req, res) => {
    const c = db.prepare(`${SQL_CARDS} WHERE c.id = ?`).get(Number(req.params.id));
    if (!c) return res.status(404).json({ erro: 'Card não encontrado' });
    const eventos = db.prepare(`SELECT id, tipo, texto, dados, operador_nome, criado_em, editado_em
        FROM kb_eventos WHERE card_id = ? AND removido_em IS NULL ORDER BY criado_em DESC, id DESC`).all(c.id)
      .map((e) => ({ ...e, dados: json(e.dados) }));
    res.json({
      card: {
        ...resumoCard(c),
        ano_completo: c.ano,
        chassi: c.chassi,
        km: c.km,
        cliente_nome: c.cliente_nome,
        cliente_telefone: c.cliente_telefone,
        os_entrada_em: c.os_entrada_em,
        os_etapas: json(c.os_etapas),
        veiculo_detalhes: json(c.veiculo_detalhes),
        arquivado_em: c.arquivado_em,
        arquivado_por: c.arquivado_por,
        criado_em: c.criado_em,
      },
      eventos,
    });
  });

  // ---------- Etapa 2: mover, arquivar, desarquivar, mecânico, busca ----------
  const porId = (id) => resumoCard(db.prepare(`${SQL_CARDS} WHERE c.id = ?`).get(id));

  r.post('/cards/:id/mover', (req, res) => responder(res, () => {
    const b = req.body || {};
    const out = acoes.moverCard(db, req.params.id, { faseId: b.fase_id, faseAtual: b.fase_atual, operador: b.operador });
    if (out.movido) broadcast('kanban');
    return { ok: true, movido: out.movido, arquivado: out.arquivado, card: porId(out.card.id) };
  }, log));

  r.post('/cards/:id/arquivar', (req, res) => responder(res, () => {
    const c = acoes.arquivarCard(db, req.params.id, { operador: (req.body || {}).operador });
    broadcast('kanban');
    return { ok: true, card: porId(c.id) };
  }, log));

  r.post('/cards/:id/desarquivar', (req, res) => responder(res, () => {
    const c = acoes.desarquivarCard(db, req.params.id, { operador: (req.body || {}).operador });
    broadcast('kanban');
    return { ok: true, card: porId(c.id) };
  }, log));

  r.put('/cards/:id/mecanico', (req, res) => responder(res, () => {
    const b = req.body || {};
    const c = acoes.definirMecanico(db, req.params.id, { mecanicoId: b.mecanico_id, operador: b.operador });
    broadcast('kanban');
    return { ok: true, card: porId(c.id) };
  }, log));

  r.get('/busca', (req, res) => {
    const modo = req.query.modo === 'arquivados' ? 'arquivados' : 'ativos';
    const q = String(req.query.q || '').slice(0, 80);
    const ids = acoes.buscar(db, { q, modo }).map((c) => c.id);
    const cards = ids.map(porId);
    res.json({ modo, q, total: cards.length, cards });
  });

  r.get('/operadores', (req, res) => res.json(acoes.operadoresConhecidos(db)));

  // "Sincronizar agora"
  r.post('/sync', async (req, res) => {
    const client = criarCliente({ log });
    if (!client) return res.status(503).json({ erro: 'ONMOTOR_USER/ONMOTOR_PASS não configurados' });
    const dono = 'manual';
    if (!adquirirLock(db, dono, 600, Date.now(), 'kb_sync_lock')) {
      return res.status(409).json({ erro: 'Já existe uma sincronização em andamento' });
    }
    try {
      const out = await sincronizarKanban(db, { client, origem: 'manual', broadcast, log });
      res.status(out.ok ? 200 : 502).json(out);
    } finally {
      liberarLock(db, dono, 'kb_sync_lock');
    }
  });

  r.get('/sync/logs', (req, res) => {
    res.json(db.prepare('SELECT * FROM kb_sync_log ORDER BY id DESC LIMIT 50').all());
  });

  return r;
}

module.exports = { criarRouter, resumoCard };
