// Onmotor NOVO (API JSON, Cavallaria desde 18/11/2026): login, Pátio → linhas, kanban e pátio lendo por ela.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { bancoDeTeste } = require('./helpers/db');
const { servico, onmotorFalso, uid } = require('./helpers/onmotor-api-falso');
const { OnmotorApiClient, limparCacheDetalhes } = require('../patio/onmotor-api');
const { linhaDoPatio, telefone } = require('../patio/patio-api');
const { tipoDaFonte, baseDaFonte } = require('../patio/fontes-onmotor');
const { sincronizarKanban } = require('../kanban/sync');
const patioSync = require('../patio/sync');

const SENHA = 'segredo-teste';
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'onm-api-')), 'sessao.json');
const cliente = (srv, extra = {}) => new OnmotorApiClient({ user: 'robo', pass: SENHA, fetchImpl: srv.fetch, arquivoSessao: null, ...extra });

const PATIO = () => [
  servico(9001, { entrada: '2026-11-18 08:59' }),
  servico(9002, { entrada: '2026-11-11 16:24', aprovado: '2026-11-12 10:00', peca: '2026-11-12 10:01', placa: 'ABC-1234', celular: '+55(46)3222-1111' }),
  servico(9003, { entrada: '2024-11-04 09:57', aprovado: '2024-11-05 16:17', execucao: '2024-11-05 16:17', ano: '2024' }),
  servico(9004, { entrada: '2026-10-29 08:36', execucao: '2026-11-10 09:00', fim: '2026-11-17 14:18' }),
  servico(9005, {}),
  servico(9006, { entrada: '2026-11-01 08:00', cancelada: '2026-11-02 08:00' }),
];

test('fontes: Cavallaria lê a API nova (onmotor.com), AWDYNA o sistema antigo (.com.br); ambas trocáveis por env', () => {
  assert.equal(tipoDaFonte('cavallaria', {}), 'api');
  assert.equal(tipoDaFonte('awdyna', {}), 'html');
  assert.equal(baseDaFonte('cavallaria', {}), 'https://cavallaria.onmotor.com');
  assert.equal(baseDaFonte('awdyna', {}), 'https://awdyna.onmotor.com.br');
  // endereço antigo salvo no Railway não atrapalha a API nova
  assert.equal(baseDaFonte('cavallaria', { ONMOTOR_BASE_URL: 'https://cavallaria.onmotor.com.br' }), 'https://cavallaria.onmotor.com');
  assert.equal(tipoDaFonte('awdyna', { ONMOTOR_AWDYNA_TIPO: 'api' }), 'api');
  assert.equal(baseDaFonte('awdyna', { ONMOTOR_AWDYNA_TIPO: 'api' }), 'https://awdyna.onmotor.com');
  assert.equal(tipoDaFonte('cavallaria', { ONMOTOR_CAVALLARIA_TIPO: 'html' }), 'html');
  assert.deepEqual(patioSync.fontes({}).map((f) => [f.nome, f.tipo]), [['cavallaria', 'api'], ['awdyna', 'html']]);
});

test('login: entra uma vez, manda token + device_code como cookie e reaproveita a sessão salva', async () => {
  const srv = onmotorFalso({ servicos: PATIO() });
  const arquivo = tmp();
  const c1 = cliente(srv, { arquivoSessao: arquivo });
  assert.equal((await c1.servicosPatio()).length, 6);
  await c1.servicosPatio();
  assert.equal(srv.logins, 1);
  const salvo = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
  assert.equal(salvo.device_code, 'dev-123');
  assert.equal(salvo.base, 'https://cavallaria.onmotor.com');
  assert.ok(!JSON.stringify(salvo).includes(SENHA), 'senha nunca vai para o arquivo');
  // nova instância (o kanban cria clientes a cada rodada) usa a sessão do arquivo
  const c2 = cliente(srv, { arquivoSessao: arquivo });
  await c2.servicosPatio();
  assert.equal(srv.logins, 1);
});

