const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { bancoDeTeste } = require('./helpers/db');
const nov = require('./helpers/novidades');
const { aplicarLeitura } = require('../kanban/sync');
const { arquivarCard } = require('../kanban/acoes');
const lt = require('../kanban/linha-tempo');
const { criarStorage } = require('../kanban/storage');
const { iniciarS3Dev } = require('../tools/s3-dev');
const { criarRouter } = require('../kanban/routes');

let s3;
let storage;
let pasta;

before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-s3-'));
  s3 = await iniciarS3Dev({ porta: 0, dir: pasta, log: () => {} });
  storage = criarStorage({
    STORAGE_ENDPOINT: `http://127.0.0.1:${s3.porta}`, STORAGE_BUCKET: 'kanban-dev', STORAGE_ACCESS_KEY: 'devkey',
    STORAGE_SECRET_KEY: 'devsecret', STORAGE_REGION: 'us-east-1', STORAGE_PATH_STYLE: 'true',
  });
});
after(async () => {
  await s3.fechar();
  fs.rmSync(pasta, { recursive: true, force: true });
});

function banco() {
  const db = bancoDeTeste();
  db.transaction(() => aplicarLeitura(db, nov.linhas(), { agora: '2026-10-23T12:00:00.000Z', primeiraCarga: true }))();
  return db;
}
const umCard = (db) => db.prepare('SELECT * FROM kb_cards ORDER BY id LIMIT 1').get();
const eventosDe = (db, id) => db.prepare('SELECT * FROM kb_eventos WHERE card_id = ? ORDER BY id').all(id);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(2000, 7)]);

async function enviar(url, mime, corpo) {
  const r = await fetch(url, { method: 'PUT', headers: { 'Content-Type': mime }, body: corpo });
  return r.status;
}

test('storage sem configuração: avisa e não quebra a linha do tempo de texto', async () => {
  const st = criarStorage({});
  assert.equal(st.configurado, false);
  const db = banco();
  const c = umCard(db);
  await assert.rejects(lt.pedirEnvio(db, st, c.id, { cliente_id: 'abcdefgh-1', tipo: 'foto', mime: 'image/jpeg', tamanho: 10, operador: 'Luan' }),
    (e) => e.status === 503);
  lt.postarTexto(db, c.id, { texto: 'Cliente pediu orçamento de pastilhas', operador: 'Luan' });
  const evs = await lt.listarEventos(db, st, c.id);
  assert.equal(evs[0].texto, 'Cliente pediu orçamento de pastilhas');
});

test('texto: posta, edita guardando a versão anterior e remove sem apagar', async () => {
  const db = banco();
  const c = umCard(db);
  const e = lt.postarTexto(db, c.id, { texto: '  Barulho na suspensão dianteira  ', operador: 'Edson' }, { agora: '2026-10-23T13:00:00.000Z' });
  assert.equal(e.texto, 'Barulho na suspensão dianteira');
  assert.equal(e.operador_nome, 'Edson');

  lt.editarTexto(db, e.id, { texto: 'Barulho na suspensão dianteira esquerda', operador: 'Vanilton' }, { agora: '2026-10-23T13:05:00.000Z' });
  const v = lt.versoesTexto(db, e.id);
  assert.equal(v.atual.texto, 'Barulho na suspensão dianteira esquerda');
  assert.equal(v.atual.editado_em, '2026-10-23T13:05:00.000Z');
  assert.deepEqual(v.versoes, [{ texto: 'Barulho na suspensão dianteira', editado_por: 'Vanilton', editado_em: '2026-10-23T13:05:00.000Z' }]);

  lt.removerRegistro(db, e.id, { operador: 'Gerência' });
  const evs = await lt.listarEventos(db, storage, c.id);
  assert.ok(!evs.some((x) => x.id === e.id), 'removido some da linha do tempo');
  const noBanco = db.prepare('SELECT * FROM kb_eventos WHERE id = ?').get(e.id);
  assert.equal(noBanco.removido_por, 'Gerência', 'mas continua no banco para auditoria');
  assert.throws(() => lt.editarTexto(db, e.id, { texto: 'x', operador: 'Luan' }), (x) => x.status === 404);
});

