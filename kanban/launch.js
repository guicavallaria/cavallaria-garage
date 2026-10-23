// Relatórios de escaneamento LAUNCH (Etapa 6, seção 11 do prompt).
//
// Todo veículo é escaneado na entrada; o relatório chega por e-mail com um PDF chamado
// Marca_Chassi_AllSystems…pdf (ex.: BMW_WBAGL61002DM57925_AllSystems.pdf).
//  - marca e chassi (VIN, 17 caracteres) saem do nome do arquivo;
//  - o PDF vai para o bucket; o vínculo com o card é SEMPRE pelo chassi (comparação exata,
//    maiúsculas) — o chassi vem do cadastro do veículo no Onmotor. Se o card ainda não tem
//    chassi, vale o chassi já conhecido daquela placa na tabela `veiculos`;
//  - relatório principal do card = o de data mais próxima da entrada da OS (antes ou depois);
//    os demais do mesmo chassi no período da OS ficam como "adicionais", em ordem cronológica;
//  - sem card correspondente: fica em "Relatórios não vinculados" até alguém vincular à mão
//    ou até o card daquele chassi aparecer (vínculo automático).
const crypto = require('crypto');
const { ErroAcao, validarOperador } = require('./acoes');
const { caminhoAbrir } = require('./arquivos');
const { normalizarChassi } = require('./onmotor-os');
const { formatarBR } = require('./datas');

const agoraUtc = () => new Date().toISOString();
// O escaneamento costuma ser feito na chegada, às vezes antes de a OS ser aberta no Onmotor.
const TOLERANCIA_ANTES_DIAS = 3;
const DIA_MS = 86_400_000;
const MAX_PDF = 30 * 1024 * 1024;

// "BMW_WBAGL61002DM57925_AllSystems.pdf" → { marca: 'BMW', chassi: 'WBAGL61002DM57925' }
function extrairDoNome(nomeArquivo) {
  const base = String(nomeArquivo || '').replace(/\.pdf$/i, '');
  const partes = base.split(/[_\s-]+/).filter(Boolean);
  const i = partes.findIndex((p) => normalizarChassi(p));
  if (i < 0) return { marca: null, chassi: null }; // fora do padrão Marca_Chassi_…: não adivinha a marca
  return { marca: i > 0 ? partes.slice(0, i).join(' ') : null, chassi: normalizarChassi(partes[i]) };
}

// OS sem etapa "entrada" no Onmotor: vale a etapa mais antiga (os_inicio_em); só em último caso a criação do card.
const entradaDoCard = (c) => c.os_entrada_em || c.os_inicio_em || c.criado_em;

// A data do relatório cai no período da OS? [entrada − 3 dias, finalização/arquivamento ou agora]
function noPeriodo(card, quando) {
  const t = Date.parse(quando);
  const ini = Date.parse(entradaDoCard(card)) - TOLERANCIA_ANTES_DIAS * DIA_MS;
  const fimIso = card.os_finalizada_em || card.arquivado_em;
  const fim = fimIso ? Date.parse(fimIso) + DIA_MS : Infinity; // 1 dia de folga para o relatório final
  return t >= ini && t <= fim;
}

// Cards daquele chassi (pelo chassi do card ou, sem chassi, pela placa conhecida em `veiculos`).
function cardsDoChassi(db, chassi) {
  if (!chassi) return [];
  return db.prepare(`SELECT * FROM kb_cards c WHERE c.chassi = ?
      OR (c.chassi IS NULL AND c.placa_normalizada IS NOT NULL
          AND c.placa_normalizada = (SELECT v.placa_normalizada FROM veiculos v WHERE v.chassi = ?))
      ORDER BY c.id`).all(chassi, chassi);
}

// Card para vincular automaticamente: card ATIVO do chassi cujo período contém a data do relatório;
// havendo mais de um, o de entrada mais próxima.
function cardParaRelatorio(db, rel) {
  const candidatos = cardsDoChassi(db, rel.chassi).filter((c) => !c.arquivado_em && noPeriodo(c, rel.relatorio_em));
  if (!candidatos.length) return null;
  const t = Date.parse(rel.relatorio_em);
  return candidatos.sort((a, b) => Math.abs(Date.parse(entradaDoCard(a)) - t) - Math.abs(Date.parse(entradaDoCard(b)) - t))[0];
}

