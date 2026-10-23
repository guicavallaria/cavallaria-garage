// Rotas do kanban de OS (montadas em /api/kanban, atrás do login do app).
// Etapa 1: leitura dos cards e da linha do tempo + sincronização manual.
const express = require('express');
const { sincronizarKanban, estadoSyncKanban } = require('./sync');
const { adquirirLock, liberarLock } = require('../patio/lock');
const { modoFonte, fonteConfigurada } = require('./fonte');
const { anoCurto } = require('../patio/veiculo');
const acoes = require('./acoes');
const linhaTempo = require('./linha-tempo');
const checklists = require('./checklists');
const pdfs = require('./pdf');
const links = require('./links');
const launch = require('./launch');
const launchFonte = require('./launch-fonte');
const arquivos = require('./arquivos');
const perfis = require('../acesso/perfis');
const auditoria = require('../acesso/auditoria');

// Login de mecânico assina tudo com o próprio nome: o operador (e o "feito por" do checklist)
// vem da sessão, nunca do que o navegador mandou. Os demais perfis são contas de setor,
// usadas por mais de uma pessoa, e continuam escolhendo o operador.
function operadorDoLogin(req, res, next) {
  const u = req.session && req.session.usuario;
  if (u && u.perfil === 'mecanico') {
    if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
      req.body.operador = u.nome;
      if ('feito_por' in req.body) req.body.feito_por = u.nome;
    }
    if (req.query && req.query.operador !== undefined) {
      Object.defineProperty(req, 'query', { value: { ...req.query, operador: u.nome }, configurable: true, writable: true });
    }
  }
  next();
}

const primeiroNome = (s) => String(s || '').trim().split(/\s+/)[0] || '';
const json = (s) => { try { return s ? JSON.parse(s) : null; } catch (_) { return null; } };

// Mecânico do card (lista de mecânicos do kanban): o escolhido no próprio card ou, na falta,
// o do painel de pátio, traduzido pelo vínculo kb_mecanicos.agenda_mecanico_id.
const SQL_CARDS = `
  SELECT c.*, f.nome AS fase_nome,
         COALESCE(kc.id, kp.id) AS mecanico_efetivo_id,
         COALESCE(kc.nome, kp.nome) AS mecanico_nome,
         (SELECT COUNT(*) FROM kb_midias md WHERE md.card_id = c.id AND md.status = 'enviado' AND md.removido_em IS NULL AND md.tipo <> 'pdf') AS qtd_midias,
         (SELECT x.status FROM kb_checklist_execucoes x JOIN kb_checklist_modelos mm ON mm.id = x.modelo_id
            WHERE x.card_id = c.id AND mm.codigo = 'entrada' ORDER BY x.id DESC LIMIT 1) AS vistoria_status,
         (SELECT COUNT(*) FROM launch_relatorios lr WHERE lr.card_id = c.id AND lr.removido_em IS NULL) AS qtd_launch
  FROM kb_cards c
  JOIN kb_fases f ON f.id = c.fase_id
  LEFT JOIN patio_vehicles pv ON pv.placa_normalizada = c.placa_normalizada AND pv.status = 'ativo'
  LEFT JOIN kb_mecanicos kc ON kc.id = c.kb_mecanico_id
  LEFT JOIN kb_mecanicos kp ON kp.agenda_mecanico_id = pv.mecanico_id AND kp.removido_em IS NULL AND c.kb_mecanico_id IS NULL`;

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
    mecanico_do_card: c.kb_mecanico_id !== null && c.kb_mecanico_id !== undefined, // false = vem do painel de pátio
    tem_chassi: Boolean(c.chassi),
    arquivado_em: c.arquivado_em,
    arquivado_por: c.arquivado_por,
    qtd_midias: c.qtd_midias || 0,
    vistoria_status: c.vistoria_status || null, // null | em_andamento | finalizado
    qtd_launch: c.qtd_launch || 0,
  };
}