test('sessão recusada (403) → loga de novo e repete a chamada', async () => {
  const srv = onmotorFalso({ servicos: PATIO() });
  const c = cliente(srv);
  await c.servicosPatio();
  srv.expirarTokens();
  assert.equal((await c.servicosPatio()).length, 6);
  assert.equal(srv.logins, 2);
});

test('login recusado e pedido de código (OTP) viram erro claro, sem vazar a senha', async () => {
  const errada = cliente(onmotorFalso(), { pass: 'outra-senha' });
  await assert.rejects(errada.servicosPatio(), (e) => /login no Onmotor recusado \(Usuário ou senha inválidos\.\)/.test(e.message) && !e.message.includes('outra-senha'));
  const otp = cliente(onmotorFalso({ otp: true }), { deviceCode: null });
  await assert.rejects(otp.servicosPatio(), /código de verificação \(OTP\)/);
  // com um device_code conhecido o Onmotor não pede o código
  const comAparelho = cliente(onmotorFalso({ otp: true, servicos: PATIO() }), { deviceCode: 'aparelho-ok' });
  assert.equal((await comAparelho.servicosPatio()).length, 6);
  await assert.rejects(cliente(onmotorFalso(), { user: '', pass: '' }).servicosPatio(), /ONMOTOR_USER\/ONMOTOR_PASS não configurados/);
});

test('Pátio → linhas no formato da Novidades antiga, com o ano certo das datas (inclusive OS de 2024)', async () => {
  limparCacheDetalhes();
  const srv = onmotorFalso({ servicos: PATIO() });
  const lido = await cliente(srv).lerNovidades();
  assert.equal(lido.ok, true);
  assert.deepEqual(lido.linhas.map((l) => l.osNumber), ['9001', '9002', '9003', '9004', '9005'], 'cancelada fica de fora');
  const [a, b, c, d, e] = lido.linhas;
  assert.equal(a.osId, uid(9001));
  assert.equal(a.entrada, '2026-11-18 08:59');
  assert.equal(a.telefone, '(11)98888-7777');
  assert.equal(a.placa, 'ABC1D23');
  assert.equal(a.modelo, '320I');
  assert.equal(a.km, '54321', 'km vem da OS quando a Pátio não traz');
  assert.deepEqual(a.etapas, { entrada: true, orcamento: false, aguardandoPeca: false, emExecucao: false, finalizado: false, retirado: false });
  assert.equal(b.placa, 'ABC1234');
  assert.equal(b.placaExibicao, 'ABC-1234');
  assert.equal(b.telefone, '(46)3222-1111');
  assert.equal(b.datas.aguardandoPeca, '2026-11-12 10:01');
  assert.equal(c.entrada, '2024-11-04 09:57');
  assert.equal(c.datas.emExecucao, '2024-11-05 16:17');
  assert.equal(d.etapas.finalizado, true);
  assert.equal(d.datas.finalizado, '2026-11-17 14:18');
  assert.equal(e.etapas.entrada, false);
  assert.equal(e.entrada, null, 'sem etapa de entrada não inventa data');
  assert.deepEqual(lido.emExecucao.map((l) => l.osNumber), ['9001', '9002', '9003']);
});

test('datas completas ficam em cache: a OS só é lida de novo quando o updated_at muda', async () => {
  limparCacheDetalhes();
  const lista = PATIO();
  const srv = onmotorFalso({ servicos: lista });
  const c = cliente(srv);
  await c.lerNovidades();
  assert.equal(srv.detalhes, 5);
  await c.lerNovidades();
  assert.equal(srv.detalhes, 5);
  lista[0].resumo.updated_at = '2026-11-18 10:00:00';
  await c.lerNovidades();
  assert.equal(srv.detalhes, 6);
});

