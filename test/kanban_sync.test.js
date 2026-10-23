const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bancoDeTeste } = require('./helpers/db');
const nov = require('./helpers/novidades');
const { reverter } = require('../migrations');
const { sincronizarKanban, estadoSyncKanban, faseDaCargaInicial } = require('../kanban/sync');
const { OnmotorMock, chassiFalso } = require('../kanban/onmotor-mock');

// Cliente falso com a mesma interface do OnmotorClient (e do mock): Novidades configurável.
function cliente({ html = nov.FIXTURE, falhar = false, osHtml } = {}) {
  const mock = new OnmotorMock();
  const c = {
    html,
    chamadasOS: [],
    async novidadesHtml() { if (falhar) throw new Error('login no Onmotor recusado'); return c.html; },
    async osHtml(id) { c.chamadasOS.push(id); return osHtml ? osHtml(id) : mock.osHtml(id); },
    req: (caminho, opts) => mock.req(caminho, opts),
  };
  return c;
}

let relogio = Date.parse('2026-10-23T12:00:00.000Z');
const agoraFn = () => new Date((relogio += 1000)).toISOString();
const sync = (db, client, extra = {}) => sincronizarKanban(db, { client, agoraFn, log: () => {}, ...extra });

const cards = (db) => db.prepare('SELECT * FROM kb_cards ORDER BY id').all();
const ativos = (db) => db.prepare('SELECT * FROM kb_cards WHERE arquivado_em IS NULL').all();
const cardDaOS = (db, n) => db.prepare('SELECT * FROM kb_cards WHERE os_numero = ?').get(String(n));
const eventos = (db, cardId) => db.prepare('SELECT * FROM kb_eventos WHERE card_id = ? ORDER BY id').all(cardId);
const LINHAS = nov.linhas();
const ABERTA = LINHAS.find((l) => !l.etapas.finalizado && l.etapas.entrada && !l.etapas.emExecucao);
const FINALIZADA = LINHAS.find((l) => l.etapas.finalizado);

test('migração 003: cria as 9 fases na ordem e é reversível', () => {
  const db = bancoDeTeste();
  const fases = db.prepare('SELECT id, nome FROM kb_fases ORDER BY ordem').all();
  assert.equal(fases.length, 9);
  assert.equal(fases[0].nome, 'Aguardando Entrada');
  assert.equal(fases[8].nome, 'Veículo Pronto / Aguardando Retirada');
  assert.deepEqual(reverter(db, undefined, 3), ['005_checklists.js', '004_kanban_midias.js', '003_kanban_base.js']);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'kb_cards'").get().n, 0);
});

test('carga inicial: todas as OS abertas viram card, com a fase tirada da etapa do Onmotor', async () => {
  const db = bancoDeTeste();
  const r = await sync(db, cliente());
  assert.equal(r.ok, true);
  assert.equal(r.carga_inicial, true);
  assert.equal(r.os_lidas, 37);
  assert.equal(r.criados, 36, 'a única OS já finalizada não vira card');
  assert.equal(cardDaOS(db, FINALIZADA.osNumber), undefined);

  const porFase = Object.fromEntries(db.prepare('SELECT fase_id, COUNT(*) AS n FROM kb_cards GROUP BY fase_id').all().map((x) => [x.fase_id, x.n]));
  assert.deepEqual(porFase, { 2: 22, 5: 2, 7: 12 });
  assert.ok(cards(db).every((c) => c.origem === 'carga_inicial'));

  const c = cardDaOS(db, ABERTA.osNumber);
  assert.equal(c.cliente_nome, ABERTA.proprietario);
  assert.equal(c.cliente_telefone, ABERTA.telefone);
  assert.match(c.os_entrada_em, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
  assert.match(eventos(db, c.id)[0].texto, /carga inicial/);
  assert.equal(c.fase_desde, c.os_entrada_em, 'fase 2 (entrada) conta desde a entrada no Onmotor');
  const exec = cards(db).find((x) => x.fase_id === 7);
  const linhaExec = LINHAS.find((l) => l.osNumber === exec.os_numero);
  assert.equal(exec.fase_desde, new Date(linhaExec.datas.emExecucao.replace(' ', 'T') + ':00-03:00').toISOString());
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM onmotor_eventos WHERE tipo = 'criada'").get().n, 36);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM onmotor_eventos WHERE tipo = 'ignorada'").get().n, 1);
});