// Principal = data mais próxima da entrada da OS; os demais são adicionais.
function recalcularPrincipal(db, cardId) {
  const card = db.prepare('SELECT * FROM kb_cards WHERE id = ?').get(cardId);
  const rels = db.prepare('SELECT id, relatorio_em FROM launch_relatorios WHERE card_id = ? AND removido_em IS NULL').all(cardId);
  if (!rels.length) return null;
  const ent = Date.parse(entradaDoCard(card));
  const principal = rels.sort((a, b) => Math.abs(Date.parse(a.relatorio_em) - ent) - Math.abs(Date.parse(b.relatorio_em) - ent) || a.id - b.id)[0];
  db.prepare('UPDATE launch_relatorios SET principal = CASE WHEN id = ? THEN 1 ELSE 0 END WHERE card_id = ?').run(principal.id, cardId);
  return principal.id;
}

function vincular(db, relId, cardId, { por, agora = agoraUtc() }) {
  return db.transaction(() => {
    const rel = db.prepare('SELECT * FROM launch_relatorios WHERE id = ? AND removido_em IS NULL').get(Number(relId));
    if (!rel) throw new ErroAcao(404, 'Relatório não encontrado');
    const card = db.prepare('SELECT * FROM kb_cards WHERE id = ?').get(Number(cardId));
    if (!card) throw new ErroAcao(404, 'Card não encontrado');
    if (rel.card_id === card.id) return rel;
    db.prepare('UPDATE launch_relatorios SET card_id = ?, vinculado_em = ?, vinculado_por = ? WHERE id = ?').run(card.id, agora, por, rel.id);
    db.prepare('UPDATE kb_midias SET card_id = ? WHERE id = ?').run(card.id, rel.midia_id);
    // vínculo à mão de um card sem chassi: guarda placa ↔ chassi para casar os próximos relatórios
    if (rel.chassi && !card.chassi && card.placa_normalizada) {
      db.prepare(`INSERT INTO veiculos (chassi, placa_normalizada, marca, primeiro_visto_em, ultimo_visto_em) VALUES (?, ?, ?, ?, ?)
                  ON CONFLICT(chassi) DO UPDATE SET placa_normalizada = excluded.placa_normalizada, ultimo_visto_em = excluded.ultimo_visto_em`)
        .run(rel.chassi, card.placa_normalizada, rel.marca, agora, agora);
    }
    recalcularPrincipal(db, card.id);
    // Texto do prompt. Principal/adicional não vai no texto: muda quando chega outro relatório
    // (a seção "Relatórios Launch" do card mostra sempre a situação atual).
    db.prepare(`INSERT INTO kb_eventos (card_id, tipo, texto, dados, midia_id, operador_nome, criado_em) VALUES (?, 'launch', ?, ?, ?, ?, ?)`)
      .run(card.id, `Relatório Launch anexado — ${formatarBR(rel.relatorio_em)}${por === 'automático' ? '' : ` (vinculado por ${por})`}`,
        JSON.stringify({ relatorio_id: rel.id, chassi: rel.chassi }), rel.midia_id, por === 'automático' ? 'Sistema' : por, agora);
    return db.prepare('SELECT * FROM launch_relatorios WHERE id = ?').get(rel.id);
  })();
}