test('OS sem leitura completa entra sem datas (aviso), e resposta sem a lista é recusada', async () => {
  limparCacheDetalhes();
  const lista = PATIO().slice(0, 2);
  lista[1].os.uid = 'ffff';
  const srv = onmotorFalso({ servicos: lista });
  const lido = await cliente(srv).lerNovidades();
  assert.equal(lido.ok, true);
  assert.equal(lido.linhas[1].entrada, null);
  assert.match(lido.avisos[0], /OS 9002: sem as datas completas/);
  const quebrado = { ...onmotorFalso(), fetch: async () => ({ status: 200, async text() { return '{"data":{}}'; } }) };
  const c = cliente(quebrado);
  c.sessao = { token: 't', device_code: 'd', expira_em: '2999-01-01T00:00:00Z' };
  const r = await c.lerNovidades();
  assert.equal(r.ok, false);
  assert.match(r.problemas[0], /data\.services/);
});

test('id numérico do Onmotor antigo é recusado com mensagem clara', async () => {
  await assert.rejects(cliente(onmotorFalso()).os('9658738'), /Onmotor antigo/);
  assert.equal(telefone('+55 (11) 98888-7777'), '(11) 98888-7777');
  assert.equal(linhaDoPatio({ uid: 'x', code: 1, vehicle_plate: '' }).placa, null);
});

// ---------- kanban lendo a API nova ----------
let relogio = Date.parse('2026-11-18T13:00:00.000Z');
const agoraFn = () => new Date((relogio += 1000)).toISOString();
const sync = (db, client) => sincronizarKanban(db, { client, agoraFn, log: () => {} });
const cardDaOS = (db, n) => db.prepare('SELECT * FROM kb_cards WHERE os_numero = ?').get(String(n));
const eventos = (db, id) => db.prepare('SELECT tipo, texto FROM kb_eventos WHERE card_id = ? ORDER BY id').all(id);

test('kanban: carga pela API cria os cards, com chassi/ano do cadastro do veículo e datas de SP em UTC', async () => {
  limparCacheDetalhes();
  const db = bancoDeTeste();
  const r = await sync(db, cliente(onmotorFalso({ servicos: PATIO() })));
  assert.equal(r.ok, true, r.erro);
  assert.equal(r.criados, 4, 'a finalizada sem card não entra');
  const c = cardDaOS(db, 9003);
  assert.equal(c.os_id_interno, uid(9003));
  assert.equal(c.os_entrada_em, '2024-11-04T12:57:00.000Z');
  assert.equal(c.fase_id, 7, 'carga inicial: em execução');
  assert.equal(c.cliente_telefone, '(11)98888-7777');
  assert.equal(c.chassi, 'WBATESTE000009003');
  assert.equal(c.marca, 'BMW');
  assert.equal(c.ano, '2019/2020');
  assert.equal(JSON.parse(c.veiculo_detalhes).cor, 'PRETO');
});

test('kanban: card da época do Onmotor antigo ganha o id novo sem alteração falsa de cliente/telefone/veículo', async () => {
  limparCacheDetalhes();
  const db = bancoDeTeste();
  db.prepare("INSERT INTO kb_estado (chave, valor) VALUES ('carga_inicial_em', '2026-10-23T12:00:00.000Z')").run();
  db.prepare(`INSERT INTO kb_cards (empresa, os_numero, os_id_interno, placa, placa_normalizada, modelo, km, cliente_nome, cliente_telefone,
      os_entrada_em, os_etapas, os_hash, os_visto_em, fase_id, fase_desde, origem, criado_em, atualizado_em, detalhes_ok, chassi, marca)
    VALUES ('cavallaria', '9002', '9658738', 'ABC-1234', 'ABC1234', '320I', 0, 'Cliente 9002', '(46)3222-1111', '2026-11-11T19:24:00.000Z',
      '{}', 'hash-antigo', '2026-11-17T21:00:00.000Z', 5, '2026-11-12T13:00:00.000Z', 'sync', '2026-11-11T19:30:00.000Z', '2026-11-17T21:00:00.000Z', 1, 'WBATESTE000009002', 'BMW')`).run();
  const r = await sync(db, cliente(onmotorFalso({ servicos: PATIO() })));
  assert.equal(r.ok, true, r.erro);
  const c = cardDaOS(db, 9002);
  assert.equal(c.os_id_interno, uid(9002));
  assert.equal(c.fase_id, 5, 'fase não muda pelo sync');
  assert.equal(c.os_entrada_em, '2026-11-11T19:24:00.000Z');
  assert.deepEqual(eventos(db, c.id).filter((e) => e.tipo === 'os_alterada_onmotor'), [], 'nenhuma "alteração" inventada');
});

