// Rotas do kanban de OS (montadas em /api/kanban, atrás do login do app).
// Etapa 1: leitura dos cards e da linha do tempo + sincronização manual.
const express = require('express');
const { sincronizarKanban, estadoSyncKanban } = require('./sync');
const { adquirirLock, liberarLock } = require('../patio/lock');
const { modoFonte, fonteConfigurada } = require('./fonte');
const { anoCurto } = require('../patio/veiculo');

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
    fase_desde: c.fase_desde,
    os_finalizada_em: c.os_finalizada_em,
    os_sumiu_em: c.os_sumiu_em,
    mecanico_id: c.mecanico_efetivo_id,
    mecanico_nome: c.mecanico_nome,
    tem_chassi: Boolean(c.chassi),
  };
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
