// Cavallaria e AWDYNA no mesmo kanban (pedido de 30/10/2026): mesmo padrão, e um veículo com OS
// nas duas empresas fica com um card em cada uma.
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { bancoDeTeste } = require('./helpers/db');
const nov = require('./helpers/novidades');
const { sincronizarKanban, sincronizarTodas, estadoSyncKanban } = require('../kanban/sync');
const { OnmotorMock } = require('../kanban/onmotor-mock');
const { criarClientes, empresasAtivas } = require('../kanban/fonte');
const { dadosEmpresa } = require('../kanban/empresa');
const launch = require('../kanban/launch');
const pdf = require('../kanban/pdf');
const { criarStorage } = require('../kanban/storage');
const { iniciarS3Dev } = require('../tools/s3-dev');

const VIN = 'WBAGL61002DM57925';
let s3;
let dirS3;
let storage;

before(async () => {
  dirS3 = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-empresas-'));
  s3 = await iniciarS3Dev({ porta: 0, dir: dirS3, log: () => {} });
  storage = criarStorage({
    STORAGE_ENDPOINT: `http://127.0.0.1:${s3.porta}`, STORAGE_BUCKET: 'kanban-dev', STORAGE_ACCESS_KEY: 'devkey',
    STORAGE_SECRET_KEY: 'devsecret', STORAGE_REGION: 'us-east-1', STORAGE_PATH_STYLE: 'true',
  });
});
after(async () => {
  await s3.fechar();
  fs.rmSync(dirS3, { recursive: true, force: true });
});

// Cliente falso de uma empresa: Novidades configurável; registra quais OS foram abertas.
function cliente({ html = nov.FIXTURE, falhar = false } = {}) {
  const mock = new OnmotorMock();
  const c = {
    html,
    chamadasOS: [],
    async novidadesHtml() { if (falhar) throw new Error('login no Onmotor recusado'); return c.html; },
    async osHtml(id) { c.chamadasOS.push(id); return mock.osHtml(id); },
    req: (caminho, opts) => mock.req(caminho, opts),
  };
  return c;
}

let relogio = Date.parse('2026-10-30T12:00:00.000Z');
const agoraFn = () => new Date((relogio += 1000)).toISOString();
const rodada = (db, clientes) => sincronizarTodas(db, { clientes, agoraFn, log: () => {} });
const dasDuas = (cav, awd) => [{ empresa: 'cavallaria', client: cav }, { empresa: 'awdyna', client: awd }];

const LINHAS = nov.linhas();
const OS_ABERTA = LINHAS.find((l) => !l.etapas.finalizado).osNumber;
const nAbertas = LINHAS.filter((l) => !l.etapas.finalizado).length;

test('mesmo veículo e até o mesmo nº de OS nas duas empresas: um card em cada, independentes', async () => {
  const db = bancoDeTeste();
  const r = await rodada(db, dasDuas(cliente(), cliente()));
  assert.equal(r.ok, true);
  assert.equal(r.criados, nAbertas * 2);
  const dois = db.prepare('SELECT * FROM kb_cards WHERE os_numero = ? ORDER BY empresa').all(String(OS_ABERTA));
  assert.deepEqual(dois.map((c) => c.empresa), ['awdyna', 'cavallaria']);
  assert.equal(dois[0].placa, dois[1].placa);
  assert.equal(dois[0].chassi, dois[1].chassi, 'os dois cards apontam para o mesmo veículo');
  // Mexer em um não mexe no outro
  db.prepare('UPDATE kb_cards SET fase_id = 8 WHERE id = ?').run(dois[0].id);
  await rodada(db, dasDuas(cliente(), cliente()));
  assert.equal(db.prepare('SELECT fase_id FROM kb_cards WHERE id = ?').get(dois[0].id).fase_id, 8);
  assert.notEqual(db.prepare('SELECT fase_id FROM kb_cards WHERE id = ?').get(dois[1].id).fase_id, 8);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kb_cards').get().n, nAbertas * 2, 'a 2ª leitura não duplica');
});

