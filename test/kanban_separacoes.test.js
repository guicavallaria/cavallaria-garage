// Listas de separação por rodada (pedido de 18/11/2026): cada entrada em Separação/Aquisição abre a
// Separação nº N (migrar peças da OS ou informar à mão); voltar ao Orçamento encerra a lista (fica no
// histórico) e pergunta se mantém o orçamento mais recente ou faz um novo pedido.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { bancoDeTeste } = require('./helpers/db');
const nov = require('./helpers/novidades');
const { aplicarLeitura } = require('../kanban/sync');
const acoes = require('../kanban/acoes');
const pecas = require('../kanban/pecas');
const fluxo = require('../kanban/fluxo');
const { criarRouter } = require('../kanban/routes');

const AGORA = '2026-11-18T12:00:00.000Z';
const F = fluxo.FASE;
const PECAS = [{ descricao: 'Pastilhas dianteiras' }, { descricao: 'Óleo 5W30' }];

function banco() {
  const db = bancoDeTeste();
  db.transaction(() => aplicarLeitura(db, nov.linhas(), { agora: '2026-11-10T12:00:00.000Z', primeiraCarga: true }))();
  return db;
}
const mover = (db, id, faseId, extra = {}) => acoes.moverCard(db, id, { faseId, operador: 'Teste', ...extra }, { agora: AGORA });
const pdfFalso = (db, cardId) => db.prepare(`INSERT INTO kb_midias (cliente_id, chave_objeto, tipo, mime, card_id, status, autor_nome, criado_em, enviado_em)
    VALUES (?, ?, 'pdf', 'application/pdf', ?, 'enviado', 'Cauã', ?, ?)`).run(`t-${Math.random()}`, `t/${Math.random()}.pdf`, cardId, AGORA, AGORA).lastInsertRowid;
const ultimoEvento = (db, id) => db.prepare("SELECT * FROM kb_eventos WHERE card_id = ? AND tipo = 'fase' ORDER BY id DESC LIMIT 1").get(id);
const lista = (db, id) => pecas.listar(db, id).map((p) => [p.descricao, p.situacao]);

function ateAprovacao(db) {
  const c = db.prepare('SELECT * FROM kb_cards WHERE fase_id = 2 ORDER BY id LIMIT 1').get();
  mover(db, c.id, F.ORCAMENTO, { pecas: PECAS });
  mover(db, c.id, F.APROVACAO, { pdfMidiaId: pdfFalso(db, c.id) });
  return c;
}

test('exigências: entrar em Separação pede a lista; voltar ao Orçamento depois da aprovação pergunta manter/novo', () => {
  assert.deepEqual(fluxo.exigencias(F.APROVACAO, F.AQUISICAO), ['aprovacao', 'separacao']);
  assert.deepEqual(fluxo.exigencias(F.EXECUCAO, F.AQUISICAO), ['separacao']);
  assert.deepEqual(fluxo.exigencias(F.AGUARDANDO_PECAS, F.AQUISICAO), [], 'voltar de Aguardando Peças continua a mesma lista');
  assert.deepEqual(fluxo.exigencias(F.AQUISICAO, F.ORCAMENTO), ['pecas', 'retorno']);
  assert.deepEqual(fluxo.exigencias(F.EXECUCAO, F.ORCAMENTO), ['pecas', 'retorno']);
  assert.deepEqual(fluxo.exigencias(F.DIAGNOSTICO, F.ORCAMENTO), ['pecas']);
  assert.deepEqual(fluxo.exigencias(F.APROVACAO, F.ORCAMENTO), ['pecas', 'observacao']);
});

