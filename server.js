const express = require('express');
const path = require('path');
const os = require('os');
const session = require('express-session');
const db = require('./db');
const wa = require('./whatsapp');
wa.inicializar();

const app = express();
app.use(express.json());

// ---------- Auth ----------
app.use(session({
  secret: process.env.SESSION_SECRET || 'cavallaria-local-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 12 * 60 * 60 * 1000 }, // 12 hours
}));

app.get('/login', (req, res) => {
  if (req.session.autenticado) return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
  const senha = process.env.APP_PASSWORD || 'cavallaria2026';
  if (req.body.senha === senha) {
    req.session.autenticado = true;
    res.json({ ok: true });
  } else {
    res.status(401).json({ erro: 'Senha incorreta' });
  }
});

app.post('/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.use((req, res, next) => {
  if (req.session.autenticado) return next();
  if (req.path.startsWith('/api/')) return res.status(401).json({ erro: 'Não autenticado' });
  res.redirect('/login');
});

// Static files served only after auth check
app.use(express.static(path.join(__dirname, 'public')));

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function paraHHMM(minutos) {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function somarDias(dataISO, n) {
  const [y, m, d] = dataISO.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setDate(dt.getDate() + n);
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
}

function getConfig(chave, padrao) {
  return db.prepare('SELECT valor FROM config WHERE chave = ?').get(chave)?.valor || padrao;
}

function almocoConfig() {
  return {
    inicio: toMinutes(getConfig('pausa_almoco_inicio', '12:00')),
    fim: toMinutes(getConfig('pausa_almoco_fim', '13:30')),
  };
}

function inicioNaPausa(hora_inicio) {
  const { inicio: almocoInicio, fim: almocoFim } = almocoConfig();
  const inicio = toMinutes(hora_inicio);
  return inicio >= almocoInicio && inicio < almocoFim;
}

// Retorna os intervalos [inicioMin, fimMin) realmente ocupados por um agendamento,
// "pulando" a pausa de almoço quando a duração ultrapassa o período antes do almoço.
function segmentosOcupados(horaInicioStr, duracaoHoras) {
  const { inicio: almocoInicio, fim: almocoFim } = almocoConfig();
  const inicio = toMinutes(horaInicioStr);
  const duracaoMin = duracaoHoras * 60;
  if (inicio >= almocoFim || inicio + duracaoMin <= almocoInicio) {
    return [[inicio, inicio + duracaoMin]];
  }
  const restante = duracaoMin - (almocoInicio - inicio);
  return [
    [inicio, almocoInicio],
    [almocoFim, almocoFim + restante],
  ];
}

function fimEfetivo(horaInicioStr, duracaoHoras) {
  const segs = segmentosOcupados(horaInicioStr, duracaoHoras);
  return segs[segs.length - 1][1];
}

function segmentosSeSobrepoe(segsA, segsB) {
  for (const [aIni, aFim] of segsA) {
    for (const [bIni, bFim] of segsB) {
      if (aIni < bFim && bIni < aFim) return true;
    }
  }
  return false;
}

function findConflitos({ mecanico_id, data, hora_inicio, duracao_horas, excludeId }) {
  const rows = excludeId
    ? db.prepare('SELECT * FROM agendamentos WHERE mecanico_id = ? AND data = ? AND id != ?').all(mecanico_id, data, excludeId)
    : db.prepare('SELECT * FROM agendamentos WHERE mecanico_id = ? AND data = ?').all(mecanico_id, data);

  const segsNovo = segmentosOcupados(hora_inicio, duracao_horas);
  return rows
    .filter(
      (r) =>
        r.hora_inicio !== hora_inicio &&
        segmentosSeSobrepoe(segsNovo, segmentosOcupados(r.hora_inicio, r.duracao_horas))
    )
    .map((r) => ({ id: r.id, veiculo: r.veiculo, servico: r.servico, hora_inicio: r.hora_inicio, duracao_horas: r.duracao_horas }));
}

function criarRepeticoes(dados, nDias) {
  const insert = db.prepare(
    `INSERT INTO agendamentos (mecanico_id, veiculo, numero_os, servico, categoria, data, hora_inicio, hora_inicio_planejada, duracao_horas, observacoes, telefone, nome_cliente)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const repeticoes = [];
  for (let i = 1; i <= nDias; i++) {
    const dataRep = somarDias(dados.data, i);
    const info = insert.run(
      dados.mecanico_id, dados.veiculo, dados.numero_os || null, dados.servico, dados.categoria,
      dataRep, dados.hora_inicio, dados.hora_inicio, dados.duracao_horas, dados.observacoes || null, dados.telefone || null, dados.nome_cliente || null
    );
    repeticoes.push({ id: info.lastInsertRowid, data: dataRep });
  }
  return repeticoes;
}

function agendamentoCompletoStmt() {
  return db.prepare(`
    SELECT a.*, m.nome AS mecanico_nome, m.cor AS mecanico_cor
    FROM agendamentos a JOIN mecanicos m ON m.id = a.mecanico_id
    WHERE a.id = ?
  `);
}

// ---------- Mecânicos ----------
app.get('/api/mecanicos', (req, res) => {
  res.json(db.prepare('SELECT * FROM mecanicos WHERE ativo = 1 ORDER BY ordem, nome').all());
});

app.post('/api/mecanicos', (req, res) => {
  const { nome, cor } = req.body;
  if (!nome) return res.status(400).json({ erro: 'nome é obrigatório' });
  try {
    const { maxOrdem } = db.prepare('SELECT COALESCE(MAX(ordem), 0) AS maxOrdem FROM mecanicos').get();
    const info = db
      .prepare('INSERT INTO mecanicos (nome, cor, ordem) VALUES (?, ?, ?)')
      .run(nome, cor || '#5F5E5A', maxOrdem + 1);
    res.status(201).json(db.prepare('SELECT * FROM mecanicos WHERE id = ?').get(info.lastInsertRowid));
  } catch (e) {
    res.status(400).json({ erro: 'Já existe um mecânico com esse nome' });
  }
});

// ---------- Config ----------
app.get('/api/config', (req, res) => {
  const rows = db.prepare('SELECT * FROM config').all();
  const config = {};
  for (const r of rows) config[r.chave] = r.valor;
  res.json(config);
});

app.put('/api/config', (req, res) => {
  const upsert = db.prepare(
    'INSERT INTO config (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor'
  );
  for (const [chave, valor] of Object.entries(req.body)) upsert.run(chave, String(valor));
  res.json({ ok: true });
});

// ---------- Agendamentos ----------
app.get('/api/agendamentos', (req, res) => {
  const { data, inicio, fim } = req.query;
  let rows;
  if (data) {
    rows = db
      .prepare(
        `SELECT a.*, m.nome AS mecanico_nome, m.cor AS mecanico_cor
         FROM agendamentos a JOIN mecanicos m ON m.id = a.mecanico_id
         WHERE a.data = ? ORDER BY a.hora_inicio`
      )
      .all(data);
  } else if (inicio && fim) {
    rows = db
      .prepare(
        `SELECT a.*, m.nome AS mecanico_nome, m.cor AS mecanico_cor
         FROM agendamentos a JOIN mecanicos m ON m.id = a.mecanico_id
         WHERE a.data BETWEEN ? AND ? ORDER BY a.data, a.hora_inicio`
      )
      .all(inicio, fim);
  } else {
    rows = db
      .prepare(
        `SELECT a.*, m.nome AS mecanico_nome, m.cor AS mecanico_cor
         FROM agendamentos a JOIN mecanicos m ON m.id = a.mecanico_id
         ORDER BY a.data, a.hora_inicio`
      )
      .all();
  }
  res.json(rows);
});

app.post('/api/agendamentos', (req, res) => {
  const { mecanico_id, veiculo, numero_os, servico, categoria, data, hora_inicio, duracao_horas, observacoes, repetir_dias, telefone, nome_cliente } = req.body;
  if (!mecanico_id || !veiculo || !servico || !categoria || !data || !hora_inicio || !duracao_horas) {
    return res.status(400).json({
      erro: 'Campos obrigatórios: mecanico_id, veiculo, servico, categoria, data, hora_inicio, duracao_horas',
    });
  }
  if (inicioNaPausa(hora_inicio)) {
    return res.status(400).json({
      erro: `Não é possível iniciar um agendamento dentro da pausa de almoço (${getConfig('pausa_almoco_inicio', '12:00')}–${getConfig('pausa_almoco_fim', '13:30')}).`,
    });
  }

  const conflitos = findConflitos({ mecanico_id, data, hora_inicio, duracao_horas });

  const insert = db.prepare(
    `INSERT INTO agendamentos (mecanico_id, veiculo, numero_os, servico, categoria, data, hora_inicio, hora_inicio_planejada, duracao_horas, observacoes, telefone, nome_cliente)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const info = insert.run(mecanico_id, veiculo, numero_os || null, servico, categoria, data, hora_inicio, hora_inicio, duracao_horas, observacoes || null, telefone || null, nome_cliente || null);

  const repeticoes = criarRepeticoes(
    { mecanico_id, veiculo, numero_os, servico, categoria, data, hora_inicio, duracao_horas, observacoes, telefone, nome_cliente },
    Number(repetir_dias) || 0
  );

  broadcast();
  res.status(201).json({ agendamento: agendamentoCompletoStmt().get(info.lastInsertRowid), conflitos, repeticoes });
});

app.put('/api/agendamentos/:id/reabrir', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ erro: 'Agendamento não encontrado' });

  db.prepare('UPDATE agendamentos SET concluido = 0, hora_conclusao = NULL WHERE id = ?').run(id);
  broadcast();
  res.json({ agendamento: agendamentoCompletoStmt().get(id) });
});

