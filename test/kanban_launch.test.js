const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { bancoDeTeste } = require('./helpers/db');
const nov = require('./helpers/novidades');
const { aplicarLeitura } = require('../kanban/sync');
const launch = require('../kanban/launch');
const { ClienteGmail, anexosPdf } = require('../kanban/gmail');
const { FonteMock, sincronizarLaunch } = require('../kanban/launch-fonte');
const { criarStorage } = require('../kanban/storage');
const { iniciarS3Dev } = require('../tools/s3-dev');
const { criarRouter } = require('../kanban/routes');

let s3;
let storage;
let pasta;
before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-launch-'));
  s3 = await iniciarS3Dev({ porta: 0, dir: path.join(pasta, 's3'), log: () => {} });
  storage = criarStorage({
    STORAGE_ENDPOINT: `http://127.0.0.1:${s3.porta}`, STORAGE_BUCKET: 'kanban-dev', STORAGE_ACCESS_KEY: 'devkey',
    STORAGE_SECRET_KEY: 'devsecret', STORAGE_REGION: 'us-east-1', STORAGE_PATH_STYLE: 'true',
  });
});
after(async () => {
  await s3.fechar();
  fs.rmSync(pasta, { recursive: true, force: true });
});

const VIN = 'WBAGL61002DM57925';
const PDF = (txt = 'relatorio') => Buffer.from(`%PDF-1.4\n% ${txt}\n%%EOF\n`);

// Card com chassi conhecido e entrada no Onmotor em 20/10/2026 10:00 (SP).
function banco() {
  const db = bancoDeTeste();
  db.transaction(() => aplicarLeitura(db, nov.linhas(), { agora: '2026-10-23T12:00:00.000Z', primeiraCarga: true }))();
  const card = db.prepare('SELECT * FROM kb_cards ORDER BY id LIMIT 1').get();
  db.prepare("UPDATE kb_cards SET chassi = ?, os_entrada_em = '2026-10-20T13:00:00.000Z' WHERE id = ?").run(VIN, card.id);
  return { db, card: db.prepare('SELECT * FROM kb_cards WHERE id = ?').get(card.id) };
}
const importar = (db, nome, quando, extra = {}) => launch.importarRelatorio(db, storage, { origem: 'email', messageId: extra.msg || `m-${nome}-${quando}`, nomeArquivo: nome, bytes: PDF(nome), relatorioEm: quando, ...extra });

test('marca e chassi saem do nome do arquivo', () => {
  assert.deepEqual(launch.extrairDoNome('BMW_WBAGL61002DM57925_AllSystems.pdf'), { marca: 'BMW', chassi: 'WBAGL61002DM57925' });
  assert.deepEqual(launch.extrairDoNome('Ford_3FA6P0D91ER345713_AllSys….pdf'), { marca: 'Ford', chassi: '3FA6P0D91ER345713' });
  assert.deepEqual(launch.extrairDoNome('Land Rover_salga2ke6ka123456_AllSystems.pdf'), { marca: 'Land Rover', chassi: 'SALGA2KE6KA123456' });
  assert.deepEqual(launch.extrairDoNome('relatorio.pdf'), { marca: null, chassi: null });
});

test('relatório do chassi do card é anexado sozinho, com registro na linha do tempo e no ícone do card', async () => {
  const { db, card } = banco();
  const r = await importar(db, `BMW_${VIN}_AllSystems.pdf`, '2026-10-20T13:20:00.000Z');
  assert.equal(r.vinculado, true);
  assert.equal(r.relatorio.card_id, card.id);
  assert.equal(r.relatorio.principal, 1);
  const ev = db.prepare("SELECT * FROM kb_eventos WHERE card_id = ? AND tipo = 'launch'").get(card.id);
  assert.equal(ev.texto, 'Relatório Launch anexado — 20/10/2026 10:20');
  assert.equal(ev.operador_nome, 'Sistema');
  const lista = await launch.listarDoCard(db, storage, card.id);
  assert.equal(lista.length, 1);
  assert.equal(lista[0].url, `/api/kanban/midias/${r.relatorio.midia_id}/abrir`);
  assert.equal((await fetch((await require('../kanban/arquivos').urlDoPdf(db, storage, r.relatorio.midia_id)).url)).status, 200);
});

