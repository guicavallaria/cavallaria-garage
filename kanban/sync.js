// Sincronização Onmotor → Kanban de OS (só leitura do Onmotor; nunca escreve lá).
//
// A aba Serviços → Novidades é uma FOTO das OS abertas (3 seções: em execução,
// finalizados recentes, aguardando entrada), não uma lista de eventos. "OS criada",
// "OS alterada" e "OS finalizada" saem da comparação com o que o kanban já sabe:
//   - OS que o kanban não conhece                → card novo (fase 1)
//   - OS conhecida com dados diferentes (hash)   → atualiza veículo/cliente/etapas
//   - OS conhecida que passou a finalizada       → marca "OS finalizada no Onmotor"
//   - card na fase 9 + OS finalizada             → arquiva sozinho
//   - card ativo que sumiu da Novidades          → confere na página da OS
// Na PRIMEIRA leitura (carga inicial) todas as OS abertas viram card e a fase sai da
// etapa do Onmotor; depois disso a fase só muda pela mão do operador.
//
// Leitura que falha não altera nenhum card: só grava o erro no log, e a tela mostra
// "Sincronização com Onmotor parada desde hh:mm".
const crypto = require('crypto');
const { parseNovidades } = require('../patio/parser');
const { formatarPlaca } = require('../patio/placa');
const { dentroDaJanela } = require('../patio/tz');
const { buscarDetalhesOS, extrairDadosOS, anoVeiculo } = require('./onmotor-os');
const { spParaUtc, formatarBR } = require('./datas');

const EMPRESA = 'cavallaria';
const LIMITE_DETALHES = 15;        // cada detalhe = página da OS (~0,4–1 MB) + modal do veículo
const LIMITE_SUMIDAS = 5;          // OS sumidas conferidas por rodada
const REVERIFICAR_SUMIDA_MIN = 60; // uma OS sumida e não finalizada é conferida de novo a cada 1 h
const MAX_TENTATIVAS_DETALHE = 10;

// Janela do job: segunda a sexta, 07:00–19:00 (decisão de 23/10/2026).
const JANELA_KANBAN = { diasSemana: [1, 2, 3, 4, 5], inicioMin: 7 * 60, fimMin: 19 * 60 };

const ETAPA_FASE = [
  // da etapa mais avançada para a menos avançada; vale só na carga inicial
  ['emExecucao', 7, 'Em execução'],
  ['aguardandoPeca', 5, 'Aguardando peças'],
  ['orcamento', 6, 'Orçamento aprovado'],
  ['entrada', 2, 'Entrada'],
];

function faseDaCargaInicial(etapas = {}) {
  for (const [campo, fase, nome] of ETAPA_FASE) if (etapas[campo]) return { fase, etapa: nome, campo };
  return { fase: 1, etapa: 'Sem entrada', campo: null };
}

const agoraUtc = () => new Date().toISOString();
const sha1 = (s) => crypto.createHash('sha1').update(s).digest('hex');

function hashLinha(l) {
  return sha1(JSON.stringify([l.osId, l.placa || l.placaTexto, l.modelo, l.proprietario, l.telefone, l.entrada, l.etapas]));
}

function placaDaLinha(l) {
  return { placa: l.placa ? formatarPlaca(l.placa) : (l.placaTexto || null), placa_normalizada: l.placa || null };
}