app.put('/api/agendamentos/:id/adiantar-apos-conclusao', (req, res) => {
  const id = Number(req.params.id);
  const { comprimir_hoje, adiantar_amanha } = req.body;

  const concluido = db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id);
  if (!concluido || !concluido.concluido) {
    return res.status(400).json({ erro: 'Agendamento precisa estar concluído' });
  }

  const mecanico_id = concluido.mecanico_id;
  const data = concluido.data;
  const { inicio: almocoInicioMin, fim: almocoFimMin } = almocoConfig();
  const fechamentoMin = toMinutes(getConfig('hora_fechamento', '18:00'));

  function posicionar(cursor, duracaoMin) {
    let inicio = cursor >= almocoInicioMin && cursor < almocoFimMin ? almocoFimMin : cursor;
    const fim = fimEfetivo(paraHHMM(inicio), duracaoMin / 60);
    return { inicio, fim };
  }

  function minutosDisponiveis(inicioMin, fimMin) {
    let disponivel = fimMin - inicioMin;
    const sobreposIni = Math.max(inicioMin, almocoInicioMin);
    const sobreposFim = Math.min(fimMin, almocoFimMin);
    if (sobreposFim > sobreposIni) disponivel -= sobreposFim - sobreposIni;
    return disponivel;
  }

  let cursorFinal;
  const atualizadosHoje = [];

  if (comprimir_hoje) {
    const seguintes = db
      .prepare(
        'SELECT * FROM agendamentos WHERE mecanico_id = ? AND data = ? AND concluido = 0 AND hora_inicio > ? ORDER BY hora_inicio'
      )
      .all(mecanico_id, data, concluido.hora_inicio);

    const update = db.prepare('UPDATE agendamentos SET hora_inicio = ? WHERE id = ?');
    let cursor = toMinutes(concluido.hora_conclusao);
    for (const a of seguintes) {
      const { inicio, fim } = posicionar(cursor, a.duracao_horas * 60);
      const novaHora = paraHHMM(inicio);
      update.run(novaHora, a.id);
      atualizadosHoje.push({ id: a.id, hora_inicio: novaHora });
      cursor = fim;
    }
    cursorFinal = cursor;
  } else {
    const outros = db.prepare('SELECT * FROM agendamentos WHERE mecanico_id = ? AND data = ? AND id != ?').all(mecanico_id, data, id);
    cursorFinal = toMinutes(concluido.hora_conclusao);
    for (const a of outros) {
      const fimOcupado = a.concluido ? toMinutes(a.hora_conclusao) : fimEfetivo(a.hora_inicio, a.duracao_horas);
      cursorFinal = Math.max(cursorFinal, fimOcupado);
    }
  }

  let movidoAmanha = null;
  if (adiantar_amanha) {
    const vagoMin = minutosDisponiveis(cursorFinal, fechamentoMin);
    if (vagoMin > 0) {
      const dataSeguinte = somarDias(data, 1);
      const primeiro = db
        .prepare('SELECT * FROM agendamentos WHERE mecanico_id = ? AND data = ? AND concluido = 0 ORDER BY hora_inicio LIMIT 1')
        .get(mecanico_id, dataSeguinte);
      if (primeiro && primeiro.duracao_horas * 60 <= vagoMin) {
        const { inicio } = posicionar(cursorFinal, primeiro.duracao_horas * 60);
        const novaHora = paraHHMM(inicio);
        db.prepare('UPDATE agendamentos SET data = ?, hora_inicio = ? WHERE id = ?').run(data, novaHora, primeiro.id);
        movidoAmanha = { id: primeiro.id, nova_data: data, hora_inicio: novaHora };
      }
    }
  }

  broadcast();
  res.json({ atualizadosHoje, movidoAmanha });
});

