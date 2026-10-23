// Execução de checklists: vistoria de entrada (Etapa 4) e revisões básica/completa (Etapa 5).
//
// Regras gerais (seção 6 do prompt):
//  - o modelo vem do banco; a execução guarda o modelo usado;
//  - "Quem está fazendo este checklist?" fica na execução e em cada resposta;
//  - respostas são salvas item a item (nunca só no final) e a execução pode ser retomada;
//  - cada item aceita foto, vídeo ou comentário, sempre presos ao item (checklist_item_id);
//  - depois de finalizado, toda alteração (resposta, mídia, comentário, peça) guarda o
//    anterior, o operador e a hora, e vai para a linha do tempo do card.
const { ErroAcao, validarOperador } = require('./acoes');
const { formatarBR } = require('./datas');

const agoraUtc = () => new Date().toISOString();
const json = (s, padrao = null) => { try { return s ? JSON.parse(s) : padrao; } catch (_) { return padrao; } };

const ESTADOS = {
  troca: { bom: 'Bom', regular: 'Regular', troca: 'Necessita troca' },
  reparo: { bom: 'Bom', regular: 'Regular', reparo: 'Necessita reparo' },
};
const MAX_COMENTARIO = 1000;

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

function itemDaExecucao(db, exec, itemId) {
  const item = itensDoModelo(carregarModelo(db, exec.modelo_id)).find((i) => i.id === Number(itemId));
  if (!item) throw new ErroAcao(404, 'Item não pertence a este checklist');
  return item;
}

// Depois de finalizado, qualquer alteração vai para a linha do tempo.
function registrarEdicao(db, exec, texto, operador, agora, dados = {}) {
  if (exec.status !== 'finalizado') return;
  const modelo = db.prepare('SELECT nome FROM kb_checklist_modelos WHERE id = ?').get(exec.modelo_id);
  evento(db, exec.card_id, 'checklist_editado', `${modelo.nome}: ${texto}`, { execucao_id: exec.id, ...dados }, operador, agora);
}

// ---------- iniciar / retomar ----------
// Vistoria de entrada: uma por card (iniciar de novo abre a mesma).
// Revisões: retoma a que estiver em andamento; senão começa uma nova.
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
    evento(db, card.id, 'checklist_iniciado', `${modelo.nome} iniciad${modelo.codigo === 'entrada' ? 'a' : 'o'} por ${quem}`,
      { execucao_id: id, codigo: modelo.codigo }, op, agora);
    return { execucao: execucaoOu404(db, id), retomada: false };
  })();
}

