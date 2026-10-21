// Rotas do painel de pátio (montadas em /api/patio, atrás do login do app).
const express = require('express');
const { hojeSP } = require('./tz');
const { vinculosAgendaHoje, indicadores } = require('./agenda');
const { sincronizar, estadoSync } = require('./sync');
const { adquirirLock, liberarLock } = require('./lock');

const primeiroNome = (s) => String(s || '').trim().split(/\s+/)[0] || '';

// Estado completo para renderizar o painel. Não expõe telefone nem nome completo
// (a TV fica no pátio, visível a qualquer um).
function estado(db) {
  const mecanicos = db.prepare('SELECT id, nome, cor, ordem FROM mecanicos WHERE ativo = 1 ORDER BY ordem, nome').all();
  const { vinculos, veiculos } = vinculosAgendaHoje(db);
  const lista = veiculos.map((v) => {
    const ativas = v.ordens.filter((o) => !o.finished_at);
    const ag = vinculos.get(v.id);
    return {
      id: v.id,
      placa: v.placa_exibicao,
      placa_normalizada: v.placa_normalizada,
      sem_placa: v.placa_normalizada.startsWith('OS'),
      modelo: v.modelo,
      ano: v.ano,
      cor: v.cor,
      primeiro_nome: primeiroNome(v.proprietario),
      mecanico_id: v.mecanico_id,
      origem_atribuicao: v.origem_atribuicao,
      definido_pela_agenda: Boolean(ag),
      agendamento_id: ag ? ag.id : null,
      os: ativas.map((o) => o.os_number),
      entrada: ativas.map((o) => o.entrada).filter(Boolean).sort()[0] || null,
      first_seen_at: v.first_seen_at,
    };
  });
  const idsMecanicos = new Set(mecanicos.map((m) => m.id));
  const pendentes = lista.filter((v) => v.mecanico_id === null || !idsMecanicos.has(v.mecanico_id));
  return {
    hoje: hojeSP(),
    total: lista.length,
    sem_responsavel: pendentes.length,
    sync: estadoSync(db),
    mecanicos: mecanicos.map((m) => ({ ...m, veiculos: lista.filter((v) => v.mecanico_id === m.id) })),
    pendentes,
  };
}

function criarRouter({ db, broadcast, log = console.log }) {
  const r = express.Router();

  r.get('/estado', (req, res) => res.json(estado(db)));

  r.get('/indicadores', (req, res) => {
    const data = String(req.query.data || hojeSP());
    res.json({ data, hoje: hojeSP(), indicadores: indicadores(db, data) });
  });

  // "Sincronizar agora"
  r.post('/sync', async (req, res) => {
    const dono = 'manual';
    if (!adquirirLock(db, dono, 600)) return res.status(409).json({ erro: 'Já existe uma sincronização em andamento' });
    try {
      const out = await sincronizar(db, { origem: 'manual', broadcast, log });
      res.status(out.ok ? 200 : 502).json(out);
    } finally {
      liberarLock(db, dono);
    }
  });

  // Atribuir/remover responsável (só quando a agenda de hoje não define)
  r.put('/veiculos/:id/mecanico', (req, res) => {
    const id = Number(req.params.id);
    const v = db.prepare("SELECT * FROM patio_vehicles WHERE id = ? AND status = 'ativo'").get(id);
    if (!v) return res.status(404).json({ erro: 'Veículo não está no pátio' });
    const { vinculos } = vinculosAgendaHoje(db);
    if (vinculos.has(id)) {
      return res.status(409).json({ erro: 'Responsável definido pela agenda de hoje — altere na agenda', agendamento_id: vinculos.get(id).id });
    }
    const mecanico_id = req.body.mecanico_id === null || req.body.mecanico_id === undefined || req.body.mecanico_id === '' ? null : Number(req.body.mecanico_id);
    if (mecanico_id !== null && !db.prepare('SELECT 1 FROM mecanicos WHERE id = ? AND ativo = 1').get(mecanico_id)) {
      return res.status(400).json({ erro: 'Profissional inválido' });
    }
    db.prepare("UPDATE patio_vehicles SET mecanico_id = ?, origem_atribuicao = 'manual' WHERE id = ?").run(mecanico_id, id);
    broadcast('patio');
    res.json({ ok: true, mecanico_id });
  });

  r.get('/logs', (req, res) => {
    res.json(db.prepare('SELECT * FROM patio_sync_log ORDER BY id DESC LIMIT 50').all());
  });

  return r;
}

module.exports = { criarRouter, estado };