app.put('/api/agendamentos/:id/concluir', (req, res) => {
  const id = Number(req.params.id);
  const { hora_conclusao } = req.body;
  if (!hora_conclusao) return res.status(400).json({ erro: 'hora_conclusao é obrigatório' });

  const existing = db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ erro: 'Agendamento não encontrado' });

  const fimPrevisto = fimEfetivo(existing.hora_inicio, existing.duracao_horas);
  const fimReal = toMinutes(hora_conclusao);
  const diferenca_minutos = fimPrevisto - fimReal; // positivo = terminou antes do previsto

  db.prepare('UPDATE agendamentos SET concluido = 1, hora_conclusao = ? WHERE id = ?').run(hora_conclusao, id);

  broadcast();
  res.json({
    agendamento: agendamentoCompletoStmt().get(id),
    status: diferenca_minutos >= 0 ? 'no_prazo' : 'atrasado',
    diferenca_minutos,
  });
});

app.put('/api/agendamentos/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM agendamentos WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ erro: 'Agendamento não encontrado' });

  const merged = { ...existing, ...req.body };
  if (inicioNaPausa(merged.hora_inicio)) {
    return res.status(400).json({
      erro: `Não é possível iniciar um agendamento dentro da pausa de almoço (${getConfig('pausa_almoco_inicio', '12:00')}–${getConfig('pausa_almoco_fim', '13:30')}).`,
    });
  }
  const conflitos = findConflitos({
    mecanico_id: merged.mecanico_id,
    data: merged.data,
    hora_inicio: merged.hora_inicio,
    duracao_horas: merged.duracao_horas,
    excludeId: id,
  });

  db.prepare(
    `UPDATE agendamentos SET mecanico_id=?, veiculo=?, numero_os=?, servico=?, categoria=?, data=?, hora_inicio=?, hora_inicio_planejada=?, duracao_horas=?, observacoes=?, telefone=?, nome_cliente=?
     WHERE id = ?`
  ).run(
    merged.mecanico_id,
    merged.veiculo,
    merged.numero_os,
    merged.servico,
    merged.categoria,
    merged.data,
    merged.hora_inicio,
    merged.hora_inicio, // edição manual rebaseia o plano original
    merged.duracao_horas,
    merged.observacoes,
    merged.telefone || null,
    merged.nome_cliente || null,
    id
  );

  const repeticoes = criarRepeticoes(merged, Number(req.body.repetir_dias) || 0);

  broadcast();
  res.json({ agendamento: agendamentoCompletoStmt().get(id), conflitos, repeticoes });
});