test('rodadas: manual / da OS, encerra ao voltar ao Orçamento, pedido feito segue, histórico fica no card', () => {
  const db = banco();
  const c = ateAprovacao(db);
  assert.throws(() => mover(db, c.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'integral', separacao: { modo: 'xx' } }), (e) => e.exige === 'separacao');
  mover(db, c.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'integral', separacao: { modo: 'manual', itens: [{ descricao: ' Filtro  de óleo ' }, { descricao: 'Bucha' }] } });
  assert.deepEqual(lista(db, c.id), [['Filtro de óleo', 'a_definir'], ['Bucha', 'a_definir']]);
  assert.match(ultimoEvento(db, c.id).texto, /Separação de peças nº 1 — peças informadas manualmente \(2\)/);
  const [a, b] = pecas.listar(db, c.id);
  pecas.salvar(db, c.id, { operador: 'Cauã', itens: [{ id: a.id, situacao: 'pedido' }, { id: b.id, situacao: 'pedir' }] }, { agora: AGORA });

  // volta ao Orçamento (demanda nova): a lista sai do card; o pedido feito continua esperando chegar
  assert.throws(() => mover(db, c.id, F.ORCAMENTO, { retorno: 'talvez', pecas: PECAS }), (e) => e.exige === 'retorno');
  mover(db, c.id, F.ORCAMENTO, { retorno: 'novo', pecas: [{ descricao: 'Bomba d\'água' }] });
  assert.match(ultimoEvento(db, c.id).texto, /Novo pedido de orçamento[\s\S]*Separação de peças nº 1 encerrada/);
  assert.deepEqual(lista(db, c.id), [['Filtro de óleo', 'pedido']], 'só o pedido a chegar: nada "a separar" no Orçamento');
  assert.throws(() => pecas.salvar(db, c.id, { operador: 'Cauã', itens: [] }, { agora: AGORA }), (e) => e.status === 409);

  // nova aprovação: Separação nº 2 com as peças da OS (sem lista da tela = orçamento aprovado)
  mover(db, c.id, F.APROVACAO, { pdfMidiaId: pdfFalso(db, c.id) });
  mover(db, c.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'integral', separacao: { modo: 'os' } });
  assert.deepEqual(lista(db, c.id), [['Filtro de óleo', 'pedido'], ['Bomba d\'água', 'a_definir']]);
  assert.match(ultimoEvento(db, c.id).texto, /Separação de peças nº 2 — peças migradas da OS \(1\)[\s\S]*seguem nesta lista \(1\)/);

  const h = pecas.historicoSeparacoes(db, c.id);
  assert.deepEqual(h.map((s) => [s.numero, s.modo, s.aberta]), [[2, 'os', true], [1, 'manual', false]]);
  assert.deepEqual(h[1].itens.map((i) => [i.descricao, i.situacao]), [['Filtro de óleo', 'pedido'], ['Bucha', 'pedir']], 'a lista antiga fica como estava');
  assert.match(h[1].encerrada_motivo, /voltou para Orçamento/);

  // Aguardando Peças → Separação: mesma lista
  mover(db, c.id, F.AGUARDANDO_PECAS, { prazoDias: 3 });
  mover(db, c.id, F.AQUISICAO);
  assert.equal(pecas.separacaoAberta(db, c.id).numero, 2);
});

test('voltar ao Orçamento mantendo o orçamento mais recente: sem nova solicitação', () => {
  const db = banco();
  const c = ateAprovacao(db);
  mover(db, c.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'integral', separacao: { modo: 'manual', itens: [] } });
  const antes = db.prepare('SELECT COUNT(*) AS n FROM kb_orcamentos WHERE card_id = ?').get(c.id).n;
  mover(db, c.id, F.ORCAMENTO, { retorno: 'manter', observacao: 'Rever prazo com o fornecedor' });
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kb_orcamentos WHERE card_id = ?').get(c.id).n, antes);
  assert.match(ultimoEvento(db, c.id).texto, /mantendo o orçamento mais recente[\s\S]*Rever prazo/);
  assert.equal(pecas.separacaoAberta(db, c.id), undefined);
  // card sem orçamento nenhum não tem o que manter
  const d = db.prepare('SELECT * FROM kb_cards WHERE fase_id = 2 ORDER BY id LIMIT 1').get();
  mover(db, d.id, F.EXECUCAO);
  assert.throws(() => mover(db, d.id, F.ORCAMENTO, { retorno: 'manter' }), (e) => e.exige === 'pecas');
});

