// Ações do operador no kanban (Etapa 2): mover de fase, arquivar, desarquivar,
// trocar o mecânico responsável e buscar. Toda ação registra o nome do operador.
//
// Perfis (só Gestor arquiva/desarquiva) entram na Etapa 7, com os logins individuais.
const { formatarBR } = require('./datas');
const { arquivarFinalizadosNaFase9 } = require('./sync');
const fluxo = require('./fluxo');

class ErroAcao extends Error {
  constructor(status, mensagem, extra = {}) {
    super(mensagem);
    this.status = status;
    Object.assign(this, extra);
  }
}

function validarOperador(nome) {
  const op = String(nome || '').replace(/\s+/g, ' ').trim();
  if (!op) throw new ErroAcao(400, 'Informe o nome do operador');
  if (op.length > 60) throw new ErroAcao(400, 'Nome do operador muito longo');
  if (/^sistema$/i.test(op)) throw new ErroAcao(400, 'Nome de operador reservado');
  return op;
}

const agoraUtc = () => new Date().toISOString();

function cardOu404(db, id) {
  const c = db.prepare('SELECT * FROM kb_cards WHERE id = ?').get(Number(id));
  if (!c) throw new ErroAcao(404, 'Card não encontrado');
  return c;
}

function nomeFase(db, id) {
  const f = db.prepare('SELECT nome FROM kb_fases WHERE id = ?').get(Number(id));
  return f ? f.nome : null;
}

function evento(db, cardId, tipo, texto, dados, operador, agora, midiaId = null) {
  db.prepare(`INSERT INTO kb_eventos (card_id, tipo, texto, dados, midia_id, operador_nome, criado_em)
              VALUES (?, ?, ?, ?, ?, ?, ?)`).run(cardId, tipo, texto, dados ? JSON.stringify(dados) : null, midiaId, operador, agora);
}

// Move o card. `faseAtual` (opcional) é a fase que a tela mostrava: se outra pessoa já moveu o
// card, devolve 409 em vez de sobrescrever sem saber. `papel` vem do login (kanban/fluxo.js) e
// as exigências da passagem (peças, PDF, aprovação, prazo) chegam nos demais campos.
function moverCard(db, id, { faseId, faseAtual, operador, papel = 'total', pecas, pdfMidiaId, decisao, observacao, prazoDias }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  const destino = Number(faseId);
  const nomeDestino = nomeFase(db, destino);
  if (!nomeDestino) throw new ErroAcao(400, 'Fase inválida');

  return db.transaction(() => {
    const c = cardOu404(db, id);
    if (c.arquivado_em) throw new ErroAcao(409, 'Card arquivado: desarquive antes de mover');
    if (faseAtual !== undefined && faseAtual !== null && Number(faseAtual) !== c.fase_id) {
      throw new ErroAcao(409, `Este card já foi movido para "${nomeFase(db, c.fase_id)}" por outra pessoa`, { fase_id: c.fase_id });
    }
    if (c.fase_id === destino) return { card: c, movido: false, arquivado: false };
    const todas = db.prepare('SELECT id FROM kb_fases').all().map((f) => f.id);
    if (!fluxo.podeMover(papel, c.fase_id, destino, todas)) throw new ErroAcao(403, fluxo.mensagemSemPermissao(papel, c.fase_id));

    const origem = nomeFase(db, c.fase_id);
    const extra = aplicarExigencias(db, c, destino, { op, pecas, pdfMidiaId, decisao, observacao, prazoDias, agora });
    // Mover libera o bloqueio de auto-arquivamento ligado pelo "Desarquivar". Prazo de peças só vale em Aguardando Peças.
    db.prepare(`UPDATE kb_cards SET fase_id = ?, fase_desde = ?, auto_arquivar_bloqueado = 0,
                pecas_prazo_dias = ?, pecas_prazo_em = ?, atualizado_em = ? WHERE id = ?`)
      .run(destino, agora, extra.prazo ? extra.prazo.dias : null, extra.prazo ? extra.prazo.em : null, agora, c.id);
    evento(db, c.id, 'fase', `Movido de ${origem} para ${nomeDestino} por ${op} em ${formatarBR(agora)}${extra.texto ? `\n${extra.texto}` : ''}`,
      { de: c.fase_id, para: destino, ...extra.dados }, op, agora, extra.midiaId);

    // Regra da fase 9: se a OS já foi finalizada no Onmotor, arquiva na hora.
    if (destino === 9 && c.os_finalizada_em) arquivarFinalizadosNaFase9(db, agora);
    const depois = cardOu404(db, c.id);
    return { card: depois, movido: true, arquivado: Boolean(depois.arquivado_em) };
  })();
}