app.delete('/api/agendamentos/:id', (req, res) => {
  db.prepare('DELETE FROM agendamentos WHERE id = ?').run(Number(req.params.id));
  broadcast();
  res.status(204).end();
});

// ---------- Capacidade ----------
app.get('/api/capacidade', (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).json({ erro: 'parâmetro data é obrigatório' });

  const limite = Number(db.prepare('SELECT valor FROM config WHERE chave = ?').get('limite_horas_dia')?.valor || 8);
  const mecanicos = db.prepare('SELECT * FROM mecanicos WHERE ativo = 1 ORDER BY ordem, nome').all();

  const result = mecanicos.map((m) => {
    const horas = db
      .prepare('SELECT COALESCE(SUM(duracao_horas), 0) AS total FROM agendamentos WHERE mecanico_id = ? AND data = ?')
      .get(m.id, data).total;
    return {
      mecanico_id: m.id,
      nome: m.nome,
      cor: m.cor,
      horas_agendadas: horas,
      limite_horas: limite,
      percentual: limite > 0 ? Math.round((horas / limite) * 100) : 0,
      sobrecarregado: horas > limite,
    };
  });
  res.json(result);
});

// ---------- Indisponibilidades (férias / períodos indisponíveis) ----------
app.get('/api/indisponibilidades', (req, res) => {
  const { data } = req.query;
  if (data) {
    return res.json(
      db
        .prepare(
          `SELECT i.*, m.nome AS mecanico_nome
           FROM indisponibilidades i JOIN mecanicos m ON m.id = i.mecanico_id
           WHERE i.data_inicio <= ? AND i.data_fim >= ?`
        )
        .all(data, data)
    );
  }
  res.json(
    db
      .prepare(
        `SELECT i.*, m.nome AS mecanico_nome
         FROM indisponibilidades i JOIN mecanicos m ON m.id = i.mecanico_id
         ORDER BY i.data_inicio DESC`
      )
      .all()
  );
});