// Responde a ação (síncrona ou assíncrona); ErroAcao vira o status certo, qualquer outro
// erro vira 500 sem detalhes (nada de dado de cliente no log nem na resposta).
async function responder(res, fn, log) {
  try {
    res.json(await fn());
  } catch (e) {
    if (e instanceof acoes.ErroAcao) return res.status(e.status).json({ erro: e.message, fase_id: e.fase_id });
    log('kanban: erro na ação: ' + e.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

function criarRouter({ db, broadcast = () => {}, log = console.log, criarCliente, intervaloMin = 2, storage = null, gerarPdf = null }) {
  // Geração de PDF injetável (testes usam um renderizador falso, sem Chrome).
  const gerarPdfVistoria = gerarPdf || ((execId, operador) => pdfs.naFila(() => pdfs.gerarPdfChecklist(db, storage, execId, { operador })));
  const chkHistorico = (execId, itemId) => {
    const exec = db.prepare('SELECT modelo_id FROM kb_checklist_execucoes WHERE id = ?').get(Number(execId));
    if (!exec) throw new acoes.ErroAcao(404, 'Checklist não encontrado');
    const item = checklists.itensDoModelo(checklists.carregarModelo(db, exec.modelo_id)).find((i) => i.id === Number(itemId));
    if (!item) throw new acoes.ErroAcao(404, 'Item não pertence a este checklist');
    return checklists.historicoItem(db, execId, itemId).map((h) => ({ ...h, resumo: checklists.resumoValor(item, h.valor_anterior) }));
  };
  const r = express.Router();
  r.use(operadorDoLogin);
  r.use(auditoria.middlewareKanban(db));

  // Permissões por perfil (acesso/perfis.js). Sem usuário na sessão (testes do router) passa:
  // no app, o server.js só deixa chegar aqui quem está logado.
  const exigir = (req, permissao, msg) => {
    const u = req.session && req.session.usuario;
    if (u && !perfis.pode(u, permissao)) throw new acoes.ErroAcao(403, msg);
  };
  const exigirGestor = (req) => exigir(req, 'gestor', 'Seu perfil não pode fazer isto (Recepção, Compras, Pátio ou Gerência)');
  const exigirGerencia = (req) => exigir(req, 'admin', 'Só a Gerência pode alterar isto');

  r.get('/estado', (req, res) => {
    const fases = db.prepare('SELECT id, nome FROM kb_fases ORDER BY ordem').all();
    const cards = db.prepare(`${SQL_CARDS} WHERE c.arquivado_em IS NULL ORDER BY c.fase_desde ASC`).all().map(resumoCard);
    const mecanicos = db.prepare('SELECT id, nome FROM kb_mecanicos WHERE removido_em IS NULL ORDER BY ordem, nome').all();
    res.json({
      agora: new Date().toISOString(),
      fonte: modoFonte(),
      fonte_configurada: fonteConfigurada(),
      storage_configurado: Boolean(storage && storage.configurado),
      limites: { video_max_s: linhaTempo.DURACAO_MAX_VIDEO_S, texto_max: linhaTempo.MAX_TEXTO },
      fases,
      cards,
      mecanicos,
      sync: estadoSyncKanban(db, { intervaloMin }),
      launch: launchFonte.estadoLaunch(db),
    });
  });

  r.get('/cards/:id', async (req, res) => {
    const c = db.prepare(`${SQL_CARDS} WHERE c.id = ?`).get(Number(req.params.id));
    if (!c) return res.status(404).json({ erro: 'Card não encontrado' });
    let eventos;
    try {
      eventos = await linhaTempo.listarEventos(db, storage, c.id);
    } catch (e) {
      log('kanban: erro ao montar a linha do tempo: ' + e.message);
      return res.status(500).json({ erro: 'Erro ao carregar a linha do tempo' });
    }
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

  // ---------- Etapa 3: linha do tempo (texto, foto, vídeo, áudio) ----------
  const corpo = (req) => req.body || {};

  r.post('/cards/:id/textos', (req, res) => responder(res, () => {
    const e = linhaTempo.postarTexto(db, req.params.id, { texto: corpo(req).texto, operador: corpo(req).operador });
    broadcast('kanban');
    return { ok: true, evento_id: e.id };
  }, log));

  r.put('/eventos/:id', (req, res) => responder(res, () => {
    const e = linhaTempo.editarTexto(db, req.params.id, { texto: corpo(req).texto, operador: corpo(req).operador });
    broadcast('kanban');
    return { ok: true, evento_id: e.id };
  }, log));

  r.get('/eventos/:id/versoes', (req, res) => responder(res, () => linhaTempo.versoesTexto(db, req.params.id), log));

  r.post('/eventos/:id/remover', (req, res) => responder(res, () => {
    const out = linhaTempo.removerRegistro(db, req.params.id, { operador: corpo(req).operador });
    broadcast('kanban');
    return out;
  }, log));

  // Envio de mídia em 2 passos: pedir (URL assinada) → navegador manda ao bucket → confirmar.
  r.post('/cards/:id/midias', (req, res) => responder(res, () => linhaTempo.pedirEnvio(db, storage, req.params.id, corpo(req)), log));

  r.post('/midias/:id/confirmar', (req, res) => responder(res, async () => {
    const out = await linhaTempo.confirmarEnvio(db, storage, req.params.id, { legenda: corpo(req).legenda, operador: corpo(req).operador });
    if (!out.ja_enviado) broadcast('kanban');
    return { ok: true, ...out };
  }, log));

  // ---------- Etapa 4: checklists (vistoria de entrada) e PDF ----------
  r.get('/cards/:id/checklists', (req, res) => responder(res, () => checklists.listarDoCard(db, storage, req.params.id), log));

  r.get('/checklists/modelos/:codigo', (req, res) => responder(res, () => checklists.modeloAtivo(db, req.params.codigo), log));

  r.post('/cards/:id/checklists', (req, res) => responder(res, () => {
    const b = corpo(req);
    const out = checklists.iniciar(db, req.params.id, b.codigo, { feitoPor: b.feito_por, operador: b.operador });
    if (!out.retomada) broadcast('kanban');
    return { ok: true, execucao_id: out.execucao.id, retomada: out.retomada, status: out.execucao.status };
  }, log));

  r.get('/checklists/:id', (req, res) => responder(res, () => checklists.estado(db, storage, req.params.id), log));

  r.put('/checklists/:id/respostas/:itemId', (req, res) => responder(res, () =>
    checklists.responder(db, req.params.id, req.params.itemId, { valor: corpo(req).valor, operador: corpo(req).operador }), log));

  r.post('/checklists/:id/avarias', (req, res) => responder(res, () => {
    const b = corpo(req);
    return checklists.criarAvaria(db, req.params.id, { regiao: b.regiao, descricao: b.descricao, operador: b.operador });
  }, log));

  r.post('/checklists/avarias/:id/remover', (req, res) => responder(res, () =>
    checklists.removerAvaria(db, req.params.id, { operador: corpo(req).operador }), log));

  // Finalizar gera o PDF em segundo plano; a linha do tempo recebe o PDF quando ficar pronto.
  r.post('/checklists/:id/finalizar', (req, res) => responder(res, () => {
    const op = corpo(req).operador;
    const out = checklists.finalizar(db, req.params.id, { operador: op });
    broadcast('kanban');
    if (!out.ja_finalizado) {
      Promise.resolve()
        .then(() => gerarPdfVistoria(out.execucao.id, 'Sistema'))
        .then(() => broadcast('kanban'))
        .catch((e) => log(`kanban: PDF da vistoria ${out.execucao.id} falhou: ${e.message}`));
    }
    return { ok: true, execucao_id: out.execucao.id, ja_finalizado: out.ja_finalizado };
  }, log));

  // ---------- Etapa 5: anexos e comentários por item, peças, histórico, links ----------
  r.get('/checklists/:id/itens/:itemId/historico', (req, res) => responder(res, () =>
    chkHistorico(req.params.id, req.params.itemId), log));

  r.post('/checklists/:id/itens/:itemId/comentarios', (req, res) => responder(res, () => {
    const out = checklists.comentar(db, req.params.id, req.params.itemId, { texto: corpo(req).texto, operador: corpo(req).operador });
    broadcast('kanban');
    return out;
  }, log));

  r.post('/checklists/comentarios/:id/remover', (req, res) => responder(res, () =>
    checklists.removerComentario(db, req.params.id, { operador: corpo(req).operador }), log));

  r.post('/checklists/midias/:id/remover', (req, res) => responder(res, () => {
    const out = checklists.removerMidiaItem(db, req.params.id, { operador: corpo(req).operador });
    broadcast('kanban');
    return out;
  }, log));

  r.post('/checklists/:id/pecas', (req, res) => responder(res, () => checklists.adicionarPeca(db, req.params.id, corpo(req)), log));
  r.put('/checklists/pecas/:id', (req, res) => responder(res, () => checklists.salvarPeca(db, req.params.id, corpo(req)), log));
  r.post('/checklists/pecas/:id/remover', (req, res) => responder(res, () =>
    checklists.removerPeca(db, req.params.id, { operador: corpo(req).operador }), log));

  // Link de 7 dias para mandar o PDF ao cliente (WhatsApp): gestor.
  r.post('/pdfs/:id/link', (req, res) => responder(res, () => {
    exigirGestor(req);
    const p = db.prepare('SELECT midia_id, via FROM kb_pdfs WHERE id = ?').get(Number(req.params.id));
    if (!p) throw new acoes.ErroAcao(404, 'PDF não encontrado');
    // A via orçamento (peças e horas) é interna: nunca sai por link para o cliente.
    if (p.via === 'orcamento') throw new acoes.ErroAcao(400, 'A via orçamento é de uso interno. Envie a via do cliente.');
    return links.criarLink(db, p.midia_id, { finalidade: 'pdf_cliente', operador: corpo(req).operador });
  }, log));

  // ---------- administração (mecânicos, modelos de checklist, auditoria): só Gerência ----------
  const mecanicos = require('./mecanicos');
  r.get('/admin/mecanicos', (req, res) => responder(res, () => { exigirGerencia(req); return mecanicos.listar(db, { incluirRemovidos: true }); }, log));
  r.post('/admin/mecanicos', (req, res) => responder(res, () => {
    exigirGerencia(req);
    const m = mecanicos.adicionar(db, corpo(req));
    broadcast('kanban');
    return m;
  }, log));
  r.post('/admin/mecanicos/:id/remover', (req, res) => responder(res, () => {
    exigirGerencia(req);
    const out = mecanicos.remover(db, req.params.id, corpo(req));
    broadcast('kanban');
    return out;
  }, log));

  // ---------- Etapa 6: relatórios Launch ----------
  r.get('/cards/:id/launch', (req, res) => responder(res, () => launch.listarDoCard(db, storage, req.params.id), log));

  r.get('/launch/nao-vinculados', (req, res) => responder(res, async () => ({
    estado: launchFonte.estadoLaunch(db), antigos: req.query.antigos === '1',
    relatorios: await launch.listarNaoVinculados(db, storage, { antigos: req.query.antigos === '1' }),
  }), log));

  // Vincular/desvincular à mão: gestor.
  r.post('/launch/:id/vincular', (req, res) => responder(res, () => {
    exigirGestor(req);
    const out = launch.vincularManual(db, req.params.id, corpo(req).card_id, { operador: corpo(req).operador });
    broadcast('kanban');
    return out;
  }, log));
  r.post('/launch/:id/desvincular', (req, res) => responder(res, () => {
    exigirGestor(req);
    const out = launch.desvincular(db, req.params.id, { operador: corpo(req).operador });
    broadcast('kanban');
    return out;
  }, log));

  // Envio manual de um PDF de escaneamento pelo card. O arquivo passa pela memória do
  // servidor direto para o bucket (nada em disco).
  r.post('/cards/:id/launch', express.raw({ type: ['application/pdf', 'application/octet-stream'], limit: '31mb' }), (req, res) => responder(res, async () => {
    const op = acoes.validarOperador(req.query.operador);
    const card = db.prepare('SELECT id, arquivado_em FROM kb_cards WHERE id = ?').get(Number(req.params.id));
    if (!card) throw new acoes.ErroAcao(404, 'Card não encontrado');
    if (card.arquivado_em) throw new acoes.ErroAcao(409, 'Card arquivado: desarquive para anexar');
    const out = await launch.importarRelatorio(db, storage, {
      origem: 'manual', nomeArquivo: String(req.query.nome || 'escaneamento.pdf'), bytes: Buffer.isBuffer(req.body) ? req.body : null,
      operador: op, cardId: card.id,
    });
    broadcast('kanban');
    return { ok: true, relatorio_id: out.relatorio.id };
  }, log));

  // "Buscar e-mails agora"
  r.post('/launch/sync', async (req, res) => {
    const fonte = launchFonte.criarFonte();
    if (!fonte) return res.status(503).json({ erro: 'Leitura do Gmail do Launch não configurada' });
    if (!adquirirLock(db, 'manual', 600, Date.now(), 'kb_launch_lock')) return res.status(409).json({ erro: 'Já existe uma leitura em andamento' });
    try {
      const out = await launchFonte.sincronizarLaunch(db, storage, fonte, { origem: 'manual', log, broadcast });
      res.status(out.ok ? 200 : 502).json(out);
    } finally {
      liberarLock(db, 'manual', 'kb_launch_lock');
    }
  });

  const modelos = require('./modelos');
  r.get('/admin/modelos', (req, res) => responder(res, () => (exigirGerencia(req), {
    modelos: modelos.listar(db), tipos_componente: modelos.TIPOS_COMPONENTE, tipos_secao: modelos.TIPOS_SECAO,
  }), log));
  r.get('/admin/modelos/:id', (req, res) => responder(res, () => { exigirGerencia(req); return checklists.carregarModelo(db, req.params.id); }, log));
  r.post('/admin/modelos/:codigo/versoes', (req, res) => responder(res, () => { exigirGerencia(req); return modelos.salvarNovaVersao(db, req.params.codigo, corpo(req)); }, log));
  r.post('/admin/modelos/:id/ativar', (req, res) => responder(res, () => { exigirGerencia(req); return modelos.ativarVersao(db, req.params.id, corpo(req)); }, log));

  // "Exportar PDF": gera uma versão nova agora (as anteriores ficam guardadas).
  r.post('/checklists/:id/pdf', (req, res) => responder(res, async () => {
    const op = acoes.validarOperador(corpo(req).operador);
    const out = await gerarPdfVistoria(Number(req.params.id), op);
    broadcast('kanban');
    return { ok: true, ...out };
  }, log));

  // ---------- Etapa 2: mover, arquivar, desarquivar, mecânico, busca ----------
  const porId = (id) => resumoCard(db.prepare(`${SQL_CARDS} WHERE c.id = ?`).get(id));

  r.post('/cards/:id/mover', (req, res) => responder(res, () => {
    const b = req.body || {};
    const out = acoes.moverCard(db, req.params.id, { faseId: b.fase_id, faseAtual: b.fase_atual, operador: b.operador });
    if (out.movido) broadcast('kanban');
    return { ok: true, movido: out.movido, arquivado: out.arquivado, card: porId(out.card.id) };
  }, log));

  r.post('/cards/:id/arquivar', (req, res) => responder(res, () => {
    exigirGestor(req);
    const c = acoes.arquivarCard(db, req.params.id, { operador: (req.body || {}).operador });
    broadcast('kanban');
    return { ok: true, card: porId(c.id) };
  }, log));

  r.post('/cards/:id/desarquivar', (req, res) => responder(res, () => {
    exigirGestor(req);
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

  // ---------- Etapa 7: downloads auditados, links do cliente, auditoria ----------
  // PDF (checklist ou Launch): registra quem baixou e redireciona para a URL assinada de 15 min.
  r.get('/midias/:id/abrir', async (req, res) => {
    try {
      const { url, midia } = await arquivos.urlDoPdf(db, storage, req.params.id);
      auditoria.registrar(db, {
        usuario: req.session && req.session.usuario, acao: 'pdf_aberto', cardId: midia.card_id,
        entidade: 'midias', entidadeId: midia.id, ip: req.ip,
      });
      res.redirect(302, url);
    } catch (e) {
      if (e instanceof acoes.ErroAcao) return res.status(e.status).type('text').send(e.message);
      log('kanban: erro ao abrir PDF: ' + e.message);
      res.status(500).type('text').send('Erro ao abrir o PDF');
    }
  });

  r.get('/cards/:id/links', (req, res) => responder(res, () => { exigirGestor(req); return links.linksDoCard(db, req.params.id); }, log));
  r.post('/links/:id/revogar', (req, res) => responder(res, () => {
    exigirGestor(req);
    return links.revogarLink(db, req.params.id, { operador: corpo(req).operador });
  }, log));

  r.get('/admin/auditoria', (req, res) => responder(res, () => {
    exigirGerencia(req);
    return auditoria.listar(db, { os: req.query.os, login: req.query.login, acao: req.query.acao, limite: req.query.limite });
  }, log));

  r.get('/sync/logs', (req, res) => {
    res.json(db.prepare('SELECT * FROM kb_sync_log ORDER BY id DESC LIMIT 50').all());
  });

  return r;
}

module.exports = { criarRouter, resumoCard };