test('vários relatórios do mesmo chassi: principal = mais próximo da entrada (antes ou depois); demais adicionais em ordem', async () => {
  const { db, card } = banco();
  await importar(db, `BMW_${VIN}_AllSystems.pdf`, '2026-10-21T18:00:00.000Z', { msg: 'a' }); // 1 dia e 5 h depois
  await importar(db, `BMW_${VIN}_AllSystems.pdf`, '2026-10-20T09:00:00.000Z', { msg: 'b' }); // 4 h antes ← mais próximo
  await importar(db, `BMW_${VIN}_AllSystems.pdf`, '2026-10-22T12:00:00.000Z', { msg: 'c' });
  const lista = await launch.listarDoCard(db, storage, card.id);
  assert.deepEqual(lista.map((x) => [x.relatorio_em, x.principal]), [
    ['2026-10-20T09:00:00.000Z', 1],
    ['2026-10-21T18:00:00.000Z', 0],
    ['2026-10-22T12:00:00.000Z', 0],
  ]);
  const textos = db.prepare("SELECT texto FROM kb_eventos WHERE card_id = ? AND tipo = 'launch' ORDER BY id").all(card.id).map((e) => e.texto);
  // o texto segue o prompt; principal/adicional fica na seção do card (situação atual)
  assert.deepEqual(textos, ['Relatório Launch anexado — 21/10/2026 15:00', 'Relatório Launch anexado — 20/10/2026 06:00', 'Relatório Launch anexado — 22/10/2026 09:00']);
});

test('sem card do chassi (ou fora do período da OS): fica em "não vinculados" até o card ganhar o chassi', async () => {
  const { db, card } = banco();
  const outro = '3FA6P0D91ER345713';
  const r = await importar(db, `Ford_${outro}_AllSystems.pdf`, '2026-10-22T12:00:00.000Z');
  assert.equal(r.vinculado, false);
  const velho = await importar(db, `BMW_${VIN}_AllSystems.pdf`, '2026-09-01T12:00:00.000Z'); // muito antes da entrada
  assert.equal(velho.vinculado, false, 'relatório de outra visita não entra nesta OS');
  const nv = await launch.listarNaoVinculados(db, storage);
  assert.equal(nv.length, 2);
  assert.deepEqual(nv.find((x) => x.chassi === VIN).sugestoes.map((s) => s.id), [card.id], 'sugere o card do mesmo chassi');

  // outro card recebe o chassi do Ford pelo Onmotor → vínculo automático
  const c2 = db.prepare('SELECT * FROM kb_cards WHERE id <> ? ORDER BY id LIMIT 1').get(card.id);
  db.prepare("UPDATE kb_cards SET chassi = ?, os_entrada_em = '2026-10-22T11:00:00.000Z' WHERE id = ?").run(outro, c2.id);
  assert.equal(launch.vincularPendentes(db, c2.id), 1);
  assert.equal((await launch.listarDoCard(db, storage, c2.id)).length, 1);
});