app.post('/api/indisponibilidades', (req, res) => {
  const { mecanico_id, data_inicio, data_fim, motivo } = req.body;
  if (!mecanico_id || !data_inicio || !data_fim) {
    return res.status(400).json({ erro: 'Campos obrigatórios: mecanico_id, data_inicio, data_fim' });
  }
  if (data_fim < data_inicio) {
    return res.status(400).json({ erro: 'Data fim não pode ser anterior à data início' });
  }
  const info = db
    .prepare('INSERT INTO indisponibilidades (mecanico_id, data_inicio, data_fim, motivo) VALUES (?, ?, ?, ?)')
    .run(mecanico_id, data_inicio, data_fim, motivo || null);
  res.status(201).json(
    db
      .prepare(
        `SELECT i.*, m.nome AS mecanico_nome FROM indisponibilidades i JOIN mecanicos m ON m.id = i.mecanico_id WHERE i.id = ?`
      )
      .get(info.lastInsertRowid)
  );
});

app.delete('/api/indisponibilidades/:id', (req, res) => {
  db.prepare('DELETE FROM indisponibilidades WHERE id = ?').run(Number(req.params.id));
  res.status(204).end();
});

// ---------- SSE (atualizações em tempo real) ----------
const sseClients = new Set();

app.get('/api/eventos', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

function broadcast() {
  for (const res of sseClients) res.write('event: atualizar\ndata: {}\n\n');
}

setInterval(() => {
  for (const res of sseClients) res.write(': keepalive\n\n');
}, 25000);

// ---------- WhatsApp ----------
app.get('/api/whatsapp/status', (req, res) => {
  res.json(wa.getStatus());
});

app.post('/api/whatsapp/reconectar', (req, res) => {
  wa.reconectar();
  res.json({ ok: true });
});

app.post('/api/whatsapp/enviar', async (req, res) => {
  const { telefone, mensagem, agendamento_id } = req.body;
  if (!telefone || !mensagem) return res.status(400).json({ erro: 'telefone e mensagem são obrigatórios' });
  try {
    await wa.enviarMensagem(telefone, mensagem);
    if (agendamento_id) {
      db.prepare("UPDATE agendamentos SET lembrete_enviado_em = datetime('now','localtime') WHERE id = ?").run(Number(agendamento_id));
      broadcast();
    }
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ erro: err.message });
  }
});

app.delete('/api/agendamentos/:id/lembrete', (req, res) => {
  db.prepare('UPDATE agendamentos SET lembrete_enviado_em = NULL WHERE id = ?').run(Number(req.params.id));
  broadcast();
  res.json({ ok: true });
});

// ---------- Avisos (recomendações a confirmar antes de salvar) ----------
function diaDaSemana(dataISO) {
  const [y, m, d] = dataISO.split('-').map(Number);
  return new Date(y, m - 1, d).getDay(); // 0=domingo ... 5=sexta ... 6=sábado
}

function calcularPascoa(ano) {
  const a = ano % 19, b = Math.floor(ano / 100), c = ano % 100;
  const d = Math.floor(b / 4), e = b % 4, f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4), k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(ano, mes - 1, dia);
}

function somarDiasData(data, n) {
  const d = new Date(data); d.setDate(d.getDate() + n); return d;
}