test('kanban: OS que sai da Pátio é conferida pela API — finalizada fica; cancelada é arquivada depois de 10 min', async () => {
  limparCacheDetalhes();
  const db = bancoDeTeste();
  const lista = PATIO();
  const srv = onmotorFalso({ servicos: lista });
  const c = cliente(srv);
  await sync(db, c);
  // 9001 finaliza e sai; 9002 é cancelada e sai
  const s1 = lista.find((s) => s.resumo.code === 9001);
  const s2 = lista.find((s) => s.resumo.code === 9002);
  s1.os.end_date = '2026-11-18 11:00';
  s2.os.cancellation_date = '2026-11-18 11:00';
  srv.guardar(s1); srv.guardar(s2);
  srv.servicos = lista.filter((s) => s !== s1 && s !== s2);
  await sync(db, c);
  assert.equal(cardDaOS(db, 9001).os_finalizada_em, '2026-11-18T14:00:00.000Z');
  assert.equal(cardDaOS(db, 9001).arquivado_em, null);
  assert.equal(cardDaOS(db, 9002).arquivado_em, null, 'ainda dentro dos 10 min');
  relogio += 11 * 60_000;
  await sync(db, c);
  assert.ok(cardDaOS(db, 9002).arquivado_em, 'fora da Pátio sem finalizar → OS inativada');
  assert.ok(cardDaOS(db, 9002).os_inativada_em);
});

test('pátio: o painel lê a Cavallaria pela API e completa ano/cor do veículo', async () => {
  limparCacheDetalhes();
  const db = bancoDeTeste();
  const clientes = new Map([['cavallaria', cliente(onmotorFalso({ servicos: PATIO() }))]]);
  const r = await patioSync.sincronizar(db, { clientes, agoraFn: () => '2026-11-18 10:00:00', log: () => {} });
  assert.equal(r.ok, true, r.erro);
  assert.equal(r.os_lidas, 3);
  const v = db.prepare("SELECT * FROM patio_vehicles WHERE placa_normalizada = 'ABC1D23' AND status = 'ativo'").get();
  assert.ok(v);
  assert.equal(v.ano, '2019/2020');
  assert.equal(v.cor, 'PRETO');
  const o = db.prepare('SELECT os_id_interno FROM patio_vehicle_orders WHERE vehicle_id = ? ORDER BY os_number LIMIT 1').get(v.id);
  assert.match(o.os_id_interno, /^6afd/);
});

test('Onmotor lento: OS fora do cache além do tempo da rodada ficam para a próxima; chamada sem resposta vira erro claro', async () => {
  limparCacheDetalhes();
  const srv = onmotorFalso({ servicos: PATIO() });
  const c = cliente(srv, { orcamentoDetalhesMs: -1 });
  const lido = await c.lerNovidades();
  assert.equal(lido.ok, true);
  assert.equal(srv.detalhes, 0);
  assert.ok(lido.linhas.every((l) => l.entrada === null));
  assert.match(lido.avisos[0], /próxima rodada/);
  const travado = cliente({ fetch: (url, opts) => new Promise((_, rej) => opts.signal.addEventListener('abort', () => rej(opts.signal.reason))) }, { timeoutMs: 20 });
  travado.sessao = { token: 't', device_code: 'd', expira_em: '2999-01-01T00:00:00Z' };
  await assert.rejects(travado.servicosPatio(), /não respondeu em 0 s/);
});