test('texto: validações', () => {
  const db = banco();
  const c = umCard(db);
  assert.throws(() => lt.postarTexto(db, c.id, { texto: '   ', operador: 'Luan' }), (e) => e.status === 400);
  assert.throws(() => lt.postarTexto(db, c.id, { texto: 'x'.repeat(5001), operador: 'Luan' }), (e) => e.status === 400);
  assert.throws(() => lt.postarTexto(db, c.id, { texto: 'oi' }), (e) => e.status === 400 && /operador/.test(e.message));
  const criado = eventosDe(db, c.id)[0];
  assert.throws(() => lt.removerRegistro(db, criado.id, { operador: 'Luan' }), (e) => e.status === 400, 'registro automático não sai');
  assert.throws(() => lt.editarTexto(db, criado.id, { texto: 'x', operador: 'Luan' }), (e) => e.status === 400);
  arquivarCard(db, c.id, { operador: 'Luan' });
  assert.throws(() => lt.postarTexto(db, c.id, { texto: 'oi', operador: 'Luan' }), (e) => e.status === 409);
});

test('foto: pedir → enviar ao bucket → confirmar publica na linha do tempo com URLs assinadas', async () => {
  const db = banco();
  const c = umCard(db);
  const p = await lt.pedirEnvio(db, storage, c.id, {
    cliente_id: 'f0f0f0f0-0001', tipo: 'foto', mime: 'image/jpeg', tamanho: JPEG.length, largura: 1920, altura: 1440, miniatura: true, operador: 'Matheus',
  });
  assert.ok(p.upload_url && p.miniatura_url);
  assert.match(new URL(p.upload_url).pathname, new RegExp(`^/kanban-dev/cards/${c.id}/\\d{4}/\\d{2}/[0-9a-f-]{36}\\.jpg$`));

  // antes de enviar, a confirmação recusa
  await assert.rejects(lt.confirmarEnvio(db, storage, p.midia_id, { operador: 'Matheus' }), (e) => e.status === 409);

  assert.equal(await enviar(p.upload_url, 'image/jpeg', JPEG), 200);
  assert.equal(await enviar(p.miniatura_url, 'image/jpeg', JPEG.subarray(0, 500)), 200);
  const conf = await lt.confirmarEnvio(db, storage, p.midia_id, { legenda: 'Pastilha dianteira gasta', operador: 'Matheus' });
  assert.equal(conf.ja_enviado, false);

  const evs = await lt.listarEventos(db, storage, c.id);
  const ev = evs.find((e) => e.id === conf.evento_id);
  assert.equal(ev.tipo, 'foto');
  assert.equal(ev.texto, 'Pastilha dianteira gasta');
  assert.equal(ev.operador_nome, 'Matheus');
  assert.equal(ev.midia.largura, 1920);
  const r = await fetch(ev.midia.url);
  assert.equal(r.status, 200);
  assert.equal(Buffer.from(await r.arrayBuffer()).length, JPEG.length);
  assert.equal((await fetch(ev.midia.miniatura_url)).status, 200);
  assert.match(ev.midia.url, /X-Amz-Expires=900/, 'ver: 15 minutos');

  // confirmar de novo não duplica
  const de = await lt.confirmarEnvio(db, storage, p.midia_id, { operador: 'Matheus' });
  assert.equal(de.ja_enviado, true);
  assert.equal(eventosDe(db, c.id).filter((e) => e.tipo === 'foto').length, 1);
});

test('envio retomado com o mesmo identificador não cria outra mídia', async () => {
  const db = banco();
  const c = umCard(db);
  const dados = { cliente_id: 'retoma-0001', tipo: 'audio', mime: 'audio/webm;codecs=opus', tamanho: 300, duracao: 4.2, operador: 'Iago' };
  const a = await lt.pedirEnvio(db, storage, c.id, dados);
  const b = await lt.pedirEnvio(db, storage, c.id, dados);
  assert.equal(a.midia_id, b.midia_id);
  assert.equal(a.mime, 'audio/webm', 'parâmetros do tipo são retirados (o PUT usa o tipo base)');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kb_midias').get().n, 1);
  assert.equal(await enviar(b.upload_url, 'audio/webm', Buffer.alloc(300, 1)), 200);
  await lt.confirmarEnvio(db, storage, b.midia_id, { operador: 'Iago' });
  const c2 = await lt.pedirEnvio(db, storage, c.id, dados);
  assert.equal(c2.ja_enviado, true);
});