// tipo: 'nacional' | 'municipal' | 'facultativo'
const FERIADOS_FIXOS = {
  '01-01': { nome: 'Confraternização Universal',           tipo: 'nacional'    },
  '04-21': { nome: 'Tiradentes',                           tipo: 'nacional'    },
  '05-01': { nome: 'Dia do Trabalho',                      tipo: 'nacional'    },
  '06-29': { nome: 'São Pedro Apóstolo',                   tipo: 'municipal'   },
  '09-07': { nome: 'Independência do Brasil',              tipo: 'nacional'    },
  '10-12': { nome: 'Nossa Senhora Aparecida',              tipo: 'nacional'    },
  '10-28': { nome: 'Dia do Servidor Público',              tipo: 'facultativo' },
  '11-02': { nome: 'Finados',                              tipo: 'nacional'    },
  '11-15': { nome: 'Proclamação da República',             tipo: 'nacional'    },
  '11-20': { nome: 'Consciência Negra',                    tipo: 'nacional'    },
  '12-14': { nome: 'Emancipação Política de Pato Branco',  tipo: 'municipal'   },
  '12-24': { nome: 'Véspera de Natal',                     tipo: 'facultativo' },
  '12-25': { nome: 'Natal',                                tipo: 'nacional'    },
  '12-31': { nome: 'Véspera de Ano Novo',                  tipo: 'facultativo' },
};

const LABEL_TIPO = {
  nacional:    'Feriado Nacional',
  municipal:   'Feriado Municipal (Pato Branco)',
  facultativo: 'Ponto Facultativo',
};

function verificarDataEspecial(dataISO) {
  const [ano, mes, dia] = dataISO.split('-').map(Number);
  const dt = new Date(ano, mes - 1, dia);
  const dow = dt.getDay();

  if (dow === 0) return { tipo: 'DOMINGO',   nome: 'Domingo', mensagem: 'Esta data é um domingo.' };
  if (dow === 6) return { tipo: 'SABADO',    nome: 'Sábado',  mensagem: 'Esta data é um sábado.' };

  const mmdd = `${String(mes).padStart(2,'0')}-${String(dia).padStart(2,'0')}`;
  if (FERIADOS_FIXOS[mmdd]) {
    const { nome, tipo } = FERIADOS_FIXOS[mmdd];
    return { tipo: tipo === 'facultativo' ? 'FACULTATIVO' : 'FERIADO', subtipo: tipo, nome, mensagem: `${LABEL_TIPO[tipo]}: ${nome}.` };
  }

  // Feriados/pontos móveis baseados na Páscoa
  const pascoa = calcularPascoa(ano);
  const moveis = [
    { offset: -48, nome: 'Segunda-feira de Carnaval',  tipo: 'facultativo' },
    { offset: -47, nome: 'Terça-feira de Carnaval',    tipo: 'facultativo' },
    { offset: -46, nome: 'Quarta-feira de Cinzas',     tipo: 'facultativo' },
    { offset:  -2, nome: 'Sexta-feira da Paixão',      tipo: 'nacional'    },
    { offset:   0, nome: 'Páscoa',                     tipo: 'nacional'    },
    { offset:  60, nome: 'Corpus Christi',              tipo: 'municipal'   },
    { offset:  61, nome: 'Emenda de Corpus Christi',   tipo: 'facultativo' },
  ];
  for (const { offset, nome, tipo } of moveis) {
    const fd = somarDiasData(pascoa, offset);
    if (fd.getFullYear() === ano && fd.getMonth() === mes - 1 && fd.getDate() === dia) {
      return { tipo: tipo === 'facultativo' ? 'FACULTATIVO' : 'FERIADO', subtipo: tipo, nome, mensagem: `${LABEL_TIPO[tipo]}: ${nome}.` };
    }
  }

  return null;
}

app.get('/api/data-info', (req, res) => {
  const { data } = req.query;
  if (!data) return res.status(400).json({ erro: 'data é obrigatório' });
  res.json({ especial: verificarDataEspecial(data) });
});

