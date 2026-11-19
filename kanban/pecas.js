// Separação das peças do orçamento aprovado (pedido do Guilherme em 12/11/2026).
//
// Cada entrada do card em Separação/Aquisição abre uma lista nova (Separação nº N, 18/11/2026):
// peças migradas da OS ou informadas à mão, "a separar". O compras (papel orcamento) ou quem tem movimentação total marca cada peça:
//   estoque  — tem na oficina
//   pedir    — precisa pedir ao fornecedor (entra no painel de peças pendentes de pedido)
//   pedido   — pedido feito (sai do painel de pedidos e vai para "aguardando chegada")
//   chegou   — a peça chegou na oficina (só então o card sai de Aguardando Peças)
//   fora     — o cliente não aprovou esta peça (aprovação parcial)
// Também dá para incluir peça que não estava na solicitação. Cada gravação vira um registro na
// linha do tempo do card.
const acoes = () => require('./acoes'); // acoes.js usa este módulo na aprovação
const { descricaoDaPeca } = require('./orcamento-pdf');

const SITUACOES = ['a_definir', 'estoque', 'pedir', 'pedido', 'chegou', 'fora'];
const NOME = { a_definir: 'a separar', estoque: 'em estoque', pedir: 'para pedir', pedido: 'pedido feito', chegou: 'chegou', fora: 'fora (não aprovada)' };
const MAX_PECAS = 150;
const PODE = ['total', 'orcamento'];
// Entrada, Diagnóstico, Orçamento e Aprovação: a separação ainda não começou (ou o card voltou dela).
const ANTES_DA_SEPARACAO = [1, 2, 3, 4];

// Orçamento com opções para o cliente (Orçamento 1, 2, 3…): ids das mídias na ordem. Sem opções = só o PDF anexado.
function opcoesDoOrcamento(orc) {
  let ids = [];
  try { ids = JSON.parse((orc && orc.opcoes) || '[]') || []; } catch (_) { ids = []; }
  ids = ids.map(Number).filter(Boolean);
  if (!ids.length && orc && orc.pdf_midia_id) ids = [orc.pdf_midia_id];
  return ids;
}
// PDF que vale como "orçamento aprovado pelo cliente": parcial = o que a aprovação anexou;
// integral = a opção escolhida (Orçamento N) ou, sem opções, o próprio orçamento enviado.
function midiaAprovada(orc) {
  if (!orc) return null;
  if (orc.decisao === 'parcial') return orc.via_cliente_midia_id || null;
  if (orc.decisao !== 'integral') return null;
  const ids = opcoesDoOrcamento(orc);
  return (orc.opcao_aprovada && ids[orc.opcao_aprovada - 1]) || orc.pdf_midia_id || null;
}

// Peças do orçamento aprovado: as lidas do PDF aprovado (parcial: o do cliente; integral: a opção
// escolhida / o orçamento enviado); sem PDF lido, as da solicitação; solicitação sem peças (card
// pulou o Orçamento), as da última que tinha. É o "migrar da OS" quando a tela não manda a lista.
function pecasDoOrcamentoAprovado(db, card) {
  const orc = db.prepare("SELECT * FROM kb_orcamentos WHERE card_id = ? AND decisao IN ('integral','parcial') ORDER BY id DESC LIMIT 1").get(card.id);
  let pecas = [];
  const aprovada = midiaAprovada(orc);
  const doPdf = aprovada ? db.prepare('SELECT pdf_pecas FROM kb_midias WHERE id = ?').get(aprovada) : null;
  try { pecas = (JSON.parse((doPdf && doPdf.pdf_pecas) || '[]') || []).map((p) => ({ descricao: descricaoDaPeca(p) })); } catch (_) { pecas = []; }
  if (!pecas.length && orc) { try { pecas = JSON.parse(orc.pecas || '[]') || []; } catch (_) { pecas = []; } }
  if (!pecas.length) { try { pecas = JSON.parse(acoes().ultimasPecas(db, card.id)) || []; } catch (_) { pecas = []; } }
  return { orcamentoId: orc ? orc.id : null, pecas };
}