// ---------- exigências da passagem de fase (kanban/fluxo.js) ----------
const MAX_PECAS = 100;

function validarPecas(pecas) {
  const lista = (Array.isArray(pecas) ? pecas : []).map((p) => ({
    descricao: String((p && p.descricao) || '').replace(/\s+/g, ' ').trim(),
    origem: p && p.origem === 'checklist' ? 'checklist' : 'manual',
  })).filter((p) => p.descricao);
  if (!lista.length) throw new ErroAcao(400, 'Informe as peças para o orçamento', { exige: 'pecas' });
  if (lista.length > MAX_PECAS) throw new ErroAcao(400, `No máximo ${MAX_PECAS} peças por orçamento`);
  if (lista.some((p) => p.descricao.length > 300)) throw new ErroAcao(400, 'Descrição de peça muito longa (máximo 300 caracteres)');
  return lista;
}

function validarObservacao(obs, obrigatoria) {
  const o = String(obs || '').trim();
  if (obrigatoria && !o) throw new ErroAcao(400, 'Escreva a observação (motivo da devolução)', { exige: 'observacao' });
  if (o.length > 2000) throw new ErroAcao(400, 'Observação muito longa (máximo 2000 caracteres)');
  return o || null;
}

// PDF enviado para este card pela rota de orçamento e ainda não usado em outro orçamento.
function pdfDoCard(db, card, midiaId, oQue) {
  const id = Number(midiaId);
  const m = id ? db.prepare("SELECT * FROM kb_midias WHERE id = ? AND tipo = 'pdf' AND status = 'enviado' AND removido_em IS NULL").get(id) : null;
  if (!m || m.card_id !== card.id) throw new ErroAcao(400, `Anexe o PDF ${oQue}`, { exige: 'pdf' });
  if (db.prepare('SELECT 1 FROM kb_orcamentos WHERE pdf_midia_id = ? OR via_cliente_midia_id = ?').get(id, id)) {
    throw new ErroAcao(400, 'Este PDF já foi usado: anexe o arquivo de novo', { exige: 'pdf' });
  }
  return m;
}

