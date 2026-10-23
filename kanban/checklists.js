// Execução de checklists (Etapa 4: vistoria de entrada; Etapa 5 reaproveita para as revisões).
//
// Regras gerais (seção 6 do prompt):
//  - o modelo vem do banco; a execução guarda o modelo usado;
//  - "Quem está fazendo este checklist?" fica na execução e em cada resposta;
//  - respostas são salvas item a item (nunca só no final) e a execução pode ser retomada;
//  - mídia de item fica vinculada ao item (checklist_item_id), nunca solta no card;
//  - após finalizar, alterar uma resposta guarda a versão anterior e vai para a linha do tempo.
const { ErroAcao, validarOperador } = require('./acoes');
const { formatarBR } = require('./datas');

const agoraUtc = () => new Date().toISOString();
const json = (s, padrao = null) => { try { return s ? JSON.parse(s) : padrao; } catch (_) { return padrao; } };

function cardAtivo(db, cardId) {
  const c = db.prepare('SELECT * FROM kb_cards WHERE id = ?').get(Number(cardId));
  if (!c) throw new ErroAcao(404, 'Card não encontrado');
  if (c.arquivado_em) throw new ErroAcao(409, 'Card arquivado: desarquive para registrar algo');
  return c;
}

function evento(db, cardId, tipo, texto, dados, operador, agora) {
  db.prepare(`INSERT INTO kb_eventos (card_id, tipo, texto, dados, operador_nome, criado_em) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(cardId, tipo, texto, dados ? JSON.stringify(dados) : null, operador, agora);
}

// ---------- modelo ----------
function carregarModelo(db, modeloId) {
  const modelo = db.prepare('SELECT * FROM kb_checklist_modelos WHERE id = ?').get(Number(modeloId));
  if (!modelo) throw new ErroAcao(404, 'Modelo de checklist não encontrado');
  const secoes = db.prepare('SELECT * FROM kb_checklist_secoes WHERE modelo_id = ? ORDER BY ordem').all(modelo.id);
  const itens = db.prepare(`SELECT i.* FROM kb_checklist_itens i JOIN kb_checklist_secoes s ON s.id = i.secao_id
                            WHERE s.modelo_id = ? ORDER BY s.ordem, i.ordem`).all(modelo.id);
  return {
    id: modelo.id, codigo: modelo.codigo, versao: modelo.versao, nome: modelo.nome,
    secoes: secoes.map((s) => ({
      id: s.id, ordem: s.ordem, titulo: s.titulo, tipo: s.tipo, pede_responsavel: Boolean(s.pede_responsavel),
      itens: itens.filter((i) => i.secao_id === s.id).map((i) => ({
        id: i.id, ordem: i.ordem, codigo: i.codigo, texto: i.texto, instrucao: i.instrucao, componentes: json(i.componentes, []),
      })),
    })),
  };
}

function modeloAtivo(db, codigo) {
  const m = db.prepare('SELECT id FROM kb_checklist_modelos WHERE codigo = ? AND ativo = 1 ORDER BY versao DESC LIMIT 1').get(String(codigo));
  if (!m) throw new ErroAcao(404, 'Checklist desconhecido');
  return carregarModelo(db, m.id);
}

const itensDoModelo = (modelo) => modelo.secoes.flatMap((s) => s.itens.map((i) => ({ ...i, secao: s })));

function execucaoOu404(db, execId) {
  const e = db.prepare('SELECT * FROM kb_checklist_execucoes WHERE id = ?').get(Number(execId));
  if (!e) throw new ErroAcao(404, 'Checklist não encontrado');
  return e;
}

// ---------- iniciar / retomar ----------
// Vistoria de entrada é uma por card: se já existe, devolve a mesma (retomar).
function iniciar(db, cardId, codigo, { feitoPor, operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  const quem = validarOperador(feitoPor || operador);
  return db.transaction(() => {
    const card = cardAtivo(db, cardId);
    const modelo = modeloAtivo(db, codigo);
    const existente = db.prepare(`SELECT e.* FROM kb_checklist_execucoes e JOIN kb_checklist_modelos m ON m.id = e.modelo_id
        WHERE e.card_id = ? AND m.codigo = ? ORDER BY e.id DESC LIMIT 1`).get(card.id, modelo.codigo);
    if (existente && (existente.status === 'em_andamento' || modelo.codigo === 'entrada')) {
      return { execucao: existente, retomada: true };
    }
    const id = db.prepare(`INSERT INTO kb_checklist_execucoes (card_id, modelo_id, status, feito_por, iniciado_em, iniciado_por)
      VALUES (?, ?, 'em_andamento', ?, ?, ?)`).run(card.id, modelo.id, quem, agora, op).lastInsertRowid;
    evento(db, card.id, 'checklist_iniciado', `${modelo.nome} iniciada por ${quem}`, { execucao_id: id, codigo: modelo.codigo }, op, agora);
    return { execucao: execucaoOu404(db, id), retomada: false };
  })();
}

// ---------- validação das respostas ----------
function validarValor(item, valor) {
  const v = valor && typeof valor === 'object' ? valor : {};
  const out = {};
  for (const c of item.componentes) {
    if (c.tipo === 'medida') {
      const bruto = v.medidas && v.medidas[c.rotulo];
      if (bruto === undefined || bruto === null || bruto === '') {
        if (c.obrigatorio) throw new ErroAcao(400, `Informe ${c.rotulo}`);
        continue;
      }
      const n = Number(String(bruto).replace(/\./g, '').replace(',', '.'));
      if (!Number.isFinite(n)) throw new ErroAcao(400, `${c.rotulo} precisa ser um número`);
      if (c.inteiro && !Number.isInteger(n)) throw new ErroAcao(400, `${c.rotulo} precisa ser um número inteiro`);
      if (c.min !== undefined && n < c.min) throw new ErroAcao(400, `${c.rotulo} abaixo do mínimo (${c.min})`);
      if (c.max !== undefined && n > c.max) throw new ErroAcao(400, `${c.rotulo} acima do máximo (${c.max})`);
      out.medidas = { ...(out.medidas || {}), [c.rotulo]: n };
    } else if (c.tipo === 'opcoes') {
      if (v.opcao === undefined || v.opcao === null || v.opcao === '') {
        if (c.obrigatorio) throw new ErroAcao(400, 'Escolha uma opção');
        continue;
      }
      if (!c.opcoes.includes(v.opcao)) throw new ErroAcao(400, 'Opção inválida');
      out.opcao = v.opcao;
    } else if (c.tipo === 'multipla') {
      const marcados = Array.isArray(v.marcados) ? v.marcados : [];
      if (marcados.some((m) => !c.opcoes.includes(m))) throw new ErroAcao(400, 'Item inválido na lista');
      out.marcados = c.opcoes.filter((o) => marcados.includes(o)); // ordem do modelo, sem repetição
    } else if (c.tipo === 'sim_nao') {
      if (typeof v.sim !== 'boolean') {
        if (c.obrigatorio) throw new ErroAcao(400, 'Responda Sim ou Não');
        continue;
      }
      out.sim = v.sim;
    } else if (c.tipo === 'texto') {
      const t = String(v.texto || '').trim();
      if (t.length > 1000) throw new ErroAcao(400, 'Texto muito longo');
      if (t) out.texto = t;
    }
  }
  return out;
}

// Salva (ou altera) a resposta de um item. Depois de finalizado, guarda a versão anterior.
function responder(db, execId, itemId, { valor, operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  return db.transaction(() => {
    const exec = execucaoOu404(db, execId);
    cardAtivo(db, exec.card_id);
    const modelo = carregarModelo(db, exec.modelo_id);
    const item = itensDoModelo(modelo).find((i) => i.id === Number(itemId));
    if (!item) throw new ErroAcao(404, 'Item não pertence a este checklist');
    const limpo = validarValor(item, valor);
    const novo = JSON.stringify(limpo);
    const atual = db.prepare('SELECT * FROM kb_checklist_respostas WHERE execucao_id = ? AND item_id = ?').get(exec.id, item.id);
    if (!atual) {
      db.prepare(`INSERT INTO kb_checklist_respostas (execucao_id, item_id, valor, respondido_por, respondido_em)
                  VALUES (?, ?, ?, ?, ?)`).run(exec.id, item.id, novo, op, agora);
    } else if (atual.valor !== novo) {
      if (exec.status === 'finalizado') {
        db.prepare(`INSERT INTO kb_checklist_respostas_hist (resposta_id, versao, valor_anterior, alterado_por, alterado_em)
                    VALUES (?, ?, ?, ?, ?)`).run(atual.id, atual.versao, atual.valor, op, agora);
        evento(db, exec.card_id, 'checklist_editado', `${modelo.nome}: "${item.texto}" alterado por ${op}`,
          { execucao_id: exec.id, item_id: item.id }, op, agora);
      }
      db.prepare('UPDATE kb_checklist_respostas SET valor = ?, respondido_por = ?, respondido_em = ?, versao = versao + 1 WHERE id = ?')
        .run(novo, op, agora, atual.id);
    }
    db.prepare('UPDATE kb_checklist_execucoes SET ultimo_item_id = ? WHERE id = ?').run(item.id, exec.id);
    return { item_id: item.id, valor: limpo };
  })();
}

// ---------- avarias ----------
function criarAvaria(db, execId, { regiao, descricao, operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  return db.transaction(() => {
    const exec = execucaoOu404(db, execId);
    cardAtivo(db, exec.card_id);
    const modelo = carregarModelo(db, exec.modelo_id);
    const itemAvarias = itensDoModelo(modelo).find((i) => i.componentes.some((c) => c.tipo === 'avarias'));
    if (!itemAvarias) throw new ErroAcao(400, 'Este checklist não registra avarias');
    const regioes = itemAvarias.componentes.find((c) => c.tipo === 'avarias').regioes;
    if (!regioes.includes(regiao)) throw new ErroAcao(400, 'Escolha a região da avaria');
    const desc = String(descricao || '').replace(/\s+/g, ' ').trim();
    if (desc.length < 3) throw new ErroAcao(400, 'Descreva a avaria em poucas palavras');
    if (desc.length > 300) throw new ErroAcao(400, 'Descrição muito longa (máximo 300 caracteres)');
    const ordem = db.prepare('SELECT COALESCE(MAX(ordem), 0) + 1 AS n FROM kb_checklist_avarias WHERE execucao_id = ?').get(exec.id).n;
    const id = db.prepare(`INSERT INTO kb_checklist_avarias (execucao_id, ordem, regiao, descricao, criado_por, criado_em)
      VALUES (?, ?, ?, ?, ?, ?)`).run(exec.id, ordem, regiao, desc, op, agora).lastInsertRowid;
    responder(db, exec.id, itemAvarias.id, { valor: { sim: true }, operador: op }, { agora });
    return db.prepare('SELECT * FROM kb_checklist_avarias WHERE id = ?').get(id);
  })();
}

function removerAvaria(db, avariaId, { operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  const a = db.prepare('SELECT * FROM kb_checklist_avarias WHERE id = ?').get(Number(avariaId));
  if (!a || a.removido_em) throw new ErroAcao(404, 'Avaria não encontrada');
  const exec = execucaoOu404(db, a.execucao_id);
  cardAtivo(db, exec.card_id);
  db.transaction(() => {
    db.prepare('UPDATE kb_checklist_avarias SET removido_em = ?, removido_por = ? WHERE id = ?').run(agora, op, a.id);
    db.prepare('UPDATE kb_midias SET removido_em = ?, removido_por = ? WHERE avaria_id = ? AND removido_em IS NULL').run(agora, op, a.id);
  })();
  return { ok: true };
}

// ---------- estado / pendências ----------
function midiasDaExecucao(db, execId) {
  return db.prepare(`SELECT * FROM kb_midias WHERE checklist_execucao_id = ? AND status = 'enviado' AND removido_em IS NULL
                     ORDER BY enviado_em, id`).all(Number(execId));
}

// O que ainda falta para poder finalizar (lista vazia = pode finalizar).
function pendencias(db, execId) {
  const exec = execucaoOu404(db, execId);
  const modelo = carregarModelo(db, exec.modelo_id);
  const respostas = new Map(db.prepare('SELECT item_id, valor FROM kb_checklist_respostas WHERE execucao_id = ?').all(exec.id)
    .map((r) => [r.item_id, json(r.valor, {})]));
  const midias = midiasDaExecucao(db, exec.id);
  const avarias = db.prepare('SELECT * FROM kb_checklist_avarias WHERE execucao_id = ? AND removido_em IS NULL ORDER BY ordem').all(exec.id);
  const faltas = [];

  for (const item of itensDoModelo(modelo)) {
    const r = respostas.get(item.id) || {};
    for (const c of item.componentes) {
      if (c.tipo === 'foto' && c.obrigatorio && !midias.some((m) => m.checklist_item_id === item.id && !m.avaria_id && m.tipo === 'foto')) {
        faltas.push(`Foto: ${item.texto}`);
      }
      if (c.tipo === 'medida' && c.obrigatorio && !(r.medidas && r.medidas[c.rotulo] !== undefined)) faltas.push(`${c.rotulo}: ${item.texto}`);
      if (c.tipo === 'opcoes' && c.obrigatorio && !r.opcao) faltas.push(item.texto);
      if (c.tipo === 'sim_nao' && c.obrigatorio && typeof r.sim !== 'boolean') faltas.push(item.texto);
      if (c.tipo === 'avarias' && r.sim === true) {
        if (!avarias.length) faltas.push('Avarias: respondeu Sim, mas nenhuma avaria foi registrada');
        for (const a of avarias) {
          if (!midias.some((m) => m.avaria_id === a.id)) faltas.push(`Foto da avaria ${a.ordem} (${a.regiao})`);
        }
      }
    }
  }
  return faltas;
}

function finalizar(db, execId, { operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  return db.transaction(() => {
    const exec = execucaoOu404(db, execId);
    const card = cardAtivo(db, exec.card_id);
    if (exec.status === 'finalizado') return { execucao: exec, ja_finalizado: true };
    const faltas = pendencias(db, exec.id);
    if (faltas.length) throw new ErroAcao(400, `Ainda falta: ${faltas.join('; ')}`, { pendencias: faltas });
    const modelo = carregarModelo(db, exec.modelo_id);
    db.prepare("UPDATE kb_checklist_execucoes SET status = 'finalizado', finalizado_em = ? WHERE id = ?").run(agora, exec.id);

    // Conta itens fotografados (foto refeita não conta duas vezes; foto de avaria vai nas avarias).
    const fotos = new Set(midiasDaExecucao(db, exec.id).filter((m) => m.tipo === 'foto' && !m.avaria_id).map((m) => m.checklist_item_id)).size;
    const avarias = db.prepare('SELECT COUNT(*) AS n FROM kb_checklist_avarias WHERE execucao_id = ? AND removido_em IS NULL').get(exec.id).n;
    const km = (() => {
      for (const r of db.prepare('SELECT valor FROM kb_checklist_respostas WHERE execucao_id = ?').all(exec.id)) {
        const v = json(r.valor, {});
        if (v.medidas && v.medidas.KM !== undefined) return v.medidas.KM;
      }
      return null;
    })();
    const partes = [`${fotos} foto${fotos === 1 ? '' : 's'}`, avarias ? `${avarias} avaria${avarias === 1 ? '' : 's'}` : 'nenhuma avaria'];
    if (km !== null) partes.unshift(`KM ${km.toLocaleString('pt-BR')}`);
    evento(db, card.id, 'checklist_finalizado',
      `${modelo.nome} finalizada por ${exec.feito_por} em ${formatarBR(agora)} — ${partes.join(', ')}`,
      { execucao_id: exec.id, codigo: modelo.codigo }, op, agora);
    return { execucao: execucaoOu404(db, exec.id), ja_finalizado: false };
  })();
}

// Tudo o que a tela precisa para mostrar/retomar o checklist.
async function estado(db, storage, execId) {
  const exec = execucaoOu404(db, execId);
  const modelo = carregarModelo(db, exec.modelo_id);
  const respostas = {};
  for (const r of db.prepare('SELECT item_id, valor, respondido_por, respondido_em, versao FROM kb_checklist_respostas WHERE execucao_id = ?').all(exec.id)) {
    respostas[r.item_id] = { valor: json(r.valor, {}), respondido_por: r.respondido_por, respondido_em: r.respondido_em, versao: r.versao };
  }
  const assinar = storage && storage.configurado;
  const midias = [];
  for (const m of midiasDaExecucao(db, exec.id)) {
    midias.push({
      id: m.id, tipo: m.tipo, item_id: m.checklist_item_id, avaria_id: m.avaria_id, enviado_em: m.enviado_em, autor: m.autor_nome,
      url: assinar && m.tipo !== 'pdf' ? await storage.urlVer(m.chave_objeto) : null,
      miniatura_url: assinar && m.chave_miniatura ? await storage.urlVer(m.chave_miniatura) : null,
    });
  }
  const avarias = db.prepare('SELECT id, ordem, regiao, descricao, criado_por, criado_em FROM kb_checklist_avarias WHERE execucao_id = ? AND removido_em IS NULL ORDER BY ordem').all(exec.id);
  return {
    execucao: exec,
    modelo,
    respostas,
    midias: midias.filter((m) => m.tipo !== 'pdf'),
    avarias,
    pendencias: pendencias(db, exec.id),
  };
}

// Lista resumida para o painel do card.
async function listarDoCard(db, storage, cardId) {
  const execs = db.prepare(`SELECT e.*, m.codigo, m.nome FROM kb_checklist_execucoes e JOIN kb_checklist_modelos m ON m.id = e.modelo_id
      WHERE e.card_id = ? ORDER BY e.id DESC`).all(Number(cardId));
  const out = [];
  for (const e of execs) {
    const pdfs = [];
    for (const p of db.prepare(`SELECT p.versao, p.gerado_em, p.gerado_por, md.chave_objeto FROM kb_pdfs p JOIN kb_midias md ON md.id = p.midia_id
        WHERE p.execucao_id = ? ORDER BY p.versao DESC`).all(e.id)) {
      pdfs.push({ versao: p.versao, gerado_em: p.gerado_em, gerado_por: p.gerado_por,
        url: storage && storage.configurado ? await storage.urlVer(p.chave_objeto, { nomeArquivo: `vistoria-entrada-v${p.versao}.pdf` }) : null });
    }
    out.push({ id: e.id, codigo: e.codigo, nome: e.nome, status: e.status, feito_por: e.feito_por, iniciado_em: e.iniciado_em, finalizado_em: e.finalizado_em, pdfs });
  }
  return out;
}

// Vínculo de mídia com checklist (usado no pedido de envio): confere que execução,
// item e avaria são deste card.
function validarVinculoMidia(db, cardId, { checklist_execucao_id: execId, checklist_item_id: itemId, avaria_id: avariaId }) {
  if (!execId) return null;
  const exec = execucaoOu404(db, execId);
  if (exec.card_id !== Number(cardId)) throw new ErroAcao(400, 'Checklist de outro card');
  const modelo = carregarModelo(db, exec.modelo_id);
  const item = itensDoModelo(modelo).find((i) => i.id === Number(itemId));
  if (!item) throw new ErroAcao(400, 'Item não pertence a este checklist');
  let avaria = null;
  if (avariaId) {
    avaria = db.prepare('SELECT * FROM kb_checklist_avarias WHERE id = ? AND removido_em IS NULL').get(Number(avariaId));
    if (!avaria || avaria.execucao_id !== exec.id) throw new ErroAcao(400, 'Avaria não pertence a este checklist');
  }
  return { execucao_id: exec.id, item_id: item.id, avaria_id: avaria ? avaria.id : null };
}

module.exports = {
  carregarModelo, modeloAtivo, iniciar, responder, criarAvaria, removerAvaria, pendencias, finalizar, estado,
  listarDoCard, validarVinculoMidia, midiasDaExecucao, itensDoModelo,
};