test('carga inicial é por empresa: AWDYNA entra na fase da etapa, mesmo com a Cavallaria já carregada', async () => {
  const db = bancoDeTeste();
  await sincronizarKanban(db, { client: cliente(), agoraFn, log: () => {} });
  const r = await sincronizarKanban(db, { client: cliente(), empresa: 'awdyna', agoraFn, log: () => {} });
  assert.equal(r.carga_inicial, true);
  const emExec = LINHAS.find((l) => l.etapas.emExecucao && !l.etapas.finalizado);
  const c = db.prepare("SELECT * FROM kb_cards WHERE empresa = 'awdyna' AND os_numero = ?").get(String(emExec.osNumber));
  assert.equal(c.fase_id, 7);
  assert.equal(c.origem, 'carga_inicial');
  // Depois da carga, OS nova da AWDYNA nasce na fase 1, como na Cavallaria
  const html = nov.novaOS(nov.FIXTURE, { baseOsId: emExec.osId, osId: 999001, osNumero: 99001 });
  const novo = await sincronizarKanban(db, { client: cliente({ html }), empresa: 'awdyna', agoraFn, log: () => {} });
  assert.equal(novo.carga_inicial, false);
  assert.equal(novo.criados, 1);
  assert.equal(db.prepare("SELECT fase_id FROM kb_cards WHERE empresa = 'awdyna' AND os_numero = '99001'").get().fase_id, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kb_cards WHERE empresa = 'cavallaria' AND os_numero = '99001'").get().n, 0, 'só na empresa que abriu a OS');
});

test('empresa que falha não afeta a outra; o aviso diz qual parou', async () => {
  const db = bancoDeTeste();
  const r = await rodada(db, dasDuas(cliente(), cliente({ falhar: true })));
  assert.equal(r.ok, true, 'só é erro quando todas falham');
  assert.match(r.erro, /AWDYNA: login no Onmotor recusado/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kb_cards WHERE empresa = 'cavallaria'").get().n, nAbertas);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kb_cards WHERE empresa = 'awdyna'").get().n, 0);
  const est = estadoSyncKanban(db, { agora: new Date('2026-10-30T12:10:00.000Z'), empresas: ['cavallaria', 'awdyna'] });
  assert.equal(est.parada, true);
  assert.match(est.ultimo_erro, /^AWDYNA: login/);
  assert.equal(est.nunca_sincronizou, false);
  // Voltou: o aviso some, e a carga inicial da AWDYNA acontece só agora
  const r2 = await rodada(db, dasDuas(cliente(), cliente()));
  assert.equal(r2.empresas[1].carga_inicial, true);
  assert.equal(estadoSyncKanban(db, { agora: new Date(relogio), empresas: ['cavallaria', 'awdyna'] }).parada, false);
  // As duas falhando: aí sim a rodada é erro
  const r3 = await rodada(db, dasDuas(cliente({ falhar: true }), cliente({ falhar: true })));
  assert.equal(r3.ok, false);
});

test('cada card é conferido no Onmotor da própria empresa', async () => {
  const db = bancoDeTeste();
  const cav = cliente();
  const awd = cliente();
  await rodada(db, dasDuas(cav, awd));
  const interno = (empresa) => db.prepare('SELECT COUNT(*) AS n FROM kb_cards WHERE empresa = ? AND detalhes_ok = 1').get(empresa).n;
  assert.ok(cav.chamadasOS.length > 0);
  assert.ok(awd.chamadasOS.length > 0);
  assert.ok(interno('cavallaria') > 0);
  assert.ok(interno('awdyna') > 0);

  // OS que sumiu da Novidades da AWDYNA não marca o card da Cavallaria como sumido
  const semOS = cliente({ html: nov.remover(nov.FIXTURE, LINHAS.find((l) => !l.etapas.finalizado).osId) });
  await rodada(db, dasDuas(cliente(), semOS));
  const sumidos = db.prepare('SELECT empresa, COUNT(*) AS n FROM kb_cards WHERE os_sumiu_em IS NOT NULL GROUP BY empresa').all();
  assert.deepEqual(sumidos, [{ empresa: 'awdyna', n: 1 }]);
});

test('Novidades vazia só é descartada se a empresa tem cards ativos: não apaga nem atrapalha a outra', async () => {
  const db = bancoDeTeste();
  const vazia = nov.FIXTURE.replace(/<tr class="tr-servico-bg[12]"[\s\S]*?<\/tr>/g, '');
  const awd = (html) => sincronizarKanban(db, { client: cliente({ html }), empresa: 'awdyna', agoraFn, log: () => {} });
  await sincronizarKanban(db, { client: cliente(), agoraFn, log: () => {} });
  const r = await awd(vazia);
  assert.equal(r.ok, true, 'AWDYNA sem nenhuma OS aberta e sem cards não é erro');
  await awd(nov.FIXTURE);
  const r2 = await awd(vazia);
  assert.equal(r2.ok, false, 'com cards ativos, Novidades vazia é leitura ruim');
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kb_cards WHERE arquivado_em IS NULL AND empresa = 'awdyna'").get().n, nAbertas);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kb_cards WHERE arquivado_em IS NULL AND empresa = 'cavallaria'").get().n, nAbertas);
});

