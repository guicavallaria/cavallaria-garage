// Separação das peças do orçamento aprovado (pedido do Guilherme em 12/11/2026).
//
// A aprovação do orçamento (integral ou parcial) copia as peças da solicitação para kb_pecas,
// "a separar". O compras (papel orcamento) ou quem tem movimentação total marca cada peça:
//   estoque  — tem na oficina
//   pedir    — precisa pedir ao fornecedor (entra no painel de peças pendentes de pedido)
//   pedido   — pedido feito (sai do painel)
//   fora     — o cliente não aprovou esta peça (aprovação parcial)
// Também dá para incluir peça que não estava na solicitação. Cada gravação vira um registro na
// linha do tempo do card.
const acoes = () => require('./acoes'); // acoes.js usa este módulo na aprovação
const { descricaoDaPeca } = require('./orcamento-pdf');

const SITUACOES = ['a_definir', 'estoque', 'pedir', 'pedido', 'fora'];
const NOME = { a_definir: 'a separar', estoque: 'em estoque', pedir: 'para pedir', pedido: 'pedido feito', fora: 'fora (não aprovada)' };
const MAX_PECAS = 150;
const PODE = ['total', 'orcamento'];

function semearDaAprovacao(db, card, orcamento, { op, agora }) {
  // nova aprovação substitui o que ainda não foi pedido de uma aprovação anterior
  db.prepare("UPDATE kb_pecas SET removido_em = ? WHERE card_id = ? AND removido_em IS NULL AND situacao <> 'pedido' AND (orcamento_id IS NULL OR orcamento_id <> ?)")
    .run(agora, card.id, orcamento.id);
  if (db.prepare('SELECT 1 FROM kb_pecas WHERE orcamento_id = ? AND removido_em IS NULL').get(orcamento.id)) return 0;
  let pecas = [];
  // 1º: as peças lidas do PDF aprovado (parcial: o do cliente; integral: o orçamento enviado)
  const midiaAprovada = orcamento.decisao === 'parcial' ? orcamento.via_cliente_midia_id : orcamento.pdf_midia_id;
  const doPdf = midiaAprovada ? db.prepare('SELECT pdf_pecas FROM kb_midias WHERE id = ?').get(midiaAprovada) : null;
  try { pecas = (JSON.parse((doPdf && doPdf.pdf_pecas) || '[]') || []).map((p) => ({ descricao: descricaoDaPeca(p) })); } catch (_) { pecas = []; }
  // 2º: as da solicitação (as que foram pedidas ao entrar em Orçamento)
  if (!pecas.length) { try { pecas = JSON.parse(orcamento.pecas || '[]') || []; } catch (_) { pecas = []; } }
  // solicitação sem peças (card pulou o Orçamento): usa as da última que tinha
  if (!pecas.length) { try { pecas = JSON.parse(acoes().ultimasPecas(db, card.id)) || []; } catch (_) { pecas = []; } }
  const ins = db.prepare('INSERT INTO kb_pecas (card_id, orcamento_id, descricao, criado_em, criado_por) VALUES (?, ?, ?, ?, ?)');
  let n = 0;
  for (const p of pecas) {
    const d = String((p && p.descricao) || '').replace(/\s+/g, ' ').trim().slice(0, 300);
    if (d) { ins.run(card.id, orcamento.id, d, agora, op); n++; }
  }
  return n;
}

const listar = (db, cardId) => db.prepare(`SELECT id, descricao, origem, situacao, criado_em, atualizado_em, atualizado_por, pedido_em, pedido_por
    FROM kb_pecas WHERE card_id = ? AND removido_em IS NULL ORDER BY id`).all(Number(cardId));

function exigirPapel(papel) {
  const { ErroAcao } = acoes();
  if (!PODE.includes(papel)) throw new ErroAcao(403, 'Só o compras (orçamento e peças) ou quem tem movimentação total separa e pede peças');
}

const resumoTexto = (lista) => {
  const n = (s) => lista.filter((p) => p.situacao === s).length;
  return ['estoque', 'pedir', 'pedido', 'a_definir', 'fora'].filter((s) => n(s)).map((s) => `${n(s)} ${NOME[s]}`).join(' · ');
};

// Grava a lista inteira do card: [{id?, descricao, situacao}]. Peça sem id é nova (manual);
// peça do banco que não veio na lista é removida.
function salvar(db, cardId, { itens, operador, papel = 'total' }, { agora = new Date().toISOString() } = {}) {
  const { ErroAcao, validarOperador } = acoes();
  exigirPapel(papel);
  const op = validarOperador(operador);
  const card = db.prepare('SELECT * FROM kb_cards WHERE id = ?').get(Number(cardId));
  if (!card) throw new ErroAcao(404, 'Card não encontrado');
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
    const ficam = new Set();
    for (const i of lista) {
      if (i.id) {
        ficam.add(i.id);
        const a = atuais.get(i.id);
        if (a.situacao === i.situacao) continue;
        db.prepare(`UPDATE kb_pecas SET situacao = ?, atualizado_em = ?, atualizado_por = ?,
            pedido_em = CASE WHEN ? = 'pedido' THEN ? ELSE NULL END, pedido_por = CASE WHEN ? = 'pedido' THEN ? ELSE NULL END WHERE id = ?`)
          .run(i.situacao, agora, op, i.situacao, agora, i.situacao, op, i.id);
        mudou.push(`• ${a.descricao}: ${NOME[i.situacao]}`);
      } else {
        db.prepare(`INSERT INTO kb_pecas (card_id, orcamento_id, descricao, origem, situacao, criado_em, criado_por, atualizado_em, atualizado_por, pedido_em, pedido_por)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(card.id, orc ? orc.id : null, i.descricao, i.origem, i.situacao, agora, op, agora, op, i.situacao === 'pedido' ? agora : null, i.situacao === 'pedido' ? op : null);
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

module.exports = { SITUACOES, NOME, semearDaAprovacao, listar, salvar, marcarPedidas };