test('vínculo manual e desvínculo; card sem chassi passa a casar pela placa', async () => {
  const { db } = banco();
  const semChassi = db.prepare('SELECT * FROM kb_cards WHERE chassi IS NULL ORDER BY id LIMIT 1').get();
  const outro = 'SALGA2KE6KA123456';
  const r = await importar(db, `Land Rover_${outro}_AllSystems.pdf`, '2026-10-23T12:00:00.000Z');
  assert.equal(r.vinculado, false);
  launch.vincularManual(db, r.relatorio.id, semChassi.id, { operador: 'Gerência' });
  assert.equal(db.prepare('SELECT placa_normalizada FROM veiculos WHERE chassi = ?').get(outro).placa_normalizada, semChassi.placa_normalizada);
  const ev = db.prepare("SELECT texto FROM kb_eventos WHERE card_id = ? AND tipo = 'launch'").get(semChassi.id);
  assert.match(ev.texto, /\(vinculado por Gerência\)$/);
  // próximo relatório do mesmo chassi casa sozinho com o card (pela placa conhecida)
  const r2 = await importar(db, `Land Rover_${outro}_AllSystems.pdf`, '2026-10-23T15:00:00.000Z', { msg: 'x2' });
  assert.equal(r2.vinculado, true);
  assert.equal(r2.relatorio.card_id, semChassi.id);
  launch.desvincular(db, r.relatorio.id, { operador: 'Gerência' });
  assert.equal(db.prepare('SELECT card_id FROM launch_relatorios WHERE id = ?').get(r.relatorio.id).card_id, null);
  assert.equal(db.prepare('SELECT principal FROM launch_relatorios WHERE id = ?').get(r2.relatorio.id).principal, 1);
});

test('validações: só PDF de verdade, tamanho, e o mesmo anexo do mesmo e-mail não entra duas vezes', async () => {
  const { db } = banco();
  await assert.rejects(launch.importarRelatorio(db, storage, { origem: 'email', nomeArquivo: 'x.docx', bytes: PDF() }), (e) => e.status === 415);
  await assert.rejects(launch.importarRelatorio(db, storage, { origem: 'email', nomeArquivo: 'x.pdf', bytes: Buffer.from('<html>') }), /PDF válido/);
  const a = await importar(db, `BMW_${VIN}_AllSystems.pdf`, '2026-10-20T13:20:00.000Z', { msg: 'dup' });
  const b = await importar(db, `BMW_${VIN}_AllSystems.pdf`, '2026-10-20T13:20:00.000Z', { msg: 'dup' });
  assert.ok(a.relatorio);
  assert.equal(b.duplicado, true);
});

// ---------- Gmail ----------
function gmailFalso({ mensagens, tokenErro = null, expira401 = false }) {
  const chamadas = [];
  let tokens = 0;
  let primeira401 = expira401;
  const json = (corpo, status = 200) => ({ ok: status < 400, status, json: async () => corpo });
  const fetchImpl = async (url, opts = {}) => {
    chamadas.push(url.replace(/\?.*/, ''));
    if (url.startsWith('https://oauth2.googleapis.com/token')) {
      if (tokenErro) return json({ error: tokenErro }, 400);
      tokens++;
      assert.match(String(opts.body), /grant_type=refresh_token/);
      return json({ access_token: `tk${tokens}`, expires_in: 3600 });
    }
    if (primeira401) { primeira401 = false; return json({}, 401); }
    assert.match(opts.headers.Authorization, /^Bearer tk\d$/);
    if (url.includes('/messages?')) return json({ messages: mensagens.map((m) => ({ id: m.id })) });
    const att = url.match(/\/messages\/([^/]+)\/attachments\/(.+)$/);
    if (att) return json({ data: Buffer.from(`%PDF-1.4 anexo ${att[2]}`).toString('base64url') });
    const id = url.match(/\/messages\/([^/?]+)\?format=full/)[1];
    return json(mensagens.find((m) => m.id === id).msg);
  };
  return { fetchImpl, chamadas, tokens: () => tokens };
}

const ENV = { GMAIL_CLIENT_ID: 'id', GMAIL_CLIENT_SECRET: 'segredo', GMAIL_REFRESH_TOKEN: 'refresh' };
const msgGmail = (id, filename, subject = 'LAUNCH', from = 'LAUNCH <report@x431.com>') => ({
  id,
  msg: {
    id, internalDate: String(Date.parse('2026-10-20T13:20:00.000Z')),
    payload: {
      headers: [{ name: 'Subject', value: subject }, { name: 'From', value: from }],
      mimeType: 'multipart/mixed',
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from('Dear customer, cavallaria has given you').toString('base64url') } },
        { mimeType: 'multipart/alternative', parts: [{ filename, mimeType: 'application/pdf', body: { attachmentId: `att-${id}`, size: 20 } }] },
      ],
    },
  },
});

