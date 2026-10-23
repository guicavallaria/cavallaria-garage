// Linha do tempo do card (Etapa 3): texto, foto, vídeo e áudio.
//
// - Texto: pode ser editado; cada edição guarda a versão anterior (kb_eventos_versoes).
// - Registros nunca são apagados: "remover" só marca removido_em/por (some da tela, fica auditável).
// - Mídia: o navegador comprime/valida, pede o envio aqui (URL assinada), manda direto ao
//   bucket e confirma. Só depois da confirmação (objeto conferido no bucket) o registro
//   aparece na linha do tempo.
const crypto = require('crypto');
const { ErroAcao, validarOperador } = require('./acoes');

const agoraUtc = () => new Date().toISOString();
const MAX_TEXTO = 5000;
const MAX_LEGENDA = 500;
const MB = 1024 * 1024;
const DURACAO_MAX_VIDEO_S = 120; // prompt: vídeos limitados a 2 min por registro

const TIPOS = {
  foto: {
    max: 25 * MB,
    mimes: { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/heic': 'heic', 'image/heif': 'heif' },
  },
  video: {
    max: 500 * MB,
    mimes: { 'video/mp4': 'mp4', 'video/quicktime': 'mov', 'video/webm': 'webm', 'video/3gpp': '3gp', 'video/x-matroska': 'mkv' },
  },
  audio: {
    max: 50 * MB,
    mimes: {
      'audio/webm': 'webm', 'audio/ogg': 'ogg', 'audio/mp4': 'm4a', 'audio/x-m4a': 'm4a', 'audio/aac': 'aac',
      'audio/mpeg': 'mp3', 'audio/wav': 'wav', 'audio/x-wav': 'wav', 'audio/3gpp': '3gp',
    },
  },
};
const TIPOS_REMOVIVEIS = new Set(['texto', 'foto', 'video', 'audio']);

const mimeBase = (m) => String(m || '').split(';')[0].trim().toLowerCase();

function cardAtivo(db, cardId) {
  const c = db.prepare('SELECT * FROM kb_cards WHERE id = ?').get(Number(cardId));
  if (!c) throw new ErroAcao(404, 'Card não encontrado');
  if (c.arquivado_em) throw new ErroAcao(409, 'Card arquivado: desarquive para registrar algo');
  return c;
}

function inserirEvento(db, { cardId, tipo, texto = null, midiaId = null, operador, agora }) {
  return db.prepare(`INSERT INTO kb_eventos (card_id, tipo, texto, midia_id, operador_nome, criado_em)
                     VALUES (?, ?, ?, ?, ?, ?)`).run(cardId, tipo, texto, midiaId, operador, agora).lastInsertRowid;
}

// ---------- texto ----------
function limparTexto(texto, max) {
  const t = String(texto ?? '').replace(/\r\n/g, '\n').trim();
  if (t.length > max) throw new ErroAcao(400, `Texto muito longo (máximo ${max} caracteres)`);
  return t;
}

function postarTexto(db, cardId, { texto, operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  const t = limparTexto(texto, MAX_TEXTO);
  if (!t) throw new ErroAcao(400, 'Escreva alguma coisa');
  const c = cardAtivo(db, cardId);
  const id = inserirEvento(db, { cardId: c.id, tipo: 'texto', texto: t, operador: op, agora });
  return db.prepare('SELECT * FROM kb_eventos WHERE id = ?').get(id);
}

function editarTexto(db, eventoId, { texto, operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  const t = limparTexto(texto, MAX_TEXTO);
  if (!t) throw new ErroAcao(400, 'O texto não pode ficar vazio');
  return db.transaction(() => {
    const e = db.prepare('SELECT * FROM kb_eventos WHERE id = ?').get(Number(eventoId));
    if (!e || e.removido_em) throw new ErroAcao(404, 'Registro não encontrado');
    if (e.tipo !== 'texto') throw new ErroAcao(400, 'Só textos podem ser editados');
    cardAtivo(db, e.card_id);
    if (e.texto === t) return e;
    db.prepare(`INSERT INTO kb_eventos_versoes (evento_id, texto_anterior, editado_por, editado_em)
                VALUES (?, ?, ?, ?)`).run(e.id, e.texto, op, agora);
    db.prepare('UPDATE kb_eventos SET texto = ?, editado_em = ? WHERE id = ?').run(t, agora, e.id);
    return db.prepare('SELECT * FROM kb_eventos WHERE id = ?').get(e.id);
  })();
}

function versoesTexto(db, eventoId) {
  const e = db.prepare('SELECT id, texto, operador_nome, criado_em, editado_em FROM kb_eventos WHERE id = ?').get(Number(eventoId));
  if (!e) throw new ErroAcao(404, 'Registro não encontrado');
  const versoes = db.prepare(`SELECT texto_anterior AS texto, editado_por, editado_em FROM kb_eventos_versoes
                              WHERE evento_id = ? ORDER BY id`).all(e.id);
  return { atual: e, versoes };
}

// Some da linha do tempo, mas continua no banco (auditoria).
function removerRegistro(db, eventoId, { operador }, { agora = agoraUtc() } = {}) {
  const op = validarOperador(operador);
  return db.transaction(() => {
    const e = db.prepare('SELECT * FROM kb_eventos WHERE id = ?').get(Number(eventoId));
    if (!e || e.removido_em) throw new ErroAcao(404, 'Registro não encontrado');
    if (!TIPOS_REMOVIVEIS.has(e.tipo)) throw new ErroAcao(400, 'Registros automáticos não podem ser removidos');
    cardAtivo(db, e.card_id);
    db.prepare('UPDATE kb_eventos SET removido_em = ?, removido_por = ? WHERE id = ?').run(agora, op, e.id);
    if (e.midia_id) db.prepare('UPDATE kb_midias SET removido_em = ?, removido_por = ? WHERE id = ?').run(agora, op, e.midia_id);
    return { ok: true };
  })();
}

// ---------- mídia ----------
function validarPedido({ tipo, mime, tamanho, duracao }) {
  const regra = TIPOS[tipo];
  if (!regra) throw new ErroAcao(400, 'Tipo de mídia inválido');
  const base = mimeBase(mime);
  const ext = regra.mimes[base];
  if (!ext) throw new ErroAcao(415, `Formato não aceito para ${tipo}: ${base || 'desconhecido'}`);
  const bytes = Number(tamanho);
  if (!(bytes > 0)) throw new ErroAcao(400, 'Arquivo vazio');
  if (bytes > regra.max) throw new ErroAcao(413, `Arquivo grande demais (máximo ${Math.round(regra.max / MB)} MB)`);
  const dur = duracao === undefined || duracao === null || duracao === '' ? null : Number(duracao);
  if (tipo === 'video') {
    if (!(dur > 0)) throw new ErroAcao(400, 'Duração do vídeo não informada');
    if (dur > DURACAO_MAX_VIDEO_S + 1) throw new ErroAcao(400, 'Vídeo com mais de 2 minutos: grave um trecho menor');
  }
  return { base, ext, bytes, dur };
}

function novaChave(cardId, ext, agora) {
  const d = new Date(agora);
  const uuid = crypto.randomUUID();
  const pasta = `cards/${Number(cardId)}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  return { objeto: `${pasta}/${uuid}.${ext}`, miniatura: `${pasta}/${uuid}-mini.jpg` };
}

async function urlsDeEnvio(storage, m) {
  return {
    upload_url: await storage.urlUpload(m.chave_objeto, m.mime),
    miniatura_url: m.chave_miniatura ? await storage.urlUpload(m.chave_miniatura, 'image/jpeg') : null,
  };
}

// Passo 1: registra a mídia como pendente e devolve as URLs de envio.
async function pedirEnvio(db, storage, cardId, dados, { agora = agoraUtc() } = {}) {
  if (!storage || !storage.configurado) throw new ErroAcao(503, 'Armazenamento de mídia não configurado no servidor');
  const op = validarOperador(dados.operador);
  const clienteId = String(dados.cliente_id || '');
  if (!/^[A-Za-z0-9-]{8,64}$/.test(clienteId)) throw new ErroAcao(400, 'Identificador do envio inválido');

  const existente = db.prepare('SELECT * FROM kb_midias WHERE cliente_id = ?').get(clienteId);
  if (existente) {
    if (existente.card_id !== Number(cardId)) throw new ErroAcao(409, 'Identificador do envio já usado em outro card');
    if (existente.status === 'enviado') return { midia_id: existente.id, ja_enviado: true };
    return { midia_id: existente.id, mime: existente.mime, ...(await urlsDeEnvio(storage, existente)) };
  }

  const c = cardAtivo(db, cardId);
  const { base, ext, bytes, dur } = validarPedido(dados);
  // Mídia de item de checklist: fica presa ao item (e à avaria), nunca solta no card.
  const vinculo = require('./checklists').validarVinculoMidia(db, c.id, dados) || {};
  const comMiniatura = Boolean(dados.miniatura) && (dados.tipo === 'foto' || dados.tipo === 'video');
  const chave = novaChave(c.id, ext, agora);
  const id = db.prepare(`INSERT INTO kb_midias (cliente_id, chave_objeto, chave_miniatura, tipo, mime, tamanho_bytes, duracao_s,
      largura, altura, card_id, checklist_execucao_id, checklist_item_id, avaria_id, status, autor_nome, criado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pendente', ?, ?)`).run(
    clienteId, chave.objeto, comMiniatura ? chave.miniatura : null, dados.tipo, base, bytes, dur,
    Number(dados.largura) || null, Number(dados.altura) || null, c.id,
    vinculo.execucao_id || null, vinculo.item_id || null, vinculo.avaria_id || null, op, agora,
  ).lastInsertRowid;
  const m = db.prepare('SELECT * FROM kb_midias WHERE id = ?').get(id);
  return { midia_id: id, mime: base, ...(await urlsDeEnvio(storage, m)) };
}

// Passo 2: confere no bucket e publica na linha do tempo.
async function confirmarEnvio(db, storage, midiaId, { legenda, operador }, { agora = agoraUtc() } = {}) {
  if (!storage || !storage.configurado) throw new ErroAcao(503, 'Armazenamento de mídia não configurado no servidor');
  const op = validarOperador(operador);
  const leg = limparTexto(legenda, MAX_LEGENDA) || null;
  const m = db.prepare('SELECT * FROM kb_midias WHERE id = ?').get(Number(midiaId));
  if (!m) throw new ErroAcao(404, 'Mídia não encontrada');
  if (m.status === 'enviado') {
    const ev = db.prepare('SELECT id FROM kb_eventos WHERE midia_id = ?').get(m.id);
    return { midia_id: m.id, evento_id: ev ? ev.id : null, ja_enviado: true };
  }
  cardAtivo(db, m.card_id);

  const obj = await storage.info(m.chave_objeto);
  if (!obj.existe) throw new ErroAcao(409, 'O arquivo ainda não chegou ao armazenamento: tente enviar de novo');
  if (m.tamanho_bytes && obj.tamanho !== m.tamanho_bytes) {
    throw new ErroAcao(409, `Arquivo incompleto no armazenamento (${obj.tamanho} de ${m.tamanho_bytes} bytes): tente enviar de novo`);
  }
  let chaveMini = m.chave_miniatura;
  if (chaveMini && !(await storage.info(chaveMini)).existe) chaveMini = null; // sem miniatura, a tela usa o original

  return db.transaction(() => {
    const atual = db.prepare('SELECT status FROM kb_midias WHERE id = ?').get(m.id);
    if (atual.status === 'enviado') {
      const ev = db.prepare('SELECT id FROM kb_eventos WHERE midia_id = ?').get(m.id);
      return { midia_id: m.id, evento_id: ev ? ev.id : null, ja_enviado: true };
    }
    db.prepare(`UPDATE kb_midias SET status = 'enviado', enviado_em = ?, tamanho_bytes = ?, chave_miniatura = ?, legenda = ?
                WHERE id = ?`).run(agora, obj.tamanho, chaveMini, leg, m.id);
    // Foto de checklist não vira registro avulso: o checklist inteiro entra na linha do tempo ao finalizar.
    // Se o checklist já foi finalizado, a mídia nova entra como edição (com operador e hora).
    if (m.checklist_execucao_id) {
      require('./checklists').midiaAdicionada(db, m, op, agora);
      return { midia_id: m.id, evento_id: null, ja_enviado: false, checklist: true };
    }
    const eventoId = inserirEvento(db, { cardId: m.card_id, tipo: m.tipo, texto: leg, midiaId: m.id, operador: op, agora });
    return { midia_id: m.id, evento_id: eventoId, ja_enviado: false };
  })();
}

// ---------- leitura ----------
// Nome sugerido no download do PDF: "vistoria-entrada-v2.pdf".
function nomePdf(e) {
  let dados = {};
  try { dados = JSON.parse(e.dados || '{}'); } catch (_) { /* dados antigos */ }
  const tipo = dados.tipo || (/Vistoria de Entrada/i.test(e.texto || '') ? 'vistoria_entrada' : null);
  const base = tipo ? tipo.replace(/_/g, '-') : `documento-${e.id}`;
  const via = dados.via && dados.via !== 'unica' ? `-${dados.via}` : '';
  return `${base}${via}-v${dados.versao || 1}.pdf`;
}

async function listarEventos(db, storage, cardId) {
  const eventos = db.prepare(`
    SELECT e.id, e.tipo, e.texto, e.dados, e.operador_nome, e.criado_em, e.editado_em,
           (SELECT COUNT(*) FROM kb_eventos_versoes v WHERE v.evento_id = e.id) AS versoes,
           m.id AS m_id, m.tipo AS m_tipo, m.mime AS m_mime, m.chave_objeto, m.chave_miniatura,
           m.tamanho_bytes, m.duracao_s, m.largura, m.altura
    FROM kb_eventos e LEFT JOIN kb_midias m ON m.id = e.midia_id
    WHERE e.card_id = ? AND e.removido_em IS NULL
    ORDER BY e.criado_em DESC, e.id DESC`).all(Number(cardId));

  const podeAssinar = storage && storage.configurado;
  const out = [];
  for (const e of eventos) {
    let midia = null;
    if (e.m_id) {
      midia = {
        id: e.m_id, tipo: e.m_tipo, mime: e.m_mime, tamanho: e.tamanho_bytes, duracao: e.duracao_s,
        largura: e.largura, altura: e.altura, url: null, miniatura_url: null,
      };
      if (podeAssinar) {
        midia.url = e.m_tipo === 'pdf'
          ? await storage.urlVer(e.chave_objeto, { nomeArquivo: nomePdf(e), contentType: 'application/pdf' })
          : await storage.urlVer(e.chave_objeto);
        midia.miniatura_url = e.chave_miniatura ? await storage.urlVer(e.chave_miniatura) : null;
      }
    }
    let dados = null;
    try { dados = e.dados ? JSON.parse(e.dados) : null; } catch (_) { /* dados antigos */ }
    out.push({
      id: e.id, tipo: e.tipo, texto: e.texto, dados, operador_nome: e.operador_nome, criado_em: e.criado_em,
      editado_em: e.editado_em, versoes: e.versoes, editavel: e.tipo === 'texto', removivel: TIPOS_REMOVIVEIS.has(e.tipo), midia,
    });
  }
  return out;
}

module.exports = {
  postarTexto, editarTexto, versoesTexto, removerRegistro, pedirEnvio, confirmarEnvio, listarEventos,
  TIPOS, DURACAO_MAX_VIDEO_S, MAX_TEXTO,
};