test('fase da carga inicial segue a etapa mais avançada', () => {
  assert.equal(faseDaCargaInicial({ entrada: true, orcamento: true, aguardandoPeca: true, emExecucao: true }).fase, 7);
  assert.equal(faseDaCargaInicial({ entrada: true, orcamento: true, aguardandoPeca: true }).fase, 5);
  assert.equal(faseDaCargaInicial({ entrada: true, orcamento: true }).fase, 6);
  assert.equal(faseDaCargaInicial({ entrada: true }).fase, 2);
  assert.equal(faseDaCargaInicial({ entrada: false }).fase, 1);
});

test('idempotente: a mesma leitura duas vezes não duplica card, evento nem payload', async () => {
  const db = bancoDeTeste();
  const client = cliente();
  await sync(db, client);
  const antes = { cards: cards(db).length, ev: db.prepare('SELECT COUNT(*) AS n FROM kb_eventos').get().n, on: db.prepare('SELECT COUNT(*) AS n FROM onmotor_eventos').get().n };
  const r = await sync(db, client);
  assert.equal(r.carga_inicial, false);
  assert.deepEqual({ criados: r.criados, atualizados: r.atualizados }, { criados: 0, atualizados: 0 });
  assert.equal(cards(db).length, antes.cards);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kb_eventos').get().n, antes.ev);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM onmotor_eventos').get().n, antes.on);
});

test('OS nova depois da carga inicial entra na fase 1 (Aguardando Entrada), mesmo já tendo entrada no Onmotor', async () => {
  const db = bancoDeTeste();
  const client = cliente();
  await sync(db, client);
  client.html = nov.novaOS(client.html, { baseOsId: ABERTA.osId, osId: '9999001', osNumero: '99001' });
  const r = await sync(db, client);
  assert.equal(r.criados, 1);
  const c = cardDaOS(db, '99001');
  assert.equal(c.fase_id, 1);
  assert.equal(c.origem, 'sync');
  assert.equal(c.os_id_interno, '9999001');
  assert.equal(eventos(db, c.id)[0].texto, 'Card criado automaticamente — OS 99001 aberta no Onmotor');
});