test('Gmail: renova o token, lista, lê anexos PDF em qualquer nível e decodifica base64url', async () => {
  const f = gmailFalso({ mensagens: [msgGmail('m1', `BMW_${VIN}_AllSystems.pdf`)], expira401: true });
  const g = new ClienteGmail({ env: ENV, fetchImpl: f.fetchImpl });
  const novas = await g.buscarNovas(() => false);
  assert.equal(novas.length, 1);
  assert.equal(novas[0].assunto, 'LAUNCH');
  assert.equal(novas[0].recebidoEm, '2026-10-20T13:20:00.000Z');
  assert.equal(novas[0].anexos[0].nome, `BMW_${VIN}_AllSystems.pdf`);
  assert.match((await novas[0].anexos[0].carregar()).toString(), /^%PDF-1\.4 anexo att-m1/);
  assert.equal(f.tokens(), 2, 'pegou token novo depois do 401');
  assert.deepEqual(anexosPdf({ parts: [{ filename: 'foto.jpg', body: { attachmentId: 'x' } }] }), []);
});

test('Gmail: autorização revogada dá mensagem clara; sem variáveis não inicia', async () => {
  const f = gmailFalso({ mensagens: [], tokenErro: 'invalid_grant' });
  await assert.rejects(new ClienteGmail({ env: ENV, fetchImpl: f.fetchImpl }).listarIds(), /refaça o passo de autorização/);
  assert.throws(() => new ClienteGmail({ env: {} }), /não configurado/);
});

test('rodada de importação: processa cada e-mail uma vez só e ignora e-mail que não é do LAUNCH', async () => {
  const { db, card } = banco();
  const f = gmailFalso({ mensagens: [msgGmail('m1', `BMW_${VIN}_AllSystems.pdf`), msgGmail('m2', 'boleto.pdf', 'Fatura de outubro', 'Banco <fatura@banco.com>')] });
  const fonte = new ClienteGmail({ env: ENV, fetchImpl: f.fetchImpl });
  const r1 = await sincronizarLaunch(db, storage, fonte, { log: () => {} });
  assert.deepEqual({ ok: r1.ok, emails: r1.emails, novos: r1.novos, vinculados: r1.vinculados }, { ok: true, emails: 1, novos: 1, vinculados: 1 });
  assert.deepEqual(db.prepare('SELECT message_id, status FROM launch_emails ORDER BY message_id').all(), [
    { message_id: 'm1', status: 'ok' }, { message_id: 'm2', status: 'ignorado' },
  ]);
  assert.equal((await launch.listarDoCard(db, storage, card.id)).length, 1);
  const antes = f.chamadas.length;
  const r2 = await sincronizarLaunch(db, storage, fonte, { log: () => {} });
  assert.equal(r2.novos, 0);
  assert.ok(!f.chamadas.slice(antes).some((u) => /format=full|attachments/.test(u)), 'não baixa de novo o que já foi processado');
});

test('fonte simulada (pasta de PDFs) para o desenvolvimento', async () => {
  const { db, card } = banco();
  const dir = path.join(pasta, 'caixa');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `BMW_${VIN}_AllSystems.pdf`), PDF('mock'));
  const quando = new Date('2026-10-20T14:00:00.000Z');
  fs.utimesSync(path.join(dir, `BMW_${VIN}_AllSystems.pdf`), quando, quando);
  const fonte = new FonteMock({ pasta: dir });
  const r = await sincronizarLaunch(db, storage, fonte, { log: () => {} });
  assert.equal(r.vinculados, 1);
  assert.equal((await launch.listarDoCard(db, storage, card.id))[0].relatorio_em, '2026-10-20T14:00:00.000Z');
  assert.equal((await sincronizarLaunch(db, storage, fonte, { log: () => {} })).novos, 0);
});