// ---------- validação das respostas ----------
function numero(bruto, c) {
  const s = String(bruto).trim();
  // "87.450" (milhar) → 87450; "0,8" (decimal) → 0.8
  const n = Number(c.inteiro ? s.replace(/\./g, '').replace(',', '.') : s.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
  if (!Number.isFinite(n)) throw new ErroAcao(400, `${c.rotulo} precisa ser um número`);
  if (c.inteiro && !Number.isInteger(n)) throw new ErroAcao(400, `${c.rotulo} precisa ser um número inteiro`);
  if (c.min !== undefined && n < c.min) throw new ErroAcao(400, `${c.rotulo} abaixo do mínimo (${c.min})`);
  if (c.max !== undefined && n > c.max) throw new ErroAcao(400, `${c.rotulo} acima do máximo (${c.max})`);
  return n;
}

function validarValor(item, valor) {
  const v = valor && typeof valor === 'object' ? valor : {};
  const comps = item.componentes;
  // "Não tem" responde o item inteiro (nada mais é obrigatório).
  if (v.nao_tem === true) {
    if (!comps.some((c) => c.nao_tem)) throw new ErroAcao(400, 'Este item não tem a opção "Não tem"');
    return { nao_tem: true };
  }
  const out = {};
  for (const c of comps) {
    if (c.tipo === 'medida') {
      const bruto = v.medidas && v.medidas[c.rotulo];
      if (bruto === undefined || bruto === null || bruto === '') {
        if (c.obrigatorio) throw new ErroAcao(400, `Informe ${c.rotulo}`);
        continue;
      }
      out.medidas = { ...(out.medidas || {}), [c.rotulo]: numero(bruto, c) };
    } else if (c.tipo === 'estado') {
      if (!v.estado) {
        if (c.obrigatorio) throw new ErroAcao(400, 'Escolha o estado');
        continue;
      }
      const escala = ESTADOS[c.escala] || ESTADOS.troca;
      if (!escala[v.estado]) throw new ErroAcao(400, 'Estado inválido');
      out.estado = v.estado;
      if (v.estado === 'reparo' || v.estado === 'troca') {
        const d = String(v.descricao || '').replace(/\s+/g, ' ').trim();
        if (v.estado === 'reparo' && c.descricao_se_reparo && d.length < 3) throw new ErroAcao(400, 'Descreva o reparo necessário');
        if (d.length > 300) throw new ErroAcao(400, 'Descrição muito longa (máximo 300 caracteres)');
        if (d) out.descricao = d;
      }
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
      out.marcados = c.opcoes.filter((o) => marcados.includes(o));
    } else if (c.tipo === 'sim_nao') {
      if (typeof v.sim !== 'boolean') {
        if (c.obrigatorio) throw new ErroAcao(400, `Responda ${(c.rotulos || ['Sim', 'Não']).join(' ou ')}`);
        continue;
      }
      out.sim = v.sim;
      if (v.sim && c.texto_se_sim) {
        const t = String(v.texto || '').trim();
        if (t.length < 3) throw new ErroAcao(400, 'Detalhe a resposta');
        if (t.length > 1000) throw new ErroAcao(400, 'Texto muito longo');
        out.texto = t;
      }
    } else if (c.tipo === 'texto') {
      const t = String(v.texto || '').trim();
      if (!t && c.obrigatorio) throw new ErroAcao(400, `Informe ${c.rotulo || 'o texto'}`);
      if (t.length > 1000) throw new ErroAcao(400, 'Texto muito longo');
      if (t) out.texto = t;
    }
  }
  return out;
}

// Texto curto de uma resposta (linha do tempo, PDF, histórico).
function resumoValor(item, v) {
  if (!v || typeof v !== 'object') return '—';
  if (v.nao_tem) return 'Não tem';
  const partes = [];
  for (const c of item.componentes) {
    if (c.tipo === 'estado' && v.estado) partes.push((ESTADOS[c.escala] || ESTADOS.troca)[v.estado] + (v.descricao ? ` (${v.descricao})` : ''));
    if (c.tipo === 'sim_nao' && typeof v.sim === 'boolean') partes.push((c.rotulos || ['Sim', 'Não'])[v.sim ? 0 : 1] + (v.texto ? `: ${v.texto}` : ''));
    if (c.tipo === 'medida' && v.medidas && v.medidas[c.rotulo] !== undefined) partes.push(`${c.rotulo} ${v.medidas[c.rotulo].toLocaleString('pt-BR')} ${c.unidade || ''}`.trim());
    if (c.tipo === 'opcoes' && v.opcao) partes.push(v.opcao);
    if (c.tipo === 'multipla' && v.marcados) partes.push(v.marcados.join(', ') || 'nenhum');
    if (c.tipo === 'texto' && v.texto) partes.push(v.texto);
  }
  return partes.join(' · ') || '—';
}

// ---------- peças defeituosas (lista automática + linhas manuais) ----------
// Item "Necessita troca/reparo" (ou "Trocar pastilhas/discos" = Sim) gera uma linha
// automática; voltar para Bom/Regular tira a linha (fica no banco como removida).
function precisaPeca(item, v) {
  if (!v || v.nao_tem) return false;
  if (item.componentes.some((c) => c.tipo === 'estado') && (v.estado === 'troca' || v.estado === 'reparo')) return true;
  if (item.componentes.some((c) => c.tipo === 'sim_nao' && c.gera_peca) && v.sim === true) return true;
  return false;
}

function sincronizarPeca(db, exec, item, valor, operador, agora) {
  const atual = db.prepare("SELECT * FROM kb_checklist_pecas WHERE execucao_id = ? AND item_id = ? AND origem = 'automatica' AND removido_em IS NULL")
    .get(exec.id, item.id);
  if (precisaPeca(item, valor)) {
    if (!atual) {
      const ordem = db.prepare('SELECT COALESCE(MAX(ordem), 0) + 1 AS n FROM kb_checklist_pecas WHERE execucao_id = ?').get(exec.id).n;
      const titulo = item.secao.tipo === 'itens' && /^Freios/.test(item.secao.titulo) ? `${item.texto} (${item.secao.titulo.toLowerCase()})` : item.texto;
      db.prepare(`INSERT INTO kb_checklist_pecas (execucao_id, item_id, origem, descricao, ordem, atualizado_por, atualizado_em)
                  VALUES (?, ?, 'automatica', ?, ?, ?, ?)`).run(exec.id, item.id, valor.descricao || titulo, ordem, operador, agora);
    } else if (valor.descricao) {
      // a descrição do reparo só preenche a linha se ela ainda estiver vazia (não sobrescreve o que o mecânico escreveu)
      db.prepare('UPDATE kb_checklist_pecas SET descricao = COALESCE(descricao, ?) WHERE id = ?').run(valor.descricao, atual.id);
    }
  } else if (atual) {
    db.prepare('UPDATE kb_checklist_pecas SET removido_em = ?, removido_por = ? WHERE id = ?').run(agora, operador, atual.id);
  }
}

function listarPecas(db, execId) {
  return db.prepare(`SELECT p.id, p.item_id, p.origem, p.descricao, p.tempo_troca_horas, p.ordem, p.atualizado_por, p.atualizado_em,
      i.texto AS item_texto FROM kb_checklist_pecas p LEFT JOIN kb_checklist_itens i ON i.id = p.item_id
      WHERE p.execucao_id = ? AND p.removido_em IS NULL ORDER BY p.ordem`).all(Number(execId));
}

function validarPeca({ descricao, tempo_troca_horas: tempo }) {
  const d = String(descricao ?? '').replace(/\s+/g, ' ').trim();
  if (d.length > 300) throw new ErroAcao(400, 'Descrição muito longa (máximo 300 caracteres)');
  let h = null;
  if (tempo !== undefined && tempo !== null && tempo !== '') {
    h = Number(String(tempo).replace(',', '.'));
    if (!Number.isFinite(h) || h < 0 || h > 200) throw new ErroAcao(400, 'Tempo de troca inválido (horas, entre 0 e 200)');
  }
  return { d, h };
}

function salvarPeca(db, pecaId, dados, { agora = agoraUtc() } = {}) {
  const op = validarOperador(dados.operador);
  const p = db.prepare('SELECT * FROM kb_checklist_pecas WHERE id = ? AND removido_em IS NULL').get(Number(pecaId));
  if (!p) throw new ErroAcao(404, 'Peça não encontrada');
  const exec = execucaoOu404(db, p.execucao_id);
  cardAtivo(db, exec.card_id);
  const { d, h } = validarPeca(dados);
  db.transaction(() => {
    db.prepare('UPDATE kb_checklist_pecas SET descricao = ?, tempo_troca_horas = ?, atualizado_por = ?, atualizado_em = ? WHERE id = ?')
      .run(d || null, h, op, agora, p.id);
    if (p.descricao !== (d || null) || p.tempo_troca_horas !== h) {
      registrarEdicao(db, exec, `peça "${d || p.descricao || 'sem descrição'}" alterada por ${op} (antes: ${p.descricao || '—'}, ${p.tempo_troca_horas ?? '—'} h)`, op, agora, { peca_id: p.id });
    }
  })();
  return db.prepare('SELECT * FROM kb_checklist_pecas WHERE id = ?').get(p.id);
}

function adicionarPeca(db, execId, dados, { agora = agoraUtc() } = {}) {
  const op = validarOperador(dados.operador);
  const exec = execucaoOu404(db, execId);
  cardAtivo(db, exec.card_id);
  const { d, h } = validarPeca(dados);
  return db.transaction(() => {
    const ordem = db.prepare('SELECT COALESCE(MAX(ordem), 0) + 1 AS n FROM kb_checklist_pecas WHERE execucao_id = ?').get(exec.id).n;
    const id = db.prepare(`INSERT INTO kb_checklist_pecas (execucao_id, item_id, origem, descricao, tempo_troca_horas, ordem, atualizado_por, atualizado_em)
      VALUES (?, NULL, 'manual', ?, ?, ?, ?, ?)`).run(exec.id, d || null, h, ordem, op, agora).lastInsertRowid;
    registrarEdicao(db, exec, `peça "${d || 'sem descrição'}" adicionada por ${op}`, op, agora, { peca_id: id });
    return db.prepare('SELECT * FROM kb_checklist_pecas WHERE id = ?').get(id);
  })();
}

function removerPeca(db, pecaId, { operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  const p = db.prepare('SELECT * FROM kb_checklist_pecas WHERE id = ? AND removido_em IS NULL').get(Number(pecaId));
  if (!p) throw new ErroAcao(404, 'Peça não encontrada');
  if (p.origem === 'automatica') throw new ErroAcao(400, 'Esta linha vem de um item marcado "Necessita troca/reparo": mude a resposta do item');
  const exec = execucaoOu404(db, p.execucao_id);
  cardAtivo(db, exec.card_id);
  db.transaction(() => {
    db.prepare('UPDATE kb_checklist_pecas SET removido_em = ?, removido_por = ? WHERE id = ?').run(agora, op, p.id);
    registrarEdicao(db, exec, `peça "${p.descricao || 'sem descrição'}" removida por ${op}`, op, agora, { peca_id: p.id });
  })();
  return { ok: true };
}

// ---------- responder ----------
// Salva (ou altera) a resposta de um item. Depois de finalizado, guarda a versão anterior.
function responder(db, execId, itemId, { valor, operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  return db.transaction(() => {
    const exec = execucaoOu404(db, execId);
    cardAtivo(db, exec.card_id);
    const item = itemDaExecucao(db, exec, itemId);
    const limpo = validarValor(item, valor);
    const novo = JSON.stringify(limpo);
    const atual = db.prepare('SELECT * FROM kb_checklist_respostas WHERE execucao_id = ? AND item_id = ?').get(exec.id, item.id);
    if (!atual) {
      db.prepare(`INSERT INTO kb_checklist_respostas (execucao_id, item_id, valor, respondido_por, respondido_em)
                  VALUES (?, ?, ?, ?, ?)`).run(exec.id, item.id, novo, op, agora);
      registrarEdicao(db, exec, `"${item.texto}" respondido por ${op}: ${resumoValor(item, limpo)}`, op, agora, { item_id: item.id });
    } else if (atual.valor !== novo) {
      if (exec.status === 'finalizado') {
        db.prepare(`INSERT INTO kb_checklist_respostas_hist (resposta_id, versao, valor_anterior, alterado_por, alterado_em)
                    VALUES (?, ?, ?, ?, ?)`).run(atual.id, atual.versao, atual.valor, op, agora);
        registrarEdicao(db, exec, `"${item.texto}" alterado por ${op}: ${resumoValor(item, json(atual.valor, {}))} → ${resumoValor(item, limpo)}`,
          op, agora, { item_id: item.id });
      }
      db.prepare('UPDATE kb_checklist_respostas SET valor = ?, respondido_por = ?, respondido_em = ?, versao = versao + 1 WHERE id = ?')
        .run(novo, op, agora, atual.id);
    }
    sincronizarPeca(db, exec, item, limpo, op, agora);
    db.prepare('UPDATE kb_checklist_execucoes SET ultimo_item_id = ? WHERE id = ?').run(item.id, exec.id);
    return { item_id: item.id, valor: limpo };
  })();
}

function historicoItem(db, execId, itemId) {
  const r = db.prepare('SELECT * FROM kb_checklist_respostas WHERE execucao_id = ? AND item_id = ?').get(Number(execId), Number(itemId));
  if (!r) return [];
  return db.prepare('SELECT versao, valor_anterior, alterado_por, alterado_em FROM kb_checklist_respostas_hist WHERE resposta_id = ? ORDER BY id DESC')
    .all(r.id).map((h) => ({ ...h, valor_anterior: json(h.valor_anterior, {}) }));
}

// ---------- comentários por item ----------
function comentar(db, execId, itemId, { texto, operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  const t = String(texto || '').replace(/\r\n/g, '\n').trim();
  if (!t) throw new ErroAcao(400, 'Escreva o comentário');
  if (t.length > MAX_COMENTARIO) throw new ErroAcao(400, `Comentário muito longo (máximo ${MAX_COMENTARIO} caracteres)`);
  return db.transaction(() => {
    const exec = execucaoOu404(db, execId);
    cardAtivo(db, exec.card_id);
    const item = itemDaExecucao(db, exec, itemId);
    const id = db.prepare(`INSERT INTO kb_checklist_comentarios (execucao_id, item_id, texto, autor_nome, criado_em) VALUES (?, ?, ?, ?, ?)`)
      .run(exec.id, item.id, t, op, agora).lastInsertRowid;
    registrarEdicao(db, exec, `comentário em "${item.texto}" por ${op}: ${t.slice(0, 120)}`, op, agora, { item_id: item.id });
    return db.prepare('SELECT * FROM kb_checklist_comentarios WHERE id = ?').get(id);
  })();
}

function removerComentario(db, comentarioId, { operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  const c = db.prepare('SELECT * FROM kb_checklist_comentarios WHERE id = ? AND removido_em IS NULL').get(Number(comentarioId));
  if (!c) throw new ErroAcao(404, 'Comentário não encontrado');
  const exec = execucaoOu404(db, c.execucao_id);
  cardAtivo(db, exec.card_id);
  db.transaction(() => {
    db.prepare('UPDATE kb_checklist_comentarios SET removido_em = ?, removido_por = ? WHERE id = ?').run(agora, op, c.id);
    registrarEdicao(db, exec, `comentário removido por ${op}: ${c.texto.slice(0, 120)}`, op, agora, { item_id: c.item_id });
  })();
  return { ok: true };
}

// Mídia de item chegou ao bucket depois de finalizado (chamado pela confirmação de envio).
function midiaAdicionada(db, midia, operador, agora) {
  if (!midia.checklist_execucao_id) return;
  const exec = execucaoOu404(db, midia.checklist_execucao_id);
  if (exec.status !== 'finalizado') return;
  const item = midia.checklist_item_id ? itemDaExecucao(db, exec, midia.checklist_item_id) : null;
  const nome = { foto: 'foto', video: 'vídeo', audio: 'áudio' }[midia.tipo] || midia.tipo;
  registrarEdicao(db, exec, `${nome} adicionad${midia.tipo === 'foto' ? 'a' : 'o'} em "${item ? item.texto : 'item'}" por ${operador}`,
    operador, agora, { item_id: midia.checklist_item_id, midia_id: midia.id });
}

// Remover mídia de item (fica no banco como removida).
function removerMidiaItem(db, midiaId, { operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  const m = db.prepare('SELECT * FROM kb_midias WHERE id = ? AND removido_em IS NULL').get(Number(midiaId));
  if (!m || !m.checklist_execucao_id || m.tipo === 'pdf') throw new ErroAcao(404, 'Mídia não encontrada');
  const exec = execucaoOu404(db, m.checklist_execucao_id);
  cardAtivo(db, exec.card_id);
  const item = m.checklist_item_id ? itemDaExecucao(db, exec, m.checklist_item_id) : null;
  db.transaction(() => {
    db.prepare('UPDATE kb_midias SET removido_em = ?, removido_por = ? WHERE id = ?').run(agora, op, m.id);
    registrarEdicao(db, exec, `${m.tipo} removid${m.tipo === 'foto' ? 'a' : 'o'} de "${item ? item.texto : 'item'}" por ${op}`, op, agora, { midia_id: m.id });
  })();
  return { ok: true };
}

// ---------- avarias (vistoria de entrada) ----------
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
    registrarEdicao(db, exec, `avaria adicionada por ${op}: ${regiao} — ${desc}`, op, agora, { avaria_id: id });
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
    registrarEdicao(db, exec, `avaria removida por ${op}: ${a.regiao} — ${a.descricao}`, op, agora, { avaria_id: a.id });
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
    if (r.nao_tem) continue;
    for (const c of item.componentes) {
      if (c.tipo === 'foto' && c.obrigatorio && !midias.some((m) => m.checklist_item_id === item.id && !m.avaria_id && m.tipo === 'foto')) {
        faltas.push(`Foto: ${item.texto}`);
      }
      if (c.tipo === 'medida' && c.obrigatorio && !(r.medidas && r.medidas[c.rotulo] !== undefined)) faltas.push(`${c.rotulo}: ${item.texto}`);
      if (c.tipo === 'estado' && c.obrigatorio && !r.estado) faltas.push(item.texto);
      if (c.tipo === 'opcoes' && c.obrigatorio && !r.opcao) faltas.push(item.texto);
      if (c.tipo === 'sim_nao' && c.obrigatorio && typeof r.sim !== 'boolean') faltas.push(item.texto);
      if (c.tipo === 'texto' && c.obrigatorio && !r.texto) faltas.push(`${c.rotulo || 'Texto'}: ${item.texto}`);
      if (c.tipo === 'avarias' && r.sim === true) {
        if (!avarias.length) faltas.push('Avarias: respondeu Sim, mas nenhuma avaria foi registrada');
        for (const a of avarias) {
          if (!midias.some((m) => m.avaria_id === a.id)) faltas.push(`Foto da avaria ${a.ordem} (${a.regiao})`);
        }
      }
    }
  }
  if (modelo.secoes.some((s) => s.tipo === 'pecas_defeituosas')) {
    for (const p of listarPecas(db, exec.id)) {
      const nome = p.descricao || p.item_texto || `linha ${p.ordem}`;
      if (!p.descricao) faltas.push(`Peças defeituosas: descrição de "${nome}"`);
      if (p.tempo_troca_horas === null || p.tempo_troca_horas === undefined) faltas.push(`Peças defeituosas: tempo de troca de "${nome}"`);
    }
  }
  return [...new Set(faltas)];
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

    let resumo;
    if (modelo.codigo === 'entrada') {
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
      resumo = [`${fotos} foto${fotos === 1 ? '' : 's'}`, avarias ? `${avarias} avaria${avarias === 1 ? '' : 's'}` : 'nenhuma avaria'];
      if (km !== null) resumo.unshift(`KM ${km.toLocaleString('pt-BR')}`);
    } else {
      const pecas = listarPecas(db, exec.id);
      const horas = pecas.reduce((s, p) => s + (p.tempo_troca_horas || 0), 0);
      resumo = [pecas.length
        ? `${pecas.length} peça${pecas.length === 1 ? '' : 's'} defeituosa${pecas.length === 1 ? '' : 's'} (${horas.toLocaleString('pt-BR')} h de troca)`
        : 'nenhuma peça defeituosa'];
    }
    const genero = modelo.codigo === 'entrada' ? 'a' : 'o';
    evento(db, card.id, 'checklist_finalizado', `${modelo.nome} finalizad${genero} por ${exec.feito_por} em ${formatarBR(agora)} — ${resumo.join(', ')}`,
      { execucao_id: exec.id, codigo: modelo.codigo }, op, agora);
    return { execucao: execucaoOu404(db, exec.id), ja_finalizado: false };
  })();
}

// Tudo o que a tela precisa para mostrar/retomar/editar o checklist.
async function estado(db, storage, execId) {
  const exec = execucaoOu404(db, execId);
  const modelo = carregarModelo(db, exec.modelo_id);
  const respostas = {};
  for (const r of db.prepare(`SELECT r.item_id, r.valor, r.respondido_por, r.respondido_em, r.versao,
      (SELECT COUNT(*) FROM kb_checklist_respostas_hist h WHERE h.resposta_id = r.id) AS alteracoes
      FROM kb_checklist_respostas r WHERE r.execucao_id = ?`).all(exec.id)) {
    respostas[r.item_id] = { valor: json(r.valor, {}), respondido_por: r.respondido_por, respondido_em: r.respondido_em, versao: r.versao, alteracoes: r.alteracoes };
  }
  const assinar = storage && storage.configurado;
  const midias = [];
  for (const m of midiasDaExecucao(db, exec.id)) {
    if (m.tipo === 'pdf') continue;
    midias.push({
      id: m.id, tipo: m.tipo, mime: m.mime, item_id: m.checklist_item_id, avaria_id: m.avaria_id, enviado_em: m.enviado_em, autor: m.autor_nome,
      duracao: m.duracao_s,
      url: assinar ? await storage.urlVer(m.chave_objeto) : null,
      miniatura_url: assinar && m.chave_miniatura ? await storage.urlVer(m.chave_miniatura) : null,
    });
  }
  return {
    execucao: exec,
    modelo,
    respostas,
    midias,
    comentarios: db.prepare(`SELECT id, item_id, texto, autor_nome, criado_em FROM kb_checklist_comentarios
                             WHERE execucao_id = ? AND removido_em IS NULL ORDER BY criado_em, id`).all(exec.id),
    avarias: db.prepare('SELECT id, ordem, regiao, descricao, criado_por, criado_em FROM kb_checklist_avarias WHERE execucao_id = ? AND removido_em IS NULL ORDER BY ordem').all(exec.id),
    pecas: listarPecas(db, exec.id),
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
    // Mais nova primeiro; na mesma versão, a via que vai para o cliente antes da via orçamento.
    for (const p of db.prepare(`SELECT p.id, p.versao, p.via, p.gerado_em, p.gerado_por, p.tipo, md.chave_objeto FROM kb_pdfs p JOIN kb_midias md ON md.id = p.midia_id
        WHERE p.execucao_id = ? ORDER BY p.versao DESC, CASE p.via WHEN 'orcamento' THEN 1 ELSE 0 END`).all(e.id)) {
      const nome = `${p.tipo.replace(/_/g, '-')}${p.via === 'unica' ? '' : `-${p.via}`}-v${p.versao}.pdf`;
      pdfs.push({ id: p.id, versao: p.versao, via: p.via, gerado_em: p.gerado_em, gerado_por: p.gerado_por,
        url: storage && storage.configurado ? await storage.urlVer(p.chave_objeto, { nomeArquivo: nome, contentType: 'application/pdf' }) : null });
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
  const item = itensDoModelo(carregarModelo(db, exec.modelo_id)).find((i) => i.id === Number(itemId));
  if (!item) throw new ErroAcao(400, 'Item não pertence a este checklist');
  let avaria = null;
  if (avariaId) {
    avaria = db.prepare('SELECT * FROM kb_checklist_avarias WHERE id = ? AND removido_em IS NULL').get(Number(avariaId));
    if (!avaria || avaria.execucao_id !== exec.id) throw new ErroAcao(400, 'Avaria não pertence a este checklist');
  }
  return { execucao_id: exec.id, item_id: item.id, avaria_id: avaria ? avaria.id : null };
}

module.exports = {
  ESTADOS, carregarModelo, modeloAtivo, iniciar, responder, resumoValor, historicoItem, comentar, removerComentario,
  midiaAdicionada, removerMidiaItem, criarAvaria, removerAvaria, listarPecas, salvarPeca, adicionarPeca, removerPeca,
  pendencias, finalizar, estado, listarDoCard, validarVinculoMidia, midiasDaExecucao, itensDoModelo,
};