test('OS alterada: atualiza o cliente no card e registra na linha do tempo', async () => {
  const db = bancoDeTeste();
  const client = cliente();
  await sync(db, client);
  client.html = nov.trocarCliente(client.html, ABERTA.osId, 'Cliente Trocado da Silva');
  const r = await sync(db, client);
  assert.equal(r.atualizados, 1);
  const c = cardDaOS(db, ABERTA.osNumber);
  assert.equal(c.cliente_nome, 'Cliente Trocado da Silva');
  const ev = eventos(db, c.id).filter((e) => e.tipo === 'os_alterada_onmotor');
  assert.equal(ev.length, 1);
  assert.match(ev[0].texto, /Cliente: .+ → Cliente Trocado da Silva/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM onmotor_eventos WHERE tipo = 'alterada'").get().n, 1);
});

test('OS finalizada + card na fase 9 → arquiva sozinho, com a data do Onmotor na linha do tempo', async () => {
  const db = bancoDeTeste();
  const client = cliente();
  await sync(db, client);
  const c0 = cardDaOS(db, ABERTA.osNumber);
  db.prepare('UPDATE kb_cards SET fase_id = 9 WHERE id = ?').run(c0.id);
  client.html = nov.finalizar(client.html, ABERTA.osId, '23/10/26 às 10:30');
  const r = await sync(db, client);
  assert.equal(r.finalizados, 1);
  assert.equal(r.arquivados, 1);
  const c = cardDaOS(db, ABERTA.osNumber);
  assert.equal(c.os_finalizada_em, '2026-10-23T13:30:00.000Z'); // 10:30 em SP
  assert.ok(c.arquivado_em);
  assert.equal(c.arquivado_motivo, 'automatico');
  const arq = eventos(db, c.id).find((e) => e.tipo === 'arquivado');
  assert.equal(arq.texto, 'Arquivado automaticamente — OS finalizada no Onmotor em 23/10/2026 10:30');
});

test('OS finalizada com o card em outra fase → NÃO arquiva, só marca o aviso', async () => {
  const db = bancoDeTeste();
  const client = cliente();
  await sync(db, client);
  client.html = nov.finalizar(client.html, ABERTA.osId);
  const r = await sync(db, client);
  assert.equal(r.arquivados, 0);
  const c = cardDaOS(db, ABERTA.osNumber);
  assert.equal(c.arquivado_em, null);
  assert.ok(c.os_finalizada_em);
  const ev = eventos(db, c.id).find((e) => e.tipo === 'os_finalizada_onmotor');
  assert.match(ev.texto, /continua em "Avaliação\/Diagnóstico"/);

  // depois o operador move para a fase 9: a próxima rodada arquiva
  db.prepare('UPDATE kb_cards SET fase_id = 9 WHERE id = ?').run(c.id);
  assert.equal((await sync(db, client)).arquivados, 1);
});

test('card desarquivado à mão não é arquivado de novo pelo sync', async () => {
  const db = bancoDeTeste();
  const client = cliente();
  await sync(db, client);
  const c = cardDaOS(db, ABERTA.osNumber);
  db.prepare('UPDATE kb_cards SET fase_id = 9, auto_arquivar_bloqueado = 1 WHERE id = ?').run(c.id);
  client.html = nov.finalizar(client.html, ABERTA.osId);
  assert.equal((await sync(db, client)).arquivados, 0);
  assert.equal(cardDaOS(db, ABERTA.osNumber).arquivado_em, null);
});

test('OS que some da Novidades: confere na página da OS e registra a finalização', async () => {
  const db = bancoDeTeste();
  const client = cliente();
  await sync(db, client);
  const paginaFinalizada = `<html><i class="fa fa-check-circle" data-id="1" data-field="data_de_finalizacao" data-value="1" title="Finalizado<br>22/10/26 às 17:40"></i></html>`;
  client.html = nov.remover(client.html, ABERTA.osId);
  client.osHtml = async (id) => { client.chamadasOS.push(id); return id === ABERTA.osId ? paginaFinalizada : '<html></html>'; };
  const r = await sync(db, client);
  assert.equal(r.ok, true);
  const c = cardDaOS(db, ABERTA.osNumber);
  assert.ok(c.os_sumiu_em);
  assert.equal(c.os_finalizada_em, '2026-10-22T20:40:00.000Z');
  assert.equal(c.arquivado_em, null, 'não está na fase 9');
});

test('falha de leitura não mexe em nenhum card e deixa o banner de "parada"', async () => {
  const db = bancoDeTeste();
  const client = cliente();
  await sync(db, client);
  const antes = JSON.stringify(cards(db));
  const okEm = estadoSyncKanban(db).ultima_ok_em;

  client.novidadesHtml = async () => { throw new Error('login no Onmotor recusado'); };
  const r = await sync(db, client);
  assert.equal(r.ok, false);
  assert.equal(JSON.stringify(cards(db)), antes);
  const est = estadoSyncKanban(db);
  assert.equal(est.parada, true);
  assert.equal(est.parada_desde, okEm);
  assert.equal(est.ultimo_erro, 'login no Onmotor recusado');
});

test('página quebrada ou vazia é descartada (nunca some com os cards)', async () => {
  const db = bancoDeTeste();
  const client = cliente();
  await sync(db, client);
  client.html = '<html><body>manutenção</body></html>';
  const r = await sync(db, client);
  assert.equal(r.ok, false);
  assert.match(r.erro, /Novidades inválida/);
  assert.equal(ativos(db).length, 36);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kb_cards WHERE os_sumiu_em IS NOT NULL').get().n, 0);
});

test('dados do veículo: chassi, marca e ano vêm do cadastro do veículo, 15 por rodada', async () => {
  const db = bancoDeTeste();
  const client = cliente();
  const r1 = await sync(db, client);
  assert.equal(r1.detalhes, 15);
  const c = db.prepare('SELECT * FROM kb_cards WHERE detalhes_ok = 1 ORDER BY id LIMIT 1').get();
  assert.equal(c.chassi, chassiFalso(c.os_id_interno));
  assert.equal(c.chassi.length, 17);
  assert.equal(c.ano, '2019/2020');
  assert.ok(c.marca);
  assert.equal(JSON.parse(c.veiculo_detalhes).cor, 'Preto');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM veiculos').get().n, 15);

  await sync(db, client);
  await sync(db, client);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kb_cards WHERE detalhes_ok = 0').get().n, 0);
});

test('erro ao ler o cadastro do veículo não derruba a sincronização', async () => {
  const db = bancoDeTeste();
  const client = cliente({ osHtml: async () => '<html>sem token</html>' });
  const r = await sync(db, client);
  assert.equal(r.ok, true);
  assert.equal(r.criados, 36);
  assert.equal(r.detalhes, 0);
  const c = db.prepare('SELECT * FROM kb_cards WHERE detalhes_tentativas > 0 LIMIT 1').get();
  assert.match(c.detalhes_erro, /sem veículo|token/);
});

test('sem fonte configurada a rodada falha com mensagem clara', async () => {
  const db = bancoDeTeste();
  const r = await sincronizarKanban(db, { client: null, log: () => {} });
  assert.equal(r.ok, false);
  assert.match(r.erro, /não configurada/);
});