// ---------- listas de separação por rodada (kb_separacoes, migração 020) ----------
// Cada entrada do card em Separação/Aquisição abre a "Separação nº N". Voltar para Orçamento ou
// Aprovação encerra a lista (fica no histórico do card). Pedido feito e ainda não chegado continua
// valendo: aparece no "Aguardando chegada" e passa para a lista seguinte.
const MODOS = { os: 'peças migradas da OS', manual: 'peças informadas manualmente', anterior: 'lista anterior às rodadas' };
const separacaoAberta = (db, cardId) => db.prepare('SELECT * FROM kb_separacoes WHERE card_id = ? AND encerrada_em IS NULL').get(Number(cardId));
const itensDaSeparacao = (db, sepId) => db.prepare(`SELECT descricao, situacao, origem FROM kb_pecas
    WHERE separacao_id = ? AND removido_em IS NULL ORDER BY id`).all(sepId);

function encerrarSeparacao(db, cardId, { op, agora, motivo }) {
  const s = separacaoAberta(db, cardId);
  if (!s) return null;
  const itens = itensDaSeparacao(db, s.id);
  db.prepare('UPDATE kb_separacoes SET encerrada_em = ?, encerrada_por = ?, encerrada_motivo = ?, itens_json = ? WHERE id = ?')
    .run(agora, op, motivo, JSON.stringify(itens), s.id);
  return { ...s, itens };
}

const limpaDesc = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Abre a lista nova. `itens` = [{descricao}] escolhidos na tela; modo 'os' sem itens = peças do
// orçamento aprovado (PDF / solicitação). Devolve o texto para o registro da passagem de fase.
function iniciarSeparacao(db, card, { modo, itens, op, agora }) {
  const { ErroAcao } = acoes();
  if (!['os', 'manual'].includes(modo)) throw new ErroAcao(400, 'Escolha: migrar as peças da OS ou informar manualmente', { exige: 'separacao' });
  let lista;
  let orcamentoId = null;
  if (Array.isArray(itens)) lista = itens;
  else if (modo === 'os') ({ pecas: lista, orcamentoId } = pecasDoOrcamentoAprovado(db, card));
  else lista = [];
  lista = lista.map((p) => limpaDesc(p && p.descricao)).filter(Boolean);
  if (lista.length > MAX_PECAS) throw new ErroAcao(400, `No máximo ${MAX_PECAS} peças por separação`);
  if (lista.some((d) => d.length > 300)) throw new ErroAcao(400, 'Descrição de peça muito longa (máximo 300 caracteres)');
  if (!orcamentoId) orcamentoId = (db.prepare("SELECT id FROM kb_orcamentos WHERE card_id = ? AND decisao IN ('integral','parcial') ORDER BY id DESC LIMIT 1").get(card.id) || {}).id || null;

  const anterior = encerrarSeparacao(db, card.id, { op, agora, motivo: 'nova separação' });
  const numero = (db.prepare('SELECT MAX(numero) AS n FROM kb_separacoes WHERE card_id = ?').get(card.id).n || 0) + 1;
  const sepId = db.prepare('INSERT INTO kb_separacoes (card_id, numero, modo, fase_origem, iniciada_em, iniciada_por) VALUES (?, ?, ?, ?, ?, ?)')
    .run(card.id, numero, modo, card.fase_id, agora, op).lastInsertRowid;
  // pedidos feitos em listas anteriores que ainda não chegaram seguem nesta
  const levadas = db.prepare("SELECT id, descricao FROM kb_pecas WHERE card_id = ? AND removido_em IS NULL AND situacao = 'pedido'").all(card.id);
  for (const p of levadas) db.prepare('UPDATE kb_pecas SET separacao_id = ? WHERE id = ?').run(sepId, p.id);
  const ja = new Set(levadas.map((p) => p.descricao.toLowerCase()));
  const novas = [];
  const ins = db.prepare('INSERT INTO kb_pecas (card_id, orcamento_id, separacao_id, descricao, origem, criado_em, criado_por) VALUES (?, ?, ?, ?, ?, ?, ?)');
  for (const d of lista) {
    if (ja.has(d.toLowerCase())) continue;
    ja.add(d.toLowerCase());
    ins.run(card.id, orcamentoId, sepId, d, modo === 'os' ? 'orcamento' : 'manual', agora, op);
    novas.push(d);
  }
  const textos = [`Separação de peças nº ${numero} — ${MODOS[modo]} (${novas.length})${novas.length ? `:\n${novas.map((d) => `• ${d}`).join('\n')}` : '.'}`];
  if (anterior) textos.unshift(`Separação nº ${anterior.numero} encerrada (fica no histórico do card).`);
  if (levadas.length) textos.push(`Pedidos feitos que ainda não chegaram seguem nesta lista (${levadas.length}):\n${levadas.map((p) => `• ${p.descricao}`).join('\n')}`);
  return { id: sepId, numero, modo, pecas: novas.length, levadas: levadas.length, texto: textos.join('\n') };
}