app.get('/api/avisos', (req, res) => {
  const { data, categoria, mecanico_id, hora_inicio, excludeId } = req.query;
  if (!data || !categoria) return res.status(400).json({ erro: 'data e categoria são obrigatórios' });

  const avisos = [];

  if (mecanico_id && hora_inicio) {
    const { c } = excludeId
      ? db
          .prepare('SELECT COUNT(*) AS c FROM agendamentos WHERE mecanico_id = ? AND data = ? AND hora_inicio = ? AND id != ?')
          .get(Number(mecanico_id), data, hora_inicio, Number(excludeId))
      : db
          .prepare('SELECT COUNT(*) AS c FROM agendamentos WHERE mecanico_id = ? AND data = ? AND hora_inicio = ?')
          .get(Number(mecanico_id), data, hora_inicio);
    if (c > 0) {
      avisos.push({
        tipo: 'MESMO_HORARIO',
        mensagem: `Já existe${c > 1 ? `m ${c} agendamentos` : ' 1 agendamento'} para este profissional neste mesmo horário (${hora_inicio}).`,
      });
    }
  }

  if (categoria === 'Diagnóstico') {
    const { c } = excludeId
      ? db.prepare('SELECT COUNT(*) AS c FROM agendamentos WHERE data = ? AND categoria = ? AND id != ?').get(data, categoria, Number(excludeId))
      : db.prepare('SELECT COUNT(*) AS c FROM agendamentos WHERE data = ? AND categoria = ?').get(data, categoria);
    if (c > 0) {
      avisos.push({
        tipo: 'DIAGNOSTICO_MESMO_DIA',
        mensagem: `Já ${c > 1 ? `existem ${c} diagnósticos agendados` : 'existe 1 diagnóstico agendado'} para este dia. Não é recomendado agendar diagnósticos simultâneos no mesmo dia.`,
      });
    }
  }

  if (categoria === 'Revisão' && diaDaSemana(data) === 5) {
    avisos.push({
      tipo: 'REVISAO_SEXTA',
      mensagem: 'Esta data é uma sexta-feira. Não é recomendado agendar revisões nas sextas-feiras.',
    });
  }

  if (mecanico_id) {
    const indisp = db
      .prepare('SELECT * FROM indisponibilidades WHERE mecanico_id = ? AND data_inicio <= ? AND data_fim >= ?')
      .get(Number(mecanico_id), data, data);
    if (indisp) {
      avisos.push({
        tipo: 'MECANICO_INDISPONIVEL',
        mensagem: `Este profissional está marcado como indisponível neste período${indisp.motivo ? ` (${indisp.motivo})` : ''}.`,
      });
    }
  }

  res.json({ avisos });
});

function isPrivateIPv4(addr) {
  return /^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[0-1])\./.test(addr);
}

function getLanIp() {
  const interfaces = os.networkInterfaces();
  const candidatos = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) candidatos.push(iface.address);
    }
  }
  return candidatos.find(isPrivateIPv4) || candidatos[0] || 'localhost';
}

// ---------- Migração de dados ----------
app.get('/api/admin/exportar', (req, res) => {
  const mecanicos = db.prepare('SELECT * FROM mecanicos').all();
  const agendamentos = db.prepare('SELECT * FROM agendamentos').all();
  res.json({ mecanicos, agendamentos });
});

app.post('/api/admin/importar', (req, res) => {
  try {
    const { mecanicos, agendamentos } = req.body;
    if (!mecanicos || !agendamentos) return res.status(400).json({ erro: 'Dados inválidos' });

    db.exec('PRAGMA foreign_keys = OFF');
    const run = db.transaction(() => {
      db.exec('DELETE FROM agendamentos');
      db.exec('DELETE FROM mecanicos');
      const insertMec = db.prepare(
        'INSERT INTO mecanicos (id, nome, cor, ativo, ordem) VALUES (@id, @nome, @cor, @ativo, @ordem)'
      );
      const insertAg = db.prepare(`
        INSERT INTO agendamentos
        (id, mecanico_id, veiculo, numero_os, servico, categoria, data, hora_inicio, duracao_horas,
         concluido, hora_conclusao, hora_inicio_planejada, telefone, lembrete_enviado_em, observacoes, criado_em, nome_cliente)
        VALUES
        (@id, @mecanico_id, @veiculo, @numero_os, @servico, @categoria, @data, @hora_inicio, @duracao_horas,
         @concluido, @hora_conclusao, @hora_inicio_planejada, @telefone, @lembrete_enviado_em, @observacoes, @criado_em, @nome_cliente)
      `);
      for (const m of mecanicos) insertMec.run({ ordem: 0, ...m });
      for (const a of agendamentos) insertAg.run({
        numero_os: null, hora_conclusao: null, hora_inicio_planejada: null,
        telefone: null, lembrete_enviado_em: null, observacoes: null, criado_em: null, ...a,
      });
    });
    run();
    db.exec('PRAGMA foreign_keys = ON');
    res.json({ ok: true, mecanicos: mecanicos.length, agendamentos: agendamentos.length });
  } catch (err) {
    console.error('Importar erro:', err);
    res.status(500).json({ erro: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Servidor rodando em:`);
  console.log(`  Local:        http://localhost:${PORT}`);
  console.log(`  Rede (outros computadores): http://${getLanIp()}:${PORT}`);
});