test('migração 020: peças antigas viram a Separação nº 1; card no Orçamento tem a lista encerrada', () => {
  const db = banco();
  const { reverter, aplicar } = require('../migrations');
  assert.deepEqual(reverter(db, undefined, 1), ['020_separacoes.js']);
  const [x, y] = db.prepare('SELECT * FROM kb_cards ORDER BY id LIMIT 2').all();
  db.prepare('UPDATE kb_cards SET fase_id = ? WHERE id = ?').run(F.ORCAMENTO, x.id);
  db.prepare('UPDATE kb_cards SET fase_id = ? WHERE id = ?').run(F.AQUISICAO, y.id);
  const ins = db.prepare("INSERT INTO kb_pecas (card_id, descricao, situacao, criado_em) VALUES (?, ?, ?, '2026-11-12')");
  ins.run(x.id, 'Correia', 'a_definir'); ins.run(x.id, 'Tensor', 'pedido'); ins.run(y.id, 'Vela', 'pedir');
  // PDFs: a leitura vazia feita depois da troca do Onmotor volta a NULL (lê de novo); a anterior e a com peças ficam
  const midia = db.prepare(`INSERT INTO kb_midias (cliente_id, chave_objeto, tipo, mime, card_id, status, autor_nome, criado_em, pdf_pecas)
      VALUES (?, ?, 'pdf', 'application/pdf', ?, 'enviado', 'Teste', ?, ?)`);
  const m1 = midia.run('m1', 'orcamentos/a.pdf', x.id, '2026-11-18T12:00:00.000Z', '[]').lastInsertRowid;
  const m2 = midia.run('m2', 'orcamentos/b.pdf', x.id, '2026-11-12T12:00:00.000Z', '[]').lastInsertRowid;
  const m3 = midia.run('m3', 'orcamentos/c.pdf', x.id, '2026-11-18T13:00:00.000Z', '[{"descricao":"X"}]').lastInsertRowid;
  assert.deepEqual(aplicar(db), ['020_separacoes.js']);
  const pdfPecas = (id) => db.prepare('SELECT pdf_pecas FROM kb_midias WHERE id = ?').get(id).pdf_pecas;
  assert.deepEqual([pdfPecas(m1), pdfPecas(m2), pdfPecas(m3)], [null, '[]', '[{"descricao":"X"}]']);
  assert.deepEqual(lista(db, x.id), [['Tensor', 'pedido']], 'no Orçamento sobra só o pedido a chegar');
  assert.deepEqual(lista(db, y.id), [['Vela', 'pedir']]);
  assert.equal(pecas.historicoSeparacoes(db, x.id)[0].itens.length, 2);
  assert.equal(pecas.separacaoAberta(db, y.id).modo, 'anterior');
});

test('rota pecas-da-os: lê a OS do Onmotor; sem leitura, cai no orçamento; marca o que já foi separado', async () => {
  const db = banco();
  const c = ateAprovacao(db);
  mover(db, c.id, F.AQUISICAO, { papel: 'aprovacao', decisao: 'integral', separacao: { modo: 'manual', itens: [{ descricao: 'Óleo 5W30' }] } });
  db.prepare('UPDATE kb_cards SET os_id_interno = ? WHERE id = ?').run('a'.repeat(45), c.id);
  let falhar = false;
  const cliente = { pecasDaOS: async (uid) => { if (falhar) throw new Error('Onmotor não respondeu em 60 s'); assert.equal(uid, 'a'.repeat(45)); return [{ descricao: 'Óleo 5W30', aprovada: true }, { descricao: 'Junta (584.890) — 1', aprovada: false }]; } };
  const app = express();
  app.use(express.json());
  app.use('/api/kanban', criarRouter({ db, log: () => {}, criarCliente: () => cliente }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api/kanban`;
  try {
    let r = await (await fetch(`${base}/cards/${c.id}/pecas-da-os`)).json();
    assert.equal(r.fonte, 'onmotor');
    assert.deepEqual(r.itens.map((i) => [i.descricao, i.aprovada, i.ja_separada]), [['Óleo 5W30', true, 1], ['Junta (584.890) — 1', false, null]]);
    falhar = true;
    r = await (await fetch(`${base}/cards/${c.id}/pecas-da-os`)).json();
    assert.equal(r.fonte, 'orcamento');
    assert.match(r.aviso, /não respondeu/);
    assert.deepEqual(r.itens.map((i) => i.descricao), PECAS.map((p) => p.descricao));
    // estado e card: lista aberta e histórico
    const est = await (await fetch(`${base}/estado`)).json();
    assert.deepEqual(est.cards.find((x) => x.id === c.id).separacao, { numero: 1, modo: 'manual' });
    const det = await (await fetch(`${base}/cards/${c.id}`)).json();
    assert.equal(det.separacoes.length, 1);
    // mover pela rota com a escolha
    await fetch(`${base}/cards/${c.id}/mover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ fase_id: F.ORCAMENTO, operador: 'Teste', retorno: 'manter' }) });
    assert.equal(db.prepare('SELECT fase_id FROM kb_cards WHERE id = ?').get(c.id).fase_id, F.ORCAMENTO);
  } finally {
    srv.close();
  }
});