// Histórico do card: todas as listas, da mais nova para a mais antiga (a aberta com as peças de agora).
function historicoSeparacoes(db, cardId) {
  return db.prepare('SELECT * FROM kb_separacoes WHERE card_id = ? ORDER BY numero DESC').all(Number(cardId)).map((s) => {
    let itens;
    if (s.encerrada_em) { try { itens = JSON.parse(s.itens_json || '[]') || []; } catch (_) { itens = []; } } else itens = itensDaSeparacao(db, s.id);
    return {
      id: s.id, numero: s.numero, modo: s.modo, modo_texto: MODOS[s.modo] || s.modo, aberta: !s.encerrada_em,
      iniciada_em: s.iniciada_em, iniciada_por: s.iniciada_por, encerrada_em: s.encerrada_em, encerrada_por: s.encerrada_por,
      encerrada_motivo: s.encerrada_motivo, itens,
    };
  });
}

// Peças de agora: as da lista aberta + pedidos feitos (de qualquer lista) que ainda não chegaram.
const listar = (db, cardId) => db.prepare(`SELECT id, descricao, origem, situacao, criado_em, atualizado_em, atualizado_por, pedido_em, pedido_por, chegou_em, chegou_por
    FROM kb_pecas WHERE card_id = ? AND removido_em IS NULL
      AND (situacao = 'pedido' OR separacao_id = (SELECT s.id FROM kb_separacoes s WHERE s.card_id = kb_pecas.card_id AND s.encerrada_em IS NULL))
    ORDER BY id`).all(Number(cardId));

function exigirPapel(papel) {
  const { ErroAcao } = acoes();
  if (!PODE.includes(papel)) throw new ErroAcao(403, 'Só o compras (orçamento e peças) ou quem tem movimentação total separa e pede peças');
}

const resumoTexto = (lista) => {
  const n = (s) => lista.filter((p) => p.situacao === s).length;
  return ['estoque', 'pedir', 'pedido', 'chegou', 'a_definir', 'fora'].filter((s) => n(s)).map((s) => `${n(s)} ${NOME[s]}`).join(' · ');
};

