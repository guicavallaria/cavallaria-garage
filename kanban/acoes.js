// Ações do operador no kanban (Etapa 2): mover de fase, arquivar, desarquivar,
// trocar o mecânico responsável e buscar. Toda ação registra o nome do operador.
//
// Perfis (só Gestor arquiva/desarquiva) entram na Etapa 7, com os logins individuais.
const { formatarBR } = require('./datas');
const { arquivarFinalizadosNaFase9 } = require('./sync');

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

function evento(db, cardId, tipo, texto, dados, operador, agora) {
  db.prepare(`INSERT INTO kb_eventos (card_id, tipo, texto, dados, operador_nome, criado_em)
              VALUES (?, ?, ?, ?, ?, ?)`).run(cardId, tipo, texto, dados ? JSON.stringify(dados) : null, operador, agora);
}

// Move o card para qualquer fase. `faseAtual` (opcional) é a fase que a tela mostrava:
// se outra pessoa já moveu o card, devolve 409 em vez de sobrescrever sem saber.
function moverCard(db, id, { faseId, faseAtual, operador }, { agora = agoraUtc() } = {}) {
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

    const origem = nomeFase(db, c.fase_id);
    // Mover libera o bloqueio de auto-arquivamento ligado pelo "Desarquivar".
    db.prepare(`UPDATE kb_cards SET fase_id = ?, fase_desde = ?, auto_arquivar_bloqueado = 0, atualizado_em = ?
                WHERE id = ?`).run(destino, agora, agora, c.id);
    evento(db, c.id, 'fase', `Movido de ${origem} para ${nomeDestino} por ${op} em ${formatarBR(agora)}`,
      { de: c.fase_id, para: destino }, op, agora);

    // Regra da fase 9: se a OS já foi finalizada no Onmotor, arquiva na hora.
    if (destino === 9 && c.os_finalizada_em) arquivarFinalizadosNaFase9(db, agora);
    const depois = cardOu404(db, c.id);
    return { card: depois, movido: true, arquivado: Boolean(depois.arquivado_em) };
  })();
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