function criarFuncoes(db) {
  const st = {
    card: db.prepare('SELECT * FROM kb_cards WHERE empresa = ? AND os_numero = ?'),
    evento: db.prepare(`INSERT INTO kb_eventos (card_id, tipo, texto, dados, operador_nome, criado_em)
                        VALUES (?, ?, ?, ?, 'Sistema', ?)`),
    onmotor: db.prepare(`INSERT INTO onmotor_eventos (empresa, os_numero, os_id_interno, tipo, payload, hash, lido_em, processado, processado_em, erro)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    jaIgnorada: db.prepare("SELECT 1 FROM onmotor_eventos WHERE empresa = ? AND os_numero = ? AND tipo = 'ignorada' LIMIT 1"),
  };
  return {
    card: (osNumero) => st.card.get(EMPRESA, osNumero),
    evento: (cardId, tipo, texto, dados, agora) =>
      st.evento.run(cardId, tipo, texto, dados ? JSON.stringify(dados) : null, agora),
    onmotor: ({ osNumero, osId, tipo, payload, hash, agora, erro = null }) =>
      st.onmotor.run(EMPRESA, osNumero, osId || null, tipo, JSON.stringify(payload), hash, agora, 1, agora, erro),
    jaIgnorada: (osNumero) => Boolean(st.jaIgnorada.get(EMPRESA, osNumero)),
  };
}

// Marca a OS como finalizada no card (uma vez). O arquivamento é feito depois, por regra.
function registrarFinalizacao(db, f, card, finalizadaEm, agora) {
  db.prepare('UPDATE kb_cards SET os_finalizada_em = ?, atualizado_em = ? WHERE id = ?').run(finalizadaEm, agora, card.id);
  const fase = db.prepare('SELECT nome FROM kb_fases WHERE id = ?').get(card.fase_id).nome;
  let texto = `OS finalizada no Onmotor em ${formatarBR(finalizadaEm)}`;
  if (!card.arquivado_em && card.fase_id !== 9) texto += ` — o card continua em "${fase}" até alguém mover ou arquivar`;
  f.evento(card.id, 'os_finalizada_onmotor', texto, { finalizada_em: finalizadaEm }, agora);
}

// Aplica uma leitura da Novidades (síncrono, dentro de uma transação).
function aplicarLeitura(db, linhas, { agora, primeiraCarga }) {
  const f = criarFuncoes(db);
  const r = { criados: 0, atualizados: 0, finalizados: 0, ignoradas: 0, vistos: new Set(), avisos: [] };

  const inserir = db.prepare(`INSERT INTO kb_cards (
      empresa, os_numero, os_id_interno, placa, placa_normalizada, modelo, km,
      cliente_nome, cliente_telefone, os_entrada_em, os_etapas, os_finalizada_em, os_hash, os_visto_em,
      fase_id, fase_desde, origem, criado_em, atualizado_em)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`);

  for (const l of linhas) {
    if (!l.osNumber) { r.avisos.push('linha da Novidades sem número de OS ignorada'); continue; }
    const h = hashLinha(l);
    const finalizada = l.etapas.finalizado === true;
    const finalizadaEm = finalizada ? (spParaUtc(l.datas && l.datas.finalizado) || agora) : null;
    const { placa, placa_normalizada } = placaDaLinha(l);
    const card = f.card(l.osNumber);

    if (!card) {
      // OS que o kanban nunca viu e que já chegou finalizada: não vira card.
      if (finalizada) {
        if (!f.jaIgnorada(l.osNumber)) {
          f.onmotor({ osNumero: l.osNumber, osId: l.osId, tipo: 'ignorada', payload: l, hash: h, agora,
            erro: 'OS já finalizada na primeira leitura — card não criado' });
        }
        r.ignoradas++;
        continue;
      }
      const { fase, etapa, campo } = primeiraCarga ? faseDaCargaInicial(l.etapas) : { fase: 1, etapa: null, campo: null };
      // Na carga inicial, o "tempo na fase" conta da data da etapa no Onmotor, não do momento da importação.
      const faseDesde = (campo && l.datas && spParaUtc(l.datas[campo])) || agora;
      const id = inserir.run(
        EMPRESA, l.osNumber, l.osId || null, placa, placa_normalizada, l.modelo || null, l.km || null,
        l.proprietario || null, l.telefone || null, spParaUtc(l.entrada), JSON.stringify(l.etapas), h, agora,
        fase, faseDesde, primeiraCarga ? 'carga_inicial' : 'sync', agora, agora,
      ).lastInsertRowid;
      f.evento(id, 'criado', primeiraCarga
        ? `Card importado do Onmotor na carga inicial — OS ${l.osNumber} (etapa no Onmotor: ${etapa})`
        : `Card criado automaticamente — OS ${l.osNumber} aberta no Onmotor`, { fase_id: fase }, agora);
      f.onmotor({ osNumero: l.osNumber, osId: l.osId, tipo: 'criada', payload: l, hash: h, agora });
      r.vistos.add(id);
      r.criados++;
      continue;
    }

    r.vistos.add(card.id);
    db.prepare('UPDATE kb_cards SET os_visto_em = ?, os_sumiu_em = NULL WHERE id = ?').run(agora, card.id);

    if (card.os_hash !== h) {
      const mudancas = [];
      const trocouVeiculo = (placa_normalizada || placa) !== (card.placa_normalizada || card.placa);
      if (trocouVeiculo) mudancas.push({ campo: 'Veículo', de: card.placa, para: placa });
      if ((l.proprietario || null) !== card.cliente_nome) mudancas.push({ campo: 'Cliente', de: card.cliente_nome, para: l.proprietario || null });
      if ((l.telefone || null) !== card.cliente_telefone) mudancas.push({ campo: 'Telefone', de: card.cliente_telefone, para: l.telefone || null });

      db.prepare(`UPDATE kb_cards SET
          os_id_interno = COALESCE(?, os_id_interno), placa = ?, placa_normalizada = ?,
          modelo = CASE WHEN ? THEN ? ELSE COALESCE(modelo, ?) END,
          km = COALESCE(?, km), cliente_nome = ?, cliente_telefone = ?,
          os_entrada_em = COALESCE(?, os_entrada_em), os_etapas = ?, os_hash = ?,
          detalhes_ok = CASE WHEN ? THEN 0 ELSE detalhes_ok END,
          detalhes_tentativas = CASE WHEN ? THEN 0 ELSE detalhes_tentativas END,
          atualizado_em = ?
        WHERE id = ?`).run(
        l.osId || null, placa, placa_normalizada,
        trocouVeiculo ? 1 : 0, l.modelo || null, l.modelo || null,
        l.km || null, l.proprietario || null, l.telefone || null,
        spParaUtc(l.entrada), JSON.stringify(l.etapas), h,
        trocouVeiculo ? 1 : 0, trocouVeiculo ? 1 : 0,
        agora, card.id,
      );
      if (mudancas.length) {
        const texto = 'Dados da OS atualizados pelo Onmotor — ' +
          mudancas.map((m) => `${m.campo}: ${m.de || '—'} → ${m.para || '—'}`).join('; ');
        f.evento(card.id, 'os_alterada_onmotor', texto, { mudancas }, agora);
      }
      f.onmotor({ osNumero: l.osNumber, osId: l.osId, tipo: finalizada && !card.os_finalizada_em ? 'finalizada' : 'alterada', payload: l, hash: h, agora });
      r.atualizados++;
    }

    if (finalizada && !card.os_finalizada_em) {
      registrarFinalizacao(db, f, card, finalizadaEm, agora);
      r.finalizados++;
    } else if (!finalizada && card.os_finalizada_em && l.etapas.finalizado === false) {
      db.prepare('UPDATE kb_cards SET os_finalizada_em = NULL, atualizado_em = ? WHERE id = ?').run(agora, card.id);
      f.evento(card.id, 'os_alterada_onmotor', 'OS reaberta no Onmotor (finalização desfeita)', null, agora);
    }
  }
  return r;
}

// Cards ativos que não apareceram nesta leitura: confere na página da OS se foram finalizados.
async function conferirSumidas(db, client, vistos, { agora, limite = LIMITE_SUMIDAS, avisos }) {
  const f = criarFuncoes(db);
  const candidatos = db.prepare(`SELECT * FROM kb_cards
      WHERE empresa = ? AND arquivado_em IS NULL AND os_finalizada_em IS NULL AND os_id_interno IS NOT NULL
      ORDER BY COALESCE(os_verificada_em, '') ASC, id ASC`).all(EMPRESA)
    .filter((c) => !vistos.has(c.id));
  let finalizados = 0;
  let conferidas = 0;
  const limiteMs = Date.parse(agora) - REVERIFICAR_SUMIDA_MIN * 60_000;
  for (const card of candidatos) {
    if (!card.os_sumiu_em) {
      db.prepare('UPDATE kb_cards SET os_sumiu_em = ? WHERE id = ?').run(agora, card.id);
      f.onmotor({ osNumero: card.os_numero, osId: card.os_id_interno, tipo: 'sumiu', payload: { os_numero: card.os_numero }, hash: 'sumiu', agora });
    }
    if (conferidas >= limite) continue;
    if (card.os_verificada_em && Date.parse(card.os_verificada_em) > limiteMs) continue;
    conferidas++;
    try {
      const os = extrairDadosOS(await client.osHtml(card.os_id_interno));
      db.prepare('UPDATE kb_cards SET os_verificada_em = ? WHERE id = ?').run(agora, card.id);
      if (os.etapas.finalizado === true) {
        const atual = db.prepare('SELECT * FROM kb_cards WHERE id = ?').get(card.id);
        registrarFinalizacao(db, f, atual, spParaUtc(os.finalizadaEm) || agora, agora);
        finalizados++;
      }
    } catch (e) {
      avisos.push(`OS ${card.os_numero} saiu da Novidades e não deu para conferir: ${e.message}`);
    }
  }
  return { finalizados };
}

// Regra do prompt: fase 9 + OS finalizada no Onmotor → arquiva sozinho. Em outra fase, não.
function arquivarFinalizadosNaFase9(db, agora) {
  const f = criarFuncoes(db);
  const cards = db.prepare(`SELECT * FROM kb_cards
      WHERE arquivado_em IS NULL AND fase_id = 9 AND os_finalizada_em IS NOT NULL AND auto_arquivar_bloqueado = 0`).all();
  for (const c of cards) {
    db.prepare(`UPDATE kb_cards SET arquivado_em = ?, arquivado_por = 'Sistema', arquivado_motivo = 'automatico', atualizado_em = ?
                WHERE id = ?`).run(agora, agora, c.id);
    f.evento(c.id, 'arquivado', `Arquivado automaticamente — OS finalizada no Onmotor em ${formatarBR(c.os_finalizada_em)}`,
      { motivo: 'automatico' }, agora);
  }
  return cards.length;
}

// Completa marca, modelo, ano e chassi com a página da OS + cadastro do veículo.
async function enriquecerDetalhes(db, client, { agora, limite = LIMITE_DETALHES, avisos }) {
  const pendentes = db.prepare(`SELECT * FROM kb_cards
      WHERE arquivado_em IS NULL AND detalhes_ok = 0 AND os_id_interno IS NOT NULL AND detalhes_tentativas < ?
      ORDER BY detalhes_tentativas ASC, id ASC LIMIT ?`).all(MAX_TENTATIVAS_DETALHE, limite);
  const upsertVeiculo = db.prepare(`INSERT INTO veiculos (chassi, placa_normalizada, marca, modelo, ano, primeiro_visto_em, ultimo_visto_em)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(chassi) DO UPDATE SET placa_normalizada = COALESCE(excluded.placa_normalizada, placa_normalizada),
        marca = COALESCE(NULLIF(excluded.marca, ''), marca), modelo = COALESCE(NULLIF(excluded.modelo, ''), modelo),
        ano = COALESCE(NULLIF(excluded.ano, ''), ano), ultimo_visto_em = excluded.ultimo_visto_em
      RETURNING id`);
  let ok = 0;
  for (const card of pendentes) {
    try {
      const { veiculo } = await buscarDetalhesOS(client, card.os_id_interno);
      const ano = anoVeiculo(veiculo);
      let veiculoId = null;
      if (veiculo.chassi) {
        veiculoId = upsertVeiculo.get(veiculo.chassi, card.placa_normalizada, veiculo.fabricante, veiculo.modelo, ano, agora, agora).id;
      } else {
        avisos.push(`OS ${card.os_numero}: chassi ausente ou inválido no cadastro do veículo`);
      }
      const { chassiInformado, ...detalhes } = veiculo;
      db.prepare(`UPDATE kb_cards SET marca = NULLIF(?, ''), modelo = COALESCE(NULLIF(?, ''), modelo), ano = NULLIF(?, ''),
          chassi = ?, veiculo_id = ?, veiculo_detalhes = ?, detalhes_ok = 1, detalhes_erro = NULL, atualizado_em = ?
        WHERE id = ?`).run(veiculo.fabricante, veiculo.modelo, ano, veiculo.chassi, veiculoId,
        JSON.stringify({ ...detalhes, chassi_informado: veiculo.chassi ? undefined : chassiInformado || null }), agora, card.id);
      ok++;
      // Card ganhou chassi: relatórios Launch que esperavam por ele entram agora (Etapa 6).
      if (veiculo.chassi) {
        try { require('./launch').vincularPendentes(db, card.id, { agora }); } catch (e) { avisos.push(`OS ${card.os_numero}: vínculo do Launch falhou (${e.message})`); }
      }
    } catch (e) {
      db.prepare('UPDATE kb_cards SET detalhes_tentativas = detalhes_tentativas + 1, detalhes_erro = ? WHERE id = ?')
        .run(e.message, card.id);
      avisos.push(`OS ${card.os_numero}: não consegui ler os dados do veículo (${e.message})`);
    }
  }
  return ok;
}

const lerEstado = (db, chave) => (db.prepare('SELECT valor FROM kb_estado WHERE chave = ?').get(chave) || {}).valor || null;
const gravarEstado = (db, chave, valor) =>
  db.prepare('INSERT INTO kb_estado (chave, valor) VALUES (?, ?) ON CONFLICT(chave) DO UPDATE SET valor = excluded.valor').run(chave, valor);

async function sincronizarKanban(db, { client, agoraFn = agoraUtc, broadcast = () => {}, log = console.log, origem = 'auto', limiteDetalhes = LIMITE_DETALHES } = {}) {
  const inicio = agoraFn();
  const logId = db.prepare('INSERT INTO kb_sync_log (origem, iniciado_em) VALUES (?, ?)').run(origem, inicio).lastInsertRowid;
  const fechar = db.prepare(`UPDATE kb_sync_log SET terminado_em = ?, sucesso = ?, os_lidas = ?, cards_criados = ?, cards_atualizados = ?,
      cards_finalizados = ?, cards_arquivados = ?, detalhes_lidos = ?, avisos = ?, erro = ? WHERE id = ?`);
  try {
    if (!client) throw new Error('fonte do Onmotor não configurada');
    const lido = parseNovidades(await client.novidadesHtml());
    if (!lido.ok) throw new Error('página da Novidades inválida: ' + lido.problemas.join('; '));

    const ativos = db.prepare('SELECT COUNT(*) AS n FROM kb_cards WHERE arquivado_em IS NULL').get().n;
    if (lido.linhas.length === 0 && ativos > 0) throw new Error('a Novidades veio sem nenhuma OS — leitura descartada');

    const agora = agoraFn();
    const primeiraCarga = !lerEstado(db, 'carga_inicial_em');
    const r = db.transaction(() => {
      const out = aplicarLeitura(db, lido.linhas, { agora, primeiraCarga });
      if (primeiraCarga) gravarEstado(db, 'carga_inicial_em', agora);
      return out;
    })();

    const sumidas = await conferirSumidas(db, client, r.vistos, { agora, avisos: r.avisos });
    const arquivados = arquivarFinalizadosNaFase9(db, agora);
    const detalhes = await enriquecerDetalhes(db, client, { agora, limite: limiteDetalhes, avisos: r.avisos });

    const finalizados = r.finalizados + sumidas.finalizados;
    if (r.ignoradas) r.avisos.unshift(`${r.ignoradas} OS já finalizadas na Novidades sem card (não importadas)`);
    fechar.run(agoraFn(), 1, lido.linhas.length, r.criados, r.atualizados, finalizados, arquivados, detalhes,
      r.avisos.join('\n') || null, null, logId);
    log(`kanban sync (${origem})${primeiraCarga ? ' [carga inicial]' : ''}: ${lido.linhas.length} OS lidas, ${r.criados} cards novos, ` +
      `${r.atualizados} atualizados, ${finalizados} finalizados, ${arquivados} arquivados, ${detalhes} com dados do veículo`);
    broadcast('kanban');
    return { ok: true, carga_inicial: primeiraCarga, os_lidas: lido.linhas.length, criados: r.criados, atualizados: r.atualizados,
      finalizados, arquivados, detalhes, avisos: r.avisos };
  } catch (e) {
    fechar.run(agoraFn(), 0, 0, 0, 0, 0, 0, 0, null, e.message, logId);
    log(`kanban sync (${origem}) FALHOU: ${e.message}`);
    broadcast('kanban');
    return { ok: false, erro: e.message };
  }
}

// Estado para o banner do kanban.
function estadoSyncKanban(db, { agora = new Date(), intervaloMin = 2, janela = JANELA_KANBAN } = {}) {
  const ultimaOk = db.prepare('SELECT * FROM kb_sync_log WHERE sucesso = 1 ORDER BY id DESC LIMIT 1').get();
  const ultima = db.prepare('SELECT * FROM kb_sync_log ORDER BY id DESC LIMIT 1').get();
  const minutosDesdeOk = ultimaOk ? (agora.getTime() - Date.parse(ultimaOk.terminado_em)) / 60_000 : null;
  const falhou = Boolean(ultima && ultima.terminado_em && !ultima.sucesso);
  const atrasada = dentroDaJanela(agora, janela) && minutosDesdeOk !== null && minutosDesdeOk > intervaloMin * 3 + 1;
  const primeiraTentativa = db.prepare('SELECT iniciado_em FROM kb_sync_log ORDER BY id ASC LIMIT 1').get();
  return {
    nunca_sincronizou: !ultimaOk,
    parada: falhou || atrasada,
    parada_desde: (falhou || atrasada) ? (ultimaOk ? ultimaOk.terminado_em : (primeiraTentativa || {}).iniciado_em || null) : null,
    ultima_ok_em: ultimaOk ? ultimaOk.terminado_em : null,
    ultima_tentativa_em: ultima ? ultima.terminado_em || ultima.iniciado_em : null,
    ultimo_erro: falhou ? ultima.erro : null,
    em_andamento: Boolean(ultima && !ultima.terminado_em),
    carga_inicial_em: lerEstado(db, 'carga_inicial_em'),
  };
}

module.exports = {
  sincronizarKanban, estadoSyncKanban, aplicarLeitura, conferirSumidas, arquivarFinalizadosNaFase9, enriquecerDetalhes,
  faseDaCargaInicial, hashLinha, JANELA_KANBAN, EMPRESA,
};