// Grava a lista inteira do card: [{id?, descricao, situacao}]. Peça sem id é nova (manual);
// peça do banco que não veio na lista é removida.
function salvar(db, cardId, { itens, operador, papel = 'total' }, { agora = new Date().toISOString() } = {}) {
  const { ErroAcao, validarOperador } = acoes();
  exigirPapel(papel);
  const op = validarOperador(operador);
  const card = db.prepare('SELECT * FROM kb_cards WHERE id = ?').get(Number(cardId));
  if (!card) throw new ErroAcao(404, 'Card não encontrado');
  if (ANTES_DA_SEPARACAO.includes(card.fase_id)) {
    throw new ErroAcao(409, 'O card ainda não está na Separação/Aquisição de peças: a lista nova começa quando ele entrar lá');
  }
  if (!Array.isArray(itens)) throw new ErroAcao(400, 'Lista de peças inválida');
  if (itens.length > MAX_PECAS) throw new ErroAcao(400, `No máximo ${MAX_PECAS} peças por card`);
  const atuais = new Map(listar(db, card.id).map((p) => [p.id, p]));
  const lista = itens.map((i) => ({
    id: i && i.id ? Number(i.id) : null,
    descricao: String((i && i.descricao) || '').replace(/\s+/g, ' ').trim(),
    situacao: String((i && i.situacao) || ''),
    origem: i && i.origem === 'orcamento' ? 'orcamento' : 'manual', // trazida da solicitação ou incluída à mão (ou do checklist)
  }));
  for (const i of lista) {
    if (i.id && !atuais.has(i.id)) throw new ErroAcao(400, 'Peça não pertence a este card (recarregue a tela)');
    if (!i.id && !i.descricao) throw new ErroAcao(400, 'Escreva a descrição da peça');
    if (i.descricao.length > 300) throw new ErroAcao(400, 'Descrição de peça muito longa (máximo 300 caracteres)');
    if (!SITUACOES.includes(i.situacao)) throw new ErroAcao(400, 'Situação de peça inválida');
  }
  const orc = db.prepare("SELECT id FROM kb_orcamentos WHERE card_id = ? AND decisao IN ('integral','parcial') ORDER BY id DESC LIMIT 1").get(card.id);
  const mudou = [];
  db.transaction(() => {
    // card que já estava na Separação antes das listas por rodada: abre a lista aqui
    let sep = separacaoAberta(db, card.id);
    if (!sep && lista.length) sep = { id: iniciarSeparacao(db, card, { modo: 'manual', itens: [], op, agora }).id };
    const ficam = new Set();
    for (const i of lista) {
      if (i.id) {
        ficam.add(i.id);
        const a = atuais.get(i.id);
        if (a.situacao === i.situacao) continue;
        // "chegou" guarda quando foi pedida; voltar para trás limpa as datas
        const s = i.situacao;
        db.prepare(`UPDATE kb_pecas SET situacao = @s, atualizado_em = @agora, atualizado_por = @op,
            pedido_em = CASE WHEN @s = 'pedido' THEN @agora WHEN @s = 'chegou' THEN COALESCE(pedido_em, @agora) ELSE NULL END,
            pedido_por = CASE WHEN @s = 'pedido' THEN @op WHEN @s = 'chegou' THEN COALESCE(pedido_por, @op) ELSE NULL END,
            chegou_em = CASE WHEN @s = 'chegou' THEN @agora ELSE NULL END, chegou_por = CASE WHEN @s = 'chegou' THEN @op ELSE NULL END
            WHERE id = @id`).run({ s, agora, op, id: i.id });
        mudou.push(`• ${a.descricao}: ${NOME[i.situacao]}`);
      } else {
        const pedida = ['pedido', 'chegou'].includes(i.situacao);
        const chegou = i.situacao === 'chegou';
        db.prepare(`INSERT INTO kb_pecas (card_id, orcamento_id, separacao_id, descricao, origem, situacao, criado_em, criado_por, atualizado_em, atualizado_por, pedido_em, pedido_por, chegou_em, chegou_por)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(card.id, orc ? orc.id : null, sep ? sep.id : null, i.descricao, i.origem, i.situacao, agora, op, agora, op,
            pedida ? agora : null, pedida ? op : null, chegou ? agora : null, chegou ? op : null);
        mudou.push(`• ${i.descricao}${i.origem === 'manual' ? ' (incluída)' : ''}: ${NOME[i.situacao]}`);
      }
    }
    for (const [id, a] of atuais) {
      if (ficam.has(id)) continue;
      db.prepare('UPDATE kb_pecas SET removido_em = ? WHERE id = ?').run(agora, id);
      mudou.push(`• ${a.descricao}: retirada da lista`);
    }
    if (mudou.length) {
      const final = listar(db, card.id);
      db.prepare(`INSERT INTO kb_eventos (card_id, tipo, texto, dados, operador_nome, criado_em) VALUES (?, 'texto', ?, ?, ?, ?)`)
        .run(card.id, `Separação de peças — ${resumoTexto(final)}\n${mudou.join('\n')}`, JSON.stringify({ acao: 'separacao_pecas' }), op, agora);
    }
  })();
  return { alteradas: mudou.length, pecas: listar(db, card.id) };
}

// Painel do compras: marca peças "para pedir" (de qualquer card) como pedido feito.
function marcarPedidas(db, ids, { operador, papel = 'total' }, { agora = new Date().toISOString() } = {}) {
  const { ErroAcao, validarOperador } = acoes();
  exigirPapel(papel);
  const op = validarOperador(operador);
  const lista = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean))];
  if (!lista.length) throw new ErroAcao(400, 'Selecione as peças que já foram pedidas');
  if (lista.length > 500) throw new ErroAcao(400, 'Seleção grande demais');
  const pecas = lista.map((id) => db.prepare("SELECT * FROM kb_pecas WHERE id = ? AND removido_em IS NULL AND situacao = 'pedir'").get(id)).filter(Boolean);
  if (!pecas.length) throw new ErroAcao(409, 'Essas peças não estão mais pendentes de pedido (recarregue a tela)');
  const porCard = new Map();
  db.transaction(() => {
    for (const p of pecas) {
      db.prepare("UPDATE kb_pecas SET situacao = 'pedido', atualizado_em = ?, atualizado_por = ?, pedido_em = ?, pedido_por = ? WHERE id = ?").run(agora, op, agora, op, p.id);
      if (!porCard.has(p.card_id)) porCard.set(p.card_id, []);
      porCard.get(p.card_id).push(p.descricao);
    }
    for (const [cardId, nomes] of porCard) {
      db.prepare(`INSERT INTO kb_eventos (card_id, tipo, texto, dados, operador_nome, criado_em) VALUES (?, 'texto', ?, ?, ?, ?)`)
        .run(cardId, `Pedido feito (${nomes.length}):\n${nomes.map((n) => `• ${n}`).join('\n')}`, JSON.stringify({ acao: 'pecas_pedidas' }), op, agora);
    }
  })();
  return { marcadas: pecas.length, cards: [...porCard.keys()] };
}

// Peças pedidas para orçamento (kb_orcamentos.pecas), pedido do Guilherme em 12/11/2026:
// editar ou excluir uma por vez, cada mudança registrada na linha do tempo. Só na solicitação
// em aberto (a mais recente, ainda sem decisão da aprovação); as antigas ficam como histórico.
// `atual` é a descrição que a tela mostrava: se a lista mudou nesse meio-tempo, recusa (409).
const PODE_ORCAMENTO = ['total', 'orcamento', 'aprovacao'];

const MAX_PECAS_ORCAMENTO = 100;
const limpa = (s) => String(s || '').replace(/\s+/g, ' ').trim();

// Solicitação em aberto do card, pronta para mudar (papel, card ativo, sem decisão). Devolve {op, card, orc, lista}.
function orcamentoEmAberto(db, cardId, orcamentoId, { operador, papel }) {
  const { ErroAcao, validarOperador } = acoes();
  if (!PODE_ORCAMENTO.includes(papel)) throw new ErroAcao(403, 'Seu acesso é só de registros: não altera as peças do orçamento');
  const op = validarOperador(operador);
  const card = db.prepare('SELECT * FROM kb_cards WHERE id = ?').get(Number(cardId));
  if (!card) throw new ErroAcao(404, 'Card não encontrado');
  if (card.arquivado_em) throw new ErroAcao(409, 'Card arquivado: as peças do orçamento não mudam mais');
  const orc = db.prepare('SELECT * FROM kb_orcamentos WHERE id = ? AND card_id = ?').get(Number(orcamentoId), card.id);
  if (!orc) throw new ErroAcao(404, 'Orçamento não encontrado');
  const ultimo = db.prepare('SELECT id FROM kb_orcamentos WHERE card_id = ? ORDER BY id DESC LIMIT 1').get(card.id);
  if (orc.id !== ultimo.id || orc.decisao) throw new ErroAcao(409, 'Este orçamento já foi decidido: as peças ficam como estão (use a separação de peças)');
  let lista;
  try { lista = JSON.parse(orc.pecas || '[]') || []; } catch (_) { lista = []; }
  return { op, card, orc, lista };
}

function gravarPecasOrcamento(db, { card, orc, lista, op, agora, texto, dados }) {
  db.transaction(() => {
    db.prepare('UPDATE kb_orcamentos SET pecas = ? WHERE id = ?').run(JSON.stringify(lista), orc.id);
    db.prepare(`INSERT INTO kb_eventos (card_id, tipo, texto, dados, operador_nome, criado_em) VALUES (?, 'texto', ?, ?, ?, ?)`)
      .run(card.id, texto, JSON.stringify({ ...dados, orcamento_id: orc.id }), op, agora);
    db.prepare('UPDATE kb_cards SET atualizado_em = ? WHERE id = ?').run(agora, card.id);
  })();
}

// Inclui uma peça nova no fim da solicitação em aberto.
function incluirPecaOrcamento(db, cardId, orcamentoId, { descricao, operador, papel = 'total' }, { agora = new Date().toISOString() } = {}) {
  const { ErroAcao } = acoes();
  const { op, card, orc, lista } = orcamentoEmAberto(db, cardId, orcamentoId, { operador, papel });
  const nova = limpa(descricao);
  if (!nova) throw new ErroAcao(400, 'Escreva a descrição da peça');
  if (nova.length > 300) throw new ErroAcao(400, 'Descrição de peça muito longa (máximo 300 caracteres)');
  if (lista.length >= MAX_PECAS_ORCAMENTO) throw new ErroAcao(400, `No máximo ${MAX_PECAS_ORCAMENTO} peças por orçamento`);
  lista.push({ descricao: nova, origem: 'manual' });
  gravarPecasOrcamento(db, { card, orc, lista, op, agora, texto: `Peça incluída no orçamento: ${nova}`, dados: { acao: 'orcamento_peca_incluida', depois: nova } });
  return { alterada: true, pecas: lista };
}

function alterarPecaOrcamento(db, cardId, orcamentoId, indice, { descricao, atual, operador, papel = 'total', remover = false }, { agora = new Date().toISOString() } = {}) {
  const { ErroAcao } = acoes();
  const { op, card, orc, lista } = orcamentoEmAberto(db, cardId, orcamentoId, { operador, papel });
  const i = Number(indice);
  if (!Number.isInteger(i) || !lista[i] || limpa(lista[i].descricao) !== limpa(atual)) {
    throw new ErroAcao(409, 'A lista de peças mudou: recarregue o card e tente de novo');
  }
  const antes = limpa(lista[i].descricao);
  let texto;
  let acao;
  if (remover) {
    lista.splice(i, 1);
    texto = `Peça retirada do orçamento: ${antes}`;
    acao = 'orcamento_peca_removida';
  } else {
    const nova = limpa(descricao);
    if (!nova) throw new ErroAcao(400, 'Escreva a descrição da peça');
    if (nova.length > 300) throw new ErroAcao(400, 'Descrição de peça muito longa (máximo 300 caracteres)');
    if (nova === antes) return { alterada: false, pecas: lista };
    lista[i] = { ...lista[i], descricao: nova };
    texto = `Peça do orçamento alterada:\nde: ${antes}\npara: ${nova}`;
    acao = 'orcamento_peca_editada';
  }
  gravarPecasOrcamento(db, { card, orc, lista, op, agora, texto, dados: { acao, antes, depois: remover ? null : lista[i].descricao } });
  return { alterada: true, pecas: lista };
}

// Painel do compras: marca peças "pedido feito" (de qualquer card) como chegou.
function marcarChegadas(db, ids, { operador, papel = 'total' }, { agora = new Date().toISOString() } = {}) {
  const { ErroAcao, validarOperador } = acoes();
  exigirPapel(papel);
  const op = validarOperador(operador);
  const lista = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(Boolean))];
  if (!lista.length) throw new ErroAcao(400, 'Selecione as peças que chegaram');
  if (lista.length > 500) throw new ErroAcao(400, 'Seleção grande demais');
  const pecas = lista.map((id) => db.prepare("SELECT * FROM kb_pecas WHERE id = ? AND removido_em IS NULL AND situacao = 'pedido'").get(id)).filter(Boolean);
  if (!pecas.length) throw new ErroAcao(409, 'Essas peças não estão mais aguardando chegada (recarregue a tela)');
  const porCard = new Map();
  db.transaction(() => {
    for (const p of pecas) {
      db.prepare("UPDATE kb_pecas SET situacao = 'chegou', atualizado_em = ?, atualizado_por = ?, chegou_em = ?, chegou_por = ? WHERE id = ?").run(agora, op, agora, op, p.id);
      if (!porCard.has(p.card_id)) porCard.set(p.card_id, []);
      porCard.get(p.card_id).push(p.descricao);
    }
    for (const [cardId, nomes] of porCard) {
      db.prepare(`INSERT INTO kb_eventos (card_id, tipo, texto, dados, operador_nome, criado_em) VALUES (?, 'texto', ?, ?, ?, ?)`)
        .run(cardId, `Peça chegou (${nomes.length}):\n${nomes.map((n) => `• ${n}`).join('\n')}`, JSON.stringify({ acao: 'pecas_chegaram' }), op, agora);
    }
  })();
  return { marcadas: pecas.length, cards: [...porCard.keys()] };
}

// Peças que o card ainda espera (para pedir, ou pedidas e ainda não chegadas).
const pendentesDeChegada = (db, cardId) => listar(db, cardId).filter((p) => ['pedir', 'pedido'].includes(p.situacao))
  .map((p) => ({ descricao: p.descricao, situacao: p.situacao }));

module.exports = { SITUACOES, NOME, MODOS, ANTES_DA_SEPARACAO, opcoesDoOrcamento, midiaAprovada, pecasDoOrcamentoAprovado, separacaoAberta, encerrarSeparacao, iniciarSeparacao, historicoSeparacoes, listar, salvar, marcarPedidas, marcarChegadas, pendentesDeChegada, alterarPecaOrcamento, incluirPecaOrcamento, PODE_ORCAMENTO };