test('Launch: chassi com card nas duas empresas vai para a OS de entrada mais próxima; a tela sugere as duas', async () => {
  const db = bancoDeTeste();
  await rodada(db, dasDuas(cliente(), cliente()));
  const [awd, cav] = db.prepare('SELECT * FROM kb_cards WHERE os_numero = ? ORDER BY empresa').all(String(OS_ABERTA));
  db.prepare("UPDATE kb_cards SET chassi = ?, os_entrada_em = '2026-10-20T13:00:00.000Z' WHERE id = ?").run(VIN, cav.id);
  db.prepare("UPDATE kb_cards SET chassi = ?, os_entrada_em = '2026-10-28T13:00:00.000Z' WHERE id = ?").run(VIN, awd.id);
  const PDF = Buffer.from('%PDF-1.4\n% x\n%%EOF\n');
  const r = await launch.importarRelatorio(db, storage, { origem: 'email', messageId: 'm1', nomeArquivo: `BMW_${VIN}_AllSystemDTC_20261029100000.pdf`, bytes: PDF, relatorioEm: '2026-10-29T13:00:00.000Z' });
  assert.equal(r.relatorio.card_id, awd.id, 'escaneamento de 29/10 fica com a OS que entrou em 28/10');
  const s = await launch.importarRelatorio(db, storage, { origem: 'email', messageId: 'm2', nomeArquivo: `BMW_${VIN}_AllSystemDTC_20261021100000.pdf`, bytes: PDF, relatorioEm: '2026-10-21T13:00:00.000Z' });
  assert.equal(s.relatorio.card_id, cav.id, 'escaneamento de 21/10 fica com a OS que entrou em 20/10');
  // Dá para corrigir à mão: desvincula e aparece sugerindo os dois cards, com a empresa
  launch.desvincular(db, s.relatorio.id, { operador: 'Luan' });
  const nv = await launch.listarNaoVinculados(db, storage, { agora: '2026-10-30T12:00:00.000Z' });
  assert.deepEqual(nv.find((x) => x.id === s.relatorio.id).sugestoes.map((c) => c.empresa).sort(), ['awdyna', 'cavallaria']);
});

test('PDF sai com o cabeçalho da empresa da OS', async () => {
  const db = bancoDeTeste();
  await rodada(db, dasDuas(cliente(), cliente()));
  const cardDe = (empresa) => db.prepare('SELECT * FROM kb_cards WHERE empresa = ? AND os_numero = ?').get(empresa, String(OS_ABERTA));
  const chk = require('../kanban/checklists');
  const htmlDe = async (empresa) => {
    const { execucao } = chk.iniciar(db, cardDe(empresa).id, 'entrada', { feitoPor: 'Edson', operador: 'Edson' });
    return pdf.montarHtmlVistoria(await pdf.dadosVistoria(db, storage, execucao.id));
  };
  const awd = await htmlDe('awdyna');
  assert.match(awd, /AWDyna Performance/);
  assert.match(awd, /47\.494\.536\/0001-74/);
  assert.match(awd, /data:image\/png;base64,/, 'logo da AWDYNA');
  assert.ok(!awd.includes('07.954.296/0001-29'));
  const cav = await htmlDe('cavallaria');
  assert.match(cav, /Cavallaria Garage/);
  assert.match(cav, /07\.954\.296\/0001-29/);
  assert.match(cav, /data:image\/webp;base64,/);
  assert.equal(dadosEmpresa('qualquer').id, 'cavallaria');
  assert.ok(fs.existsSync(path.join(__dirname, '..', dadosEmpresa('awdyna').logo)));
});

test('fontes: lê as duas empresas; a AWDYNA pode ser desligada; simulado só com arquivo próprio', () => {
  const real = { ONMOTOR_USER: 'u', ONMOTOR_PASS: 'p' };
  assert.deepEqual(empresasAtivas(real), ['cavallaria', 'awdyna']);
  assert.deepEqual(empresasAtivas({ ...real, KANBAN_AWDYNA_ENABLED: 'false' }), ['cavallaria']);
  assert.deepEqual(empresasAtivas({ KANBAN_FONTE: 'mock' }), ['cavallaria']);
  assert.deepEqual(empresasAtivas({ KANBAN_FONTE: 'mock', KANBAN_MOCK_NOVIDADES_AWDYNA: 'x.html' }), ['cavallaria', 'awdyna']);
  assert.deepEqual(criarClientes({ env: {} }), [], 'sem credenciais não há cliente');
  const dois = criarClientes({ env: { KANBAN_FONTE: 'mock', KANBAN_MOCK_NOVIDADES_AWDYNA: 'x.html' } });
  assert.deepEqual(dois.map((c) => c.empresa), ['cavallaria', 'awdyna']);
  assert.equal(dois[1].client.arquivo, 'x.html');
});