const orcamentoAberto = (db, cardId) => db.prepare('SELECT * FROM kb_orcamentos WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(cardId);
const listaPecas = (pecas) => pecas.map((p) => `• ${p.descricao}`).join('\n');

function aplicarExigencias(db, card, destino, { op, pecas, pdfMidiaId, decisao, observacao, prazoDias, agora }) {
  const exige = fluxo.exigencias(card.fase_id, destino);
  const out = { texto: '', dados: {}, midiaId: null, prazo: null };
  const textos = [];

  if (exige.includes('aprovacao')) {
    if (!['integral', 'parcial'].includes(decisao)) throw new ErroAcao(400, 'Escolha: orçamento aprovado integralmente ou parcialmente', { exige: 'aprovacao' });
    const obs = validarObservacao(observacao, false);
    const via = decisao === 'parcial' ? pdfDoCard(db, card, pdfMidiaId, 'do orçamento aprovado pelo cliente (aprovação parcial)') : null;
    let orc = orcamentoAberto(db, card.id);
    if (!orc) orc = { id: db.prepare("INSERT INTO kb_orcamentos (card_id, pecas, solicitado_em) VALUES (?, '[]', ?)").run(card.id, agora).lastInsertRowid };
    db.prepare('UPDATE kb_orcamentos SET decisao = ?, decisao_obs = ?, via_cliente_midia_id = ?, decidido_por = ?, decidido_em = ? WHERE id = ?')
      .run(decisao, obs, via ? via.id : null, op, agora, orc.id);
    // peças do orçamento aprovado entram "a separar" para o compras (estoque / pedido)
    require('./pecas').semearDaAprovacao(db, card, db.prepare('SELECT * FROM kb_orcamentos WHERE id = ?').get(orc.id), { op, agora });
    textos.push(decisao === 'integral' ? 'Orçamento aprovado integralmente.' : 'Orçamento aprovado parcialmente — anexado o orçamento aprovado pelo cliente.');
    if (obs) textos.push(`Observação: ${obs}`);
    Object.assign(out.dados, { orcamento_id: orc.id, decisao, observacao: obs });
    if (via) out.midiaId = via.id;
  }

  if (exige.includes('pecas')) {
    const lista = validarPecas(pecas);
    const obs = validarObservacao(observacao, exige.includes('observacao'));
    if (card.fase_id === fluxo.FASE.APROVACAO) {
      // devolvido pela aprovação: fecha a solicitação anterior com o motivo
      const ant = orcamentoAberto(db, card.id);
      if (ant && !ant.decisao) {
        db.prepare("UPDATE kb_orcamentos SET decisao = 'devolvido', decisao_obs = ?, decidido_por = ?, decidido_em = ? WHERE id = ?").run(obs, op, agora, ant.id);
      }
      textos.push(`Devolvido ao Orçamento. Motivo: ${obs}`);
    } else if (obs) textos.push(`Observação: ${obs}`);
    const orcId = db.prepare('INSERT INTO kb_orcamentos (card_id, pecas, solicitado_por, solicitado_em) VALUES (?, ?, ?, ?)')
      .run(card.id, JSON.stringify(lista), op, agora).lastInsertRowid;
    textos.push(`Peças para orçamento (${lista.length}):\n${listaPecas(lista)}`);
    Object.assign(out.dados, { orcamento_id: orcId, pecas: lista, observacao: obs });
  }

  if (exige.includes('orcamento_pdf')) {
    const pdf = pdfDoCard(db, card, pdfMidiaId, 'do orçamento');
    const obs = validarObservacao(observacao, false);
    let orc = orcamentoAberto(db, card.id);
    if (!orc || orc.pdf_midia_id || orc.decisao) {
      orc = { id: db.prepare("INSERT INTO kb_orcamentos (card_id, pecas, solicitado_em) VALUES (?, '[]', ?)").run(card.id, agora).lastInsertRowid };
    }
    db.prepare('UPDATE kb_orcamentos SET pdf_midia_id = ?, enviado_por = ?, enviado_em = ? WHERE id = ?').run(pdf.id, op, agora, orc.id);
    textos.push('Orçamento em PDF anexado.');
    if (obs) textos.push(`Observação: ${obs}`);
    Object.assign(out.dados, { orcamento_id: orc.id, observacao: obs });
    out.midiaId = pdf.id;
  }

  if (exige.includes('prazo')) {
    const dias = Number(prazoDias);
    if (!Number.isInteger(dias) || dias < 1 || dias > 365) throw new ErroAcao(400, 'Informe o prazo de chegada das peças (dias, de 1 a 365)', { exige: 'prazo' });
    out.prazo = { dias, em: new Date(Date.parse(agora) + dias * 86_400_000).toISOString() };
    textos.push(`Prazo para as peças chegarem: ${dias} dia${dias === 1 ? '' : 's'} (até ${formatarBR(out.prazo.em)}).`);
    Object.assign(out.dados, { prazo_dias: dias, prazo_em: out.prazo.em });
  }

  out.texto = textos.join('\n');
  return out;
}

function arquivarCard(db, id, { operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  return db.transaction(() => {
    const c = cardOu404(db, id);
    if (c.arquivado_em) throw new ErroAcao(409, 'Card já está arquivado');
    db.prepare(`UPDATE kb_cards SET arquivado_em = ?, arquivado_por = ?, arquivado_motivo = 'manual', atualizado_em = ?
                WHERE id = ?`).run(agora, op, agora, c.id);
    evento(db, c.id, 'arquivado', `Arquivado por ${op} em ${formatarBR(agora)} (fase: ${nomeFase(db, c.fase_id)})`,
      { motivo: 'manual', fase_id: c.fase_id }, op, agora);
    return cardOu404(db, c.id);
  })();
}

// Volta para a fase em que estava. Liga o bloqueio de auto-arquivamento: senão um card
// na fase 9 com OS finalizada seria arquivado de novo na próxima rodada do sync.
function desarquivarCard(db, id, { operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  return db.transaction(() => {
    const c = cardOu404(db, id);
    if (!c.arquivado_em) throw new ErroAcao(409, 'Card não está arquivado');
    db.prepare(`UPDATE kb_cards SET arquivado_em = NULL, arquivado_por = NULL, arquivado_motivo = NULL,
                auto_arquivar_bloqueado = 1, atualizado_em = ? WHERE id = ?`).run(agora, c.id);
    evento(db, c.id, 'desarquivado', `Desarquivado por ${op} em ${formatarBR(agora)} — voltou para ${nomeFase(db, c.fase_id)}`,
      { fase_id: c.fase_id }, op, agora);
    return cardOu404(db, c.id);
  })();
}

// Mecânico responsável do card. `null` volta a usar o do painel de pátio.
function definirMecanico(db, id, { mecanicoId, operador }, { agora = agoraUtc() } = {}) {
  validarOperador(operador);
  const mid = mecanicoId === null || mecanicoId === undefined || mecanicoId === '' ? null : Number(mecanicoId);
  // Lista de mecânicos do kanban (kb_mecanicos), não o cadastro de profissionais da agenda.
  if (mid !== null && !db.prepare('SELECT 1 FROM kb_mecanicos WHERE id = ? AND removido_em IS NULL').get(mid)) {
    throw new ErroAcao(400, 'Mecânico inválido');
  }
  const c = cardOu404(db, id);
  db.prepare('UPDATE kb_cards SET kb_mecanico_id = ?, atualizado_em = ? WHERE id = ?').run(mid, agora, c.id);
  return cardOu404(db, c.id);
}

// ---------- busca ----------
const semAcento = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const soAlfanum = (s) => semAcento(s).replace(/[^a-z0-9]/g, '');

// Busca por número da OS, placa, modelo, nome do cliente ou chassi. Sem termo, no modo
// "arquivados" lista os arquivados mais recentes; no modo "ativos" não lista nada.
function buscar(db, { q = '', modo = 'ativos', limite = 100 } = {}) {
  const arquivados = modo === 'arquivados';
  const termo = semAcento(q).trim();
  const compacto = soAlfanum(q);
  const linhas = db.prepare(`
    SELECT c.*, f.nome AS fase_nome FROM kb_cards c JOIN kb_fases f ON f.id = c.fase_id
    WHERE ${arquivados ? 'c.arquivado_em IS NOT NULL' : 'c.arquivado_em IS NULL'}
    ORDER BY ${arquivados ? 'c.arquivado_em DESC' : 'c.atualizado_em DESC'}`).all();

  if (!termo) return arquivados ? linhas.slice(0, limite) : [];

  const palavras = termo.split(/\s+/).filter(Boolean);
  const casa = (c) => {
    if (compacto && (c.os_numero === compacto || soAlfanum(c.placa).includes(compacto) || soAlfanum(c.chassi).includes(compacto))) return true;
    const texto = semAcento([c.os_numero, c.placa, c.marca, c.modelo, c.cliente_nome, c.chassi].join(' '));
    return palavras.every((p) => texto.includes(p));
  };
  // OS com o número exato primeiro
  return linhas.filter(casa)
    .sort((a, b) => (b.os_numero === compacto) - (a.os_numero === compacto))
    .slice(0, limite);
}

// Nomes para a pergunta "quem está usando este aparelho?": mecânicos ativos + quem já
// registrou algo no kanban nos últimos 90 dias. (Na Etapa 7 vira a lista de usuários.)
function operadoresConhecidos(db, { agora = new Date() } = {}) {
  const desde = new Date(agora.getTime() - 90 * 86_400_000).toISOString();
  const mecanicos = db.prepare('SELECT nome FROM kb_mecanicos WHERE removido_em IS NULL ORDER BY ordem, nome').all().map((m) => m.nome);
  // "Edson Antonio Benin Junior" já está coberto pelo mecânico "Edson": não repete.
  const primeiros = new Set(mecanicos.map((n) => semAcento(n).split(/\s+/)[0]));
  const recentes = db.prepare(`SELECT operador_nome AS nome, MAX(criado_em) AS ultimo FROM kb_eventos
      WHERE operador_nome <> 'Sistema' AND criado_em >= ? GROUP BY operador_nome ORDER BY ultimo DESC LIMIT 30`).all(desde)
    .map((r) => r.nome).filter((n) => !primeiros.has(semAcento(n).split(/\s+/)[0]));
  const vistos = new Set();
  return [...mecanicos, ...recentes].filter((n) => {
    const k = semAcento(n);
    if (vistos.has(k)) return false;
    vistos.add(k);
    return true;
  });
}

module.exports = {
  ErroAcao, validarOperador, moverCard, arquivarCard, desarquivarCard, definirMecanico, buscar, operadoresConhecidos,
};