// Guarda o PDF no bucket e registra; tenta o vínculo automático.
async function importarRelatorio(db, storage, { origem, messageId = null, nomeArquivo, bytes, relatorioEm, operador = 'Sistema', cardId = null, agora = agoraUtc() }) {
  if (!storage || !storage.configurado) throw new ErroAcao(503, 'Armazenamento não configurado');
  const nome = String(nomeArquivo || '').split(/[\\/]/).pop().slice(0, 200);
  if (!/\.pdf$/i.test(nome)) throw new ErroAcao(415, 'O relatório precisa ser um PDF');
  if (!bytes || !bytes.length) throw new ErroAcao(400, 'PDF vazio');
  if (bytes.length > MAX_PDF) throw new ErroAcao(413, 'PDF grande demais (máximo 30 MB)');
  if (bytes.subarray(0, 5).toString() !== '%PDF-') throw new ErroAcao(415, 'O arquivo não é um PDF válido');
  if (messageId && db.prepare('SELECT 1 FROM launch_relatorios WHERE message_id = ? AND nome_arquivo = ?').get(messageId, nome)) {
    return { duplicado: true };
  }
  // O scanner às vezes manda o mesmo relatório em dois e-mails; o nome já traz data e hora até o segundo.
  if (origem === 'email' && /\d{12,}/.test(nome) && db.prepare("SELECT 1 FROM launch_relatorios WHERE origem = 'email' AND nome_arquivo = ? AND removido_em IS NULL").get(nome)) {
    return { duplicado: true };
  }
  const { marca, chassi } = extrairDoNome(nome);
  const d = new Date(agora);
  const chave = `launch/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${crypto.randomUUID()}.pdf`;
  await storage.enviar(chave, bytes, 'application/pdf');

  const rel = db.transaction(() => {
    const midiaId = db.prepare(`INSERT INTO kb_midias (cliente_id, chave_objeto, tipo, mime, tamanho_bytes, card_id, status, autor_nome, criado_em, enviado_em)
        VALUES (?, ?, 'pdf', 'application/pdf', ?, NULL, 'enviado', ?, ?, ?)`).run(`launch-${crypto.randomUUID()}`, chave, bytes.length, operador, agora, agora).lastInsertRowid;
    const id = db.prepare(`INSERT INTO launch_relatorios (origem, message_id, nome_arquivo, marca, chassi, relatorio_em, midia_id, criado_em, criado_por)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(origem, messageId, nome, marca, chassi, relatorioEm || agora, midiaId, agora, operador).lastInsertRowid;
    return db.prepare('SELECT * FROM launch_relatorios WHERE id = ?').get(id);
  })();

  // envio manual a partir de um card: vincula a ele; senão, procura pelo chassi
  if (cardId) return { relatorio: vincular(db, rel.id, cardId, { por: validarOperador(operador), agora }), vinculado: true };
  const card = cardParaRelatorio(db, rel);
  if (card) return { relatorio: vincular(db, rel.id, card.id, { por: 'automático', agora }), vinculado: true };
  return { relatorio: rel, vinculado: false };
}

// Card que acabou de ganhar chassi (ou nasceu): puxa os relatórios não vinculados daquele chassi.
function vincularPendentes(db, cardId, { agora = agoraUtc() } = {}) {
  const card = db.prepare('SELECT * FROM kb_cards WHERE id = ?').get(Number(cardId));
  if (!card || card.arquivado_em) return 0;
  const chassi = card.chassi || (card.placa_normalizada
    && (db.prepare('SELECT chassi FROM veiculos WHERE placa_normalizada = ? ORDER BY ultimo_visto_em DESC LIMIT 1').get(card.placa_normalizada) || {}).chassi);
  if (!chassi) return 0;
  let n = 0;
  for (const rel of db.prepare('SELECT * FROM launch_relatorios WHERE card_id IS NULL AND removido_em IS NULL AND chassi = ? ORDER BY relatorio_em').all(chassi)) {
    if (!noPeriodo(card, rel.relatorio_em)) continue;
    vincular(db, rel.id, card.id, { por: 'automático', agora });
    n++;
  }
  return n;
}

function vincularManual(db, relId, cardId, { operador, agora = agoraUtc() }) {
  return vincular(db, relId, cardId, { por: validarOperador(operador), agora });
}

// Desfaz um vínculo errado (volta para "não vinculados").
function desvincular(db, relId, { operador, agora = agoraUtc() }) {
  const op = validarOperador(operador);
  return db.transaction(() => {
    const rel = db.prepare('SELECT * FROM launch_relatorios WHERE id = ? AND removido_em IS NULL').get(Number(relId));
    if (!rel || !rel.card_id) throw new ErroAcao(404, 'Relatório vinculado não encontrado');
    db.prepare('UPDATE launch_relatorios SET card_id = NULL, principal = 0, vinculado_em = NULL, vinculado_por = NULL WHERE id = ?').run(rel.id);
    db.prepare('UPDATE kb_midias SET card_id = NULL WHERE id = ?').run(rel.midia_id);
    recalcularPrincipal(db, rel.card_id);
    db.prepare(`INSERT INTO kb_eventos (card_id, tipo, texto, dados, operador_nome, criado_em) VALUES (?, 'launch', ?, ?, ?, ?)`)
      .run(rel.card_id, `Relatório Launch de ${formatarBR(rel.relatorio_em)} desvinculado por ${op}`, JSON.stringify({ relatorio_id: rel.id }), op, agora);
    return { ok: true };
  })();
}

async function comUrl(storage, rels) {
  const out = [];
  for (const r of rels) {
    out.push({
      ...r,
      url: storage && storage.configurado ? caminhoAbrir(r.midia_id) : null, // download auditado
    });
  }
  return out;
}

const SQL_REL = `SELECT r.id, r.origem, r.nome_arquivo, r.marca, r.chassi, r.relatorio_em, r.card_id, r.principal, r.vinculado_em, r.vinculado_por,
  r.criado_em, r.midia_id, m.chave_objeto, m.tamanho_bytes FROM launch_relatorios r JOIN kb_midias m ON m.id = r.midia_id WHERE r.removido_em IS NULL`;

// Do card: principal primeiro; adicionais em ordem cronológica.
async function listarDoCard(db, storage, cardId) {
  const rels = db.prepare(`${SQL_REL} AND r.card_id = ? ORDER BY r.principal DESC, r.relatorio_em`).all(Number(cardId));
  return comUrl(storage, rels);
}

// "Relatórios não vinculados", com sugestões de card (mesmo chassi/placa ou marca), mais recentes primeiro.
// Sem card, "pendente" = vale alguém olhar: chegou nos últimos 7 dias ou existe card ATIVO do mesmo
// chassi/placa. O resto (a caixa recebe ~300 relatórios por mês, a maioria de OS já fechadas) fica
// guardado como "antigo", fora da lista e do contador; o vínculo automático continua valendo para ele.
const DIAS_PENDENTE = 7;
const SQL_PENDENTE = `(r.relatorio_em >= ? OR EXISTS (SELECT 1 FROM kb_cards c WHERE c.arquivado_em IS NULL AND (c.chassi = r.chassi
    OR (c.chassi IS NULL AND c.placa_normalizada IS NOT NULL
        AND c.placa_normalizada = (SELECT v.placa_normalizada FROM veiculos v WHERE v.chassi = r.chassi)))))`;
const limitePendente = (agora) => new Date(new Date(agora).getTime() - DIAS_PENDENTE * DIA_MS).toISOString();

function contarNaoVinculados(db, { agora = agoraUtc() } = {}) {
  const r = db.prepare(`SELECT COUNT(*) AS total, SUM(${SQL_PENDENTE}) AS pendentes
      FROM launch_relatorios r WHERE r.card_id IS NULL AND r.removido_em IS NULL`).get(limitePendente(agora));
  return { pendentes: r.pendentes || 0, antigos: (r.total || 0) - (r.pendentes || 0) };
}

async function listarNaoVinculados(db, storage, { antigos = false, agora = agoraUtc() } = {}) {
  const rels = antigos
    ? db.prepare(`${SQL_REL} AND r.card_id IS NULL AND NOT ${SQL_PENDENTE} ORDER BY r.relatorio_em DESC`).all(limitePendente(agora))
    : db.prepare(`${SQL_REL} AND r.card_id IS NULL AND ${SQL_PENDENTE} ORDER BY r.relatorio_em DESC`).all(limitePendente(agora));
  const out = await comUrl(storage, rels);
  for (const r of out) {
    r.sugestoes = cardsDoChassi(db, r.chassi).map((c) => ({ id: c.id, os_numero: c.os_numero, placa: c.placa, modelo: c.modelo, arquivado: Boolean(c.arquivado_em) }));
  }
  return out;
}

module.exports = {
  extrairDoNome, noPeriodo, cardParaRelatorio, recalcularPrincipal, importarRelatorio, vincularPendentes, vincularManual, desvincular,
  listarDoCard, listarNaoVinculados, contarNaoVinculados, TOLERANCIA_ANTES_DIAS, MAX_PDF, DIAS_PENDENTE,
};