test('rota: envio manual de PDF pelo card e lista de não vinculados', async () => {
  const { db, card } = banco();
  const app = express();
  app.use(express.json());
  app.use('/api/kanban', criarRouter({ db, log: () => {}, criarCliente: () => null, storage }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api/kanban`;
  try {
    let r = await fetch(`${base}/cards/${card.id}/launch?operador=Luan&nome=${encodeURIComponent('escaneamento manual.pdf')}`, {
      method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: PDF('manual'),
    });
    assert.equal(r.status, 200);
    const lista = await (await fetch(`${base}/cards/${card.id}/launch`)).json();
    assert.equal(lista[0].origem, 'manual');
    assert.equal(lista[0].vinculado_por, 'Luan');
    r = await fetch(`${base}/cards/${card.id}/launch?operador=Luan&nome=x.pdf`, { method: 'POST', headers: { 'Content-Type': 'application/pdf' }, body: Buffer.from('nada') });
    assert.equal(r.status, 415);
    const est = await (await fetch(`${base}/estado`)).json();
    assert.equal(est.cards.find((x) => x.id === card.id).qtd_launch, 1);
    const nv = await (await fetch(`${base}/launch/nao-vinculados`)).json();
    assert.equal(nv.relatorios.length, 0);
    // o PDF abre pela rota do app: registra na auditoria e redireciona para a URL assinada
    const abrir = await fetch(`http://127.0.0.1:${srv.address().port}${lista[0].url}`, { redirect: 'manual' });
    assert.equal(abrir.status, 302);
    assert.match(abrir.headers.get('location'), /X-Amz-Signature=.*filename%3D%22escaneamento_manual\.pdf%22/);
    assert.equal((await fetch(abrir.headers.get('location'))).status, 200);
    const aud = db.prepare("SELECT * FROM auditoria WHERE acao = 'pdf_aberto'").get();
    assert.equal(aud.card_id, card.id);
    assert.equal((await fetch(`${base}/midias/999999/abrir`, { redirect: 'manual' })).status, 404);
  } finally {
    srv.close();
  }
});

// ---------- relatório por link (o scanner não anexa o PDF) ----------
const msgLink = (id, nome, url) => ({
  id,
  msg: {
    id, internalDate: String(Date.parse('2026-10-23T18:44:36.000Z')),
    payload: {
      headers: [{ name: 'Subject', value: nome }, { name: 'From', value: 'diagnostic_report@cnlaunch.com' }],
      mimeType: 'multipart/alternative',
      parts: [
        { mimeType: 'text/plain', body: { data: Buffer.from(`Report: ${url}\nhttps://www.cnlaunch.com/`).toString('base64url') } },
        { mimeType: 'text/html', body: { data: Buffer.from(`<a href="${url.replace(/&/g, '&amp;')}">PDF</a> <a href="https://evil.example.com/x.pdf">x</a>`).toString('base64url') } },
      ],
    },
  },
});

function comDownloads(base, arquivos) {
  const baixados = [];
  const fetchImpl = async (url, opts) => {
    if (arquivos[url] !== undefined) {
      baixados.push(url);
      const corpo = arquivos[url];
      return { ok: true, status: 200, url, headers: { get: () => String(corpo.length) }, arrayBuffer: async () => corpo };
    }
    return base(url, opts);
  };
  return { fetchImpl, baixados };
}

test('Gmail: relatório do scanner por link (servidor da Launch), nome do assunto, e o mesmo relatório em 2 e-mails entra 1 vez', async () => {
  const { db, card } = banco();
  const nome = `BMW_${VIN}_AllSystemDTC_20261023154436.pdf`;
  const url = 'https://usglfile.dbscar.com/ait_report/20261024/92/1e/abc123def456.pdf?sig=1&x=2';
  const f = gmailFalso({ mensagens: [msgLink('l1', nome, url), msgLink('l2', nome, url)] });
  const d = comDownloads(f.fetchImpl, { [url]: PDF('do link') });
  const fonte = new ClienteGmail({ env: ENV, fetchImpl: d.fetchImpl });
  const r = await sincronizarLaunch(db, storage, fonte, { log: () => {} });
  assert.deepEqual({ ok: r.ok, emails: r.emails, novos: r.novos, vinculados: r.vinculados }, { ok: true, emails: 2, novos: 1, vinculados: 1 });
  assert.deepEqual(d.baixados, [url, url], 'só o link da Launch, nunca o de outro servidor');
  const lista = await launch.listarDoCard(db, storage, card.id);
  assert.equal(lista.length, 1);
  assert.equal(lista[0].nome_arquivo, nome);
});

test('Gmail: links fora dos servidores da Launch ou sem https são ignorados; redirecionamento para fora é recusado', async () => {
  const { linksPdf } = require('../kanban/gmail');
  const parte = (t) => ({ mimeType: 'text/plain', body: { data: Buffer.from(t).toString('base64url') } });
  assert.deepEqual(linksPdf(parte('a http://usglfile.dbscar.com/r.pdf b https://dbscar.com.evil.io/r.pdf c https://x.dbscar.com/r.html')), []);
  assert.deepEqual(linksPdf(parte('ok https://usglfile.dbscar.com/r/1.pdf.')), ['https://usglfile.dbscar.com/r/1.pdf']);
  const g = new ClienteGmail({ env: ENV, fetchImpl: async (u) => ({ ok: true, status: 200, url: 'https://evil.example.com/r.pdf', headers: { get: () => null }, arrayBuffer: async () => PDF() }) });
  await assert.rejects(g.baixarLink('https://usglfile.dbscar.com/r/1.pdf'), /saiu do servidor da Launch/);
});

test('Gmail: limite de velocidade espera e tenta de novo; no máximo N e-mails por rodada; link vencido marca só aquele e-mail', async () => {
  const { db } = banco();
  const urlOk = 'https://usglfile.dbscar.com/ait_report/1/ok.pdf';
  const urlVencido = 'https://usglfile.dbscar.com/ait_report/1/vencido.pdf';
  const msgs = [
    msgLink('v1', `Audi_${VIN}_AllSystemDTC_20261020080000.pdf`, urlVencido),
    msgLink('o1', `BMW_${VIN}_AllSystemDTC_20261020090000.pdf`, urlOk),
    msgLink('o2', `BMW_${VIN}_AllSystemDTC_20261020100000.pdf`, urlOk),
  ];
  const f = gmailFalso({ mensagens: msgs });
  let limitou = false;
  const fetchImpl = async (url, opts) => {
    if (url === urlVencido) return { ok: false, status: 404, url, headers: { get: () => null }, arrayBuffer: async () => Buffer.alloc(0) };
    if (url === urlOk) { const c = PDF(url); return { ok: true, status: 200, url, headers: { get: () => null }, arrayBuffer: async () => c }; }
    if (!limitou && /\/messages\/o1\?/.test(url)) {
      limitou = true;
      return { ok: false, status: 403, json: async () => ({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }) };
    }
    return f.fetchImpl(url, opts);
  };
  const fonte = new ClienteGmail({ env: ENV, fetchImpl, porRodada: 2, esperaBaseMs: 1 });
  const r1 = await sincronizarLaunch(db, storage, fonte, { log: () => {} });
  assert.equal(r1.ok, true);
  assert.equal(limitou, true);
  assert.deepEqual(db.prepare('SELECT message_id, status FROM launch_emails ORDER BY message_id').all().map((e) => `${e.message_id}:${e.status}`).sort(), ['o1:ok', 'o2:ok'],
    'a lista do Gmail vem do mais novo para o mais antigo: os 2 mais antigos (o2, o1) entram primeiro');
  const r2 = await sincronizarLaunch(db, storage, fonte, { log: () => {} });
  assert.equal(r2.ok, true);
  assert.equal(db.prepare("SELECT status FROM launch_emails WHERE message_id = 'v1'").get().status, 'erro', 'link vencido não trava a fila');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM launch_emails').get().n, 3);
});