test('arquivo incompleto no bucket é recusado na confirmação', async () => {
  const db = banco();
  const c = umCard(db);
  const p = await lt.pedirEnvio(db, storage, c.id, { cliente_id: 'parcial-001', tipo: 'foto', mime: 'image/jpeg', tamanho: 5000, operador: 'Luan' });
  assert.equal(await enviar(p.upload_url, 'image/jpeg', Buffer.alloc(1200, 1)), 200);
  await assert.rejects(lt.confirmarEnvio(db, storage, p.midia_id, { operador: 'Luan' }), (e) => e.status === 409 && /incompleto/.test(e.message));
});

test('vídeo: obrigatório informar a duração e no máximo 2 minutos; formatos e tamanhos validados', async () => {
  const db = banco();
  const c = umCard(db);
  const base = { tipo: 'video', mime: 'video/mp4', tamanho: 1000, operador: 'Luan' };
  await assert.rejects(lt.pedirEnvio(db, storage, c.id, { ...base, cliente_id: 'video-0001' }), (e) => e.status === 400 && /Duração/.test(e.message));
  await assert.rejects(lt.pedirEnvio(db, storage, c.id, { ...base, cliente_id: 'video-0002', duracao: 125 }), (e) => /2 minutos/.test(e.message));
  const ok = await lt.pedirEnvio(db, storage, c.id, { ...base, cliente_id: 'video-0003', duracao: 119.5, miniatura: true });
  assert.ok(ok.miniatura_url);
  await assert.rejects(lt.pedirEnvio(db, storage, c.id, { ...base, cliente_id: 'video-0004', duracao: 10, tamanho: 600 * 1024 * 1024 }), (e) => e.status === 413);
  await assert.rejects(lt.pedirEnvio(db, storage, c.id, { tipo: 'foto', mime: 'application/pdf', tamanho: 10, cliente_id: 'pdf-00001', operador: 'Luan' }), (e) => e.status === 415);
  await assert.rejects(lt.pedirEnvio(db, storage, c.id, { tipo: 'foto', mime: 'image/jpeg', tamanho: 10, cliente_id: '../../x', operador: 'Luan' }), (e) => e.status === 400);
});

test('URL de envio assinada para um tipo não aceita outro tipo de arquivo', async () => {
  const db = banco();
  const c = umCard(db);
  const p = await lt.pedirEnvio(db, storage, c.id, { cliente_id: 'tipo-00001', tipo: 'foto', mime: 'image/jpeg', tamanho: 10, operador: 'Luan' });
  assert.equal(await enviar(p.upload_url, 'text/html', Buffer.from('<script>')), 403);
});

test('remover uma foto tira da linha do tempo e da contagem de mídias do card', async () => {
  const db = banco();
  const c = umCard(db);
  const p = await lt.pedirEnvio(db, storage, c.id, { cliente_id: 'remove-0001', tipo: 'foto', mime: 'image/jpeg', tamanho: JPEG.length, operador: 'Luan' });
  await enviar(p.upload_url, 'image/jpeg', JPEG);
  const { evento_id } = await lt.confirmarEnvio(db, storage, p.midia_id, { operador: 'Luan' });

  const app = express();
  app.use(express.json());
  app.use('/api/kanban', criarRouter({ db, log: () => {}, criarCliente: () => null, storage }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api/kanban`;
  try {
    const qtd = async () => (await (await fetch(`${base}/estado`)).json()).cards.find((x) => x.id === c.id).qtd_midias;
    assert.equal(await qtd(), 1);
    const r = await fetch(`${base}/eventos/${evento_id}/remover`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operador: 'Gerência' }) });
    assert.equal(r.status, 200);
    assert.equal(await qtd(), 0);
    const det = await (await fetch(`${base}/cards/${c.id}`)).json();
    assert.ok(!det.eventos.some((e) => e.id === evento_id));
    const estado = await (await fetch(`${base}/estado`)).json();
    assert.equal(estado.storage_configurado, true);
    assert.equal(estado.limites.video_max_s, 120);
  } finally {
    srv.close();
  }
});
