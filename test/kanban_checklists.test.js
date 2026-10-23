const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const express = require('express');
const { bancoDeTeste } = require('./helpers/db');
const nov = require('./helpers/novidades');
const { aplicarLeitura } = require('../kanban/sync');
const chk = require('../kanban/checklists');
const lt = require('../kanban/linha-tempo');
const pdf = require('../kanban/pdf');
const { criarStorage } = require('../kanban/storage');
const { iniciarS3Dev } = require('../tools/s3-dev');
const { criarRouter } = require('../kanban/routes');

let s3;
let storage;
let pasta;
before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-chk-'));
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
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(1500, 9)]);
let seq = 0;

async function fotoDoItem(db, cardId, execId, itemId, avariaId = null) {
  const p = await lt.pedirEnvio(db, storage, cardId, {
    cliente_id: `chk-${process.pid}-${++seq}`, tipo: 'foto', mime: 'image/jpeg', tamanho: JPEG.length, operador: 'Edson',
    checklist_execucao_id: execId, checklist_item_id: itemId, avaria_id: avariaId,
  });
  const r = await fetch(p.upload_url, { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: JPEG });
  assert.equal(r.status, 200);
  return lt.confirmarEnvio(db, storage, p.midia_id, { operador: 'Edson' });
}

// Preenche a vistoria inteira (13 fotos + KM + avarias + combustível + itens).
async function preencher(db, card, execId, { avaria = false } = {}) {
  const modelo = chk.modeloAtivo(db, 'entrada');
  const itens = chk.itensDoModelo(modelo);
  for (const i of itens.filter((x) => x.secao.tipo === 'fotos_obrigatorias')) await fotoDoItem(db, card.id, execId, i.id);
  chk.responder(db, execId, itens[0].id, { valor: { medidas: { KM: '87.450' } }, operador: 'Edson' });
  const itAv = itens.find((x) => x.codigo === 'e_avarias');
  if (avaria) {
    const a = chk.criarAvaria(db, execId, { regiao: 'Porta DE', descricao: 'Risco de 10 cm na porta', operador: 'Edson' });
    await fotoDoItem(db, card.id, execId, itAv.id, a.id);
  } else {
    chk.responder(db, execId, itAv.id, { valor: { sim: false }, operador: 'Edson' });
  }
  chk.responder(db, execId, itens.find((x) => x.codigo === 'e_combustivel').id, { valor: { opcao: '1/2' }, operador: 'Edson' });
  chk.responder(db, execId, itens.find((x) => x.codigo === 'e_itens_presentes').id, { valor: { marcados: ['Tapetes', 'Estepe'] }, operador: 'Edson' });
  return itens;
}

test('modelo da vistoria de entrada: 13 fotos na ordem do prompt, avarias, combustível e itens', () => {
  const db = banco();
  const m = chk.modeloAtivo(db, 'entrada');
  assert.equal(m.nome, 'Vistoria de entrada');
  assert.deepEqual(m.secoes.map((s) => s.tipo), ['fotos_obrigatorias', 'avarias', 'itens']);
  assert.deepEqual(m.secoes[0].itens.map((i) => i.texto), [
    'Painel com motor ligado mostrando odômetro', 'Bancos dianteiros', 'Bancos traseiros', 'Porta-malas', 'Cofre do motor',
    'Frente do veículo', 'Quina dianteira esquerda', 'Quina dianteira direita', 'Lateral esquerda', 'Lateral direita',
    'Quina traseira esquerda', 'Quina traseira direita', 'Traseira',
  ]);
  assert.ok(m.secoes[0].itens.every((i) => i.instrucao && i.componentes.some((c) => c.tipo === 'foto' && c.obrigatorio)));
  assert.ok(m.secoes[0].itens[0].componentes.some((c) => c.tipo === 'medida' && c.rotulo === 'KM' && c.obrigatorio));
  assert.deepEqual(m.secoes[2].itens[0].componentes[0].opcoes, ['Reserva', '1/4', '1/2', '3/4', 'Cheio']);
  assert.deepEqual(m.secoes[2].itens[1].componentes[0].opcoes, ['Estepe', 'Macaco', 'Chave de roda', 'Triângulo', 'Documento', 'Tapetes']);
});

test('iniciar registra quem faz e vai para a linha do tempo; iniciar de novo retoma a mesma vistoria', () => {
  const db = banco();
  const c = umCard(db);
  const a = chk.iniciar(db, c.id, 'entrada', { feitoPor: 'Edson', operador: 'Luan' });
  assert.equal(a.retomada, false);
  assert.equal(a.execucao.feito_por, 'Edson');
  assert.equal(a.execucao.status, 'em_andamento');
  const ev = db.prepare("SELECT * FROM kb_eventos WHERE card_id = ? AND tipo = 'checklist_iniciado'").get(c.id);
  assert.equal(ev.texto, 'Vistoria de entrada iniciada por Edson');
  const b = chk.iniciar(db, c.id, 'entrada', { feitoPor: 'Iago', operador: 'Iago' });
  assert.equal(b.retomada, true);
  assert.equal(b.execucao.id, a.execucao.id);
  assert.throws(() => chk.iniciar(db, c.id, 'nao-existe', { operador: 'Luan' }), (e) => e.status === 404);
});

test('respostas: KM numérico inteiro (aceita "87.450"), opções e lista validadas; salva item a item', () => {
  const db = banco();
  const c = umCard(db);
  const { execucao } = chk.iniciar(db, c.id, 'entrada', { feitoPor: 'Edson', operador: 'Edson' });
  const itens = chk.itensDoModelo(chk.modeloAtivo(db, 'entrada'));
  const km = itens[0];
  assert.deepEqual(chk.responder(db, execucao.id, km.id, { valor: { medidas: { KM: '87.450' } }, operador: 'Edson' }).valor, { medidas: { KM: 87450 } });
  assert.throws(() => chk.responder(db, execucao.id, km.id, { valor: { medidas: { KM: 'abc' } }, operador: 'Edson' }), /número/);
  assert.throws(() => chk.responder(db, execucao.id, km.id, { valor: { medidas: { KM: '-5' } }, operador: 'Edson' }), /mínimo/);
  assert.throws(() => chk.responder(db, execucao.id, km.id, { valor: { medidas: { KM: '12,5' } }, operador: 'Edson' }), /inteiro/);
  assert.throws(() => chk.responder(db, execucao.id, km.id, { valor: {}, operador: 'Edson' }), /Informe KM/);
  const comb = itens.find((i) => i.codigo === 'e_combustivel');
  assert.throws(() => chk.responder(db, execucao.id, comb.id, { valor: { opcao: '5/4' }, operador: 'Edson' }), /inválida/);
  const pres = itens.find((i) => i.codigo === 'e_itens_presentes');
  assert.deepEqual(chk.responder(db, execucao.id, pres.id, { valor: { marcados: ['Tapetes', 'Estepe', 'Tapetes'] }, operador: 'Edson' }).valor,
    { marcados: ['Estepe', 'Tapetes'] });
  assert.throws(() => chk.responder(db, execucao.id, pres.id, { valor: { marcados: ['Rádio'] }, operador: 'Edson' }), /inválido/);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM kb_checklist_respostas WHERE execucao_id = ?').get(execucao.id).n, 2);
});

test('fotos do checklist ficam presas ao item e não viram registros soltos na linha do tempo', async () => {
  const db = banco();
  const c = umCard(db);
  const { execucao } = chk.iniciar(db, c.id, 'entrada', { feitoPor: 'Edson', operador: 'Edson' });
  const item = chk.modeloAtivo(db, 'entrada').secoes[0].itens[3];
  const r = await fotoDoItem(db, c.id, execucao.id, item.id);
  assert.equal(r.evento_id, null);
  const m = db.prepare('SELECT * FROM kb_midias WHERE id = ?').get(r.midia_id);
  assert.equal(m.checklist_execucao_id, execucao.id);
  assert.equal(m.checklist_item_id, item.id);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM kb_eventos WHERE card_id = ? AND tipo = 'foto'").get(c.id).n, 0);

  // vínculo inválido: item de outro modelo / checklist de outro card
  const outro = db.prepare('SELECT * FROM kb_cards ORDER BY id DESC LIMIT 1').get();
  await assert.rejects(lt.pedirEnvio(db, storage, outro.id, { cliente_id: 'vinc-0001', tipo: 'foto', mime: 'image/jpeg', tamanho: 10, operador: 'Edson',
    checklist_execucao_id: execucao.id, checklist_item_id: item.id }), (e) => e.status === 400 && /outro card/.test(e.message));
  await assert.rejects(lt.pedirEnvio(db, storage, c.id, { cliente_id: 'vinc-0002', tipo: 'foto', mime: 'image/jpeg', tamanho: 10, operador: 'Edson',
    checklist_execucao_id: execucao.id, checklist_item_id: 999999 }), (e) => e.status === 400);
});

test('pendências: não deixa finalizar sem as 13 fotos, KM, avarias, combustível', async () => {
  const db = banco();
  const c = umCard(db);
  const { execucao } = chk.iniciar(db, c.id, 'entrada', { feitoPor: 'Edson', operador: 'Edson' });
  const faltas = chk.pendencias(db, execucao.id);
  assert.equal(faltas.filter((f) => f.startsWith('Foto:')).length, 13);
  assert.ok(faltas.includes('KM: Painel com motor ligado mostrando odômetro'));
  assert.ok(faltas.includes('Identificou alguma avaria?'));
  assert.ok(faltas.includes('Nível de combustível'));
  assert.throws(() => chk.finalizar(db, execucao.id, { operador: 'Edson' }), (e) => e.status === 400 && e.pendencias.length === 16);
});

test('avarias: Sim exige ao menos uma avaria com foto; região e descrição validadas; remover tira da conta', async () => {
  const db = banco();
  const c = umCard(db);
  const { execucao } = chk.iniciar(db, c.id, 'entrada', { feitoPor: 'Edson', operador: 'Edson' });
  const itens = chk.itensDoModelo(chk.modeloAtivo(db, 'entrada'));
  const itAv = itens.find((x) => x.codigo === 'e_avarias');
  chk.responder(db, execucao.id, itAv.id, { valor: { sim: true }, operador: 'Edson' });
  assert.ok(chk.pendencias(db, execucao.id).some((f) => /nenhuma avaria foi registrada/.test(f)));
  assert.throws(() => chk.criarAvaria(db, execucao.id, { regiao: 'Motor', descricao: 'x', operador: 'Edson' }), /região/);
  assert.throws(() => chk.criarAvaria(db, execucao.id, { regiao: 'Capô', descricao: 'x', operador: 'Edson' }), /Descreva/);
  const a = chk.criarAvaria(db, execucao.id, { regiao: 'Capô', descricao: 'Amassado perto do emblema', operador: 'Edson' });
  assert.ok(chk.pendencias(db, execucao.id).includes('Foto da avaria 1 (Capô)'));
  await fotoDoItem(db, c.id, execucao.id, itAv.id, a.id);
  assert.ok(!chk.pendencias(db, execucao.id).some((f) => /avaria/i.test(f)));
  chk.removerAvaria(db, a.id, { operador: 'Edson' });
  assert.ok(chk.pendencias(db, execucao.id).some((f) => /nenhuma avaria foi registrada/.test(f)));
});

test('finalizar: grava fim, resume na linha do tempo e gera o PDF como versão nova a cada exportação', async () => {
  const db = banco();
  const c = umCard(db);
  const { execucao } = chk.iniciar(db, c.id, 'entrada', { feitoPor: 'Edson', operador: 'Edson' });
  await preencher(db, c, execucao.id, { avaria: true });
  assert.deepEqual(chk.pendencias(db, execucao.id), []);
  const f = chk.finalizar(db, execucao.id, { operador: 'Edson' }, { agora: '2026-10-23T13:40:00.000Z' });
  assert.equal(f.execucao.status, 'finalizado');
  assert.equal(f.execucao.finalizado_em, '2026-10-23T13:40:00.000Z');
  const ev = db.prepare("SELECT * FROM kb_eventos WHERE card_id = ? AND tipo = 'checklist_finalizado'").get(c.id);
  assert.equal(ev.texto, 'Vistoria de entrada finalizada por Edson em 23/10/2026 10:40 — KM 87.450, 13 fotos, 1 avaria');
  assert.equal(chk.finalizar(db, execucao.id, { operador: 'Edson' }).ja_finalizado, true);

  let htmlRecebido = null;
  const renderizar = async (html) => { htmlRecebido = html; return Buffer.from('%PDF-1.7 falso'); };
  const v1 = await pdf.gerarPdfVistoria(db, storage, execucao.id, { operador: 'Sistema', renderizar });
  const v2 = await pdf.gerarPdfVistoria(db, storage, execucao.id, { operador: 'Luan', renderizar });
  assert.deepEqual([v1.versao, v2.versao], [1, 2]);
  assert.match(htmlRecebido, /Risco de 10 cm na porta|Porta DE/);
  assert.match(htmlRecebido, /87\.450/);
  assert.equal((await storage.info(db.prepare('SELECT chave_objeto FROM kb_midias WHERE id = ?').get(v2.midia_id).chave_objeto)).existe, true);

  const evs = await lt.listarEventos(db, storage, c.id);
  const evPdf = evs.filter((e) => e.tipo === 'pdf');
  assert.equal(evPdf.length, 2);
  assert.match(evPdf[0].texto, /PDF "Vistoria de Entrada" gerado \(versão 2\)/);
  // o PDF abre pela rota auditada do app, que assina a URL com o nome certo do arquivo
  assert.equal(evPdf[0].midia.url, `/api/kanban/midias/${v2.midia_id}/abrir`);
  assert.match((await require('../kanban/arquivos').urlDoPdf(db, storage, v2.midia_id)).url, /response-content-disposition=inline%3B%20filename%3D%22vistoria-entrada-v2\.pdf%22/);
  const lista = await chk.listarDoCard(db, storage, c.id);
  assert.equal(lista[0].status, 'finalizado');
  assert.deepEqual(lista[0].pdfs.map((p) => p.versao), [2, 1]);
});

test('PDF antes de finalizar é recusado', async () => {
  const db = banco();
  const c = umCard(db);
  const { execucao } = chk.iniciar(db, c.id, 'entrada', { feitoPor: 'Edson', operador: 'Edson' });
  await assert.rejects(pdf.gerarPdfVistoria(db, storage, execucao.id, { renderizar: async () => Buffer.from('x') }), (e) => e.status === 409);
});

test('HTML do PDF: cabeçalho da Cavallaria, 13 fotos legendadas em ordem e "Nenhuma avaria identificada"', async () => {
  const db = banco();
  const c = umCard(db);
  const { execucao } = chk.iniciar(db, c.id, 'entrada', { feitoPor: 'Edson', operador: 'Edson' });
  await preencher(db, c, execucao.id, { avaria: false });
  chk.finalizar(db, execucao.id, { operador: 'Edson' });
  const d = await pdf.dadosVistoria(db, storage, execucao.id);
  const html = pdf.montarHtmlVistoria(d);
  for (const t of ['Cavallaria Garage', 'Oficina Mecânica Especializada em Veículos Importados', 'Avenida Tupi 268, Bortot - Pato Branco 85504-000',
    '(46) 2604-0612', 'CNPJ: 07.954.296/0001-29', 'VISTORIA DE ENTRADA', 'Nenhuma avaria identificada', 'Assinatura do cliente']) {
    assert.ok(html.includes(t), `faltou "${t}" no PDF`);
  }
  const legendas = [...html.matchAll(/<figcaption><b>(\d+)\.<\/b> ([^<—]+)/g)].map((m) => [Number(m[1]), m[2].trim()]);
  assert.equal(legendas.length, 13);
  assert.deepEqual(legendas[0], [1, 'Painel com motor ligado mostrando odômetro']);
  assert.deepEqual(legendas[12], [13, 'Traseira']);
  assert.equal((html.match(/data-foto src="data:image\/jpeg;base64,/g) || []).length, 13);
  assert.match(html, /☑ Estepe/);
  assert.match(html, /☐ Macaco/);
  assert.match(html, /Nível de combustível: <b>1\/2<\/b>/);
});

test('rota finalizar dispara o PDF em segundo plano; Exportar PDF gera na hora', async () => {
  const db = banco();
  const c = umCard(db);
  const { execucao } = chk.iniciar(db, c.id, 'entrada', { feitoPor: 'Edson', operador: 'Edson' });
  await preencher(db, c, execucao.id);
  const chamadas = [];
  const app = express();
  app.use(express.json());
  app.use('/api/kanban', criarRouter({ db, log: () => {}, criarCliente: () => null, storage,
    gerarPdf: async (id, op) => { chamadas.push([id, op]); return { versao: chamadas.length }; } }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api/kanban`;
  const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) });
  try {
    let r = await post(`/checklists/${execucao.id}/finalizar`, { operador: 'Edson' });
    assert.equal(r.status, 200);
    await new Promise((x) => setTimeout(x, 50));
    assert.deepEqual(chamadas, [[execucao.id, 'Sistema']]);
    r = await post(`/checklists/${execucao.id}/pdf`, { operador: 'Luan' });
    assert.equal((await r.json()).versao, 2);
    const est = await (await fetch(`${base}/estado`)).json();
    assert.equal(est.cards.find((x) => x.id === c.id).vistoria_status, 'finalizado');
    const e = await (await fetch(`${base}/checklists/${execucao.id}`)).json();
    assert.equal(e.midias.length, 13);
    assert.ok(e.midias.every((m) => m.url));
  } finally {
    srv.close();
  }
});

// Com Chrome de verdade (pula se não houver): 13 fotos de ruído 1920×1440 — o pior caso
// para compressão — e o PDF precisa sair abaixo de 8 MB.
const CHROME = [process.env.KANBAN_CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/local/bin/chrome-stable']
  .find((p) => p && fs.existsSync(p));
test('PDF real no Chrome: A4, abaixo de 8 MB mesmo com 13 fotos pesadas', { skip: !CHROME && 'Chrome não encontrado', timeout: 120_000 }, async () => {
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  let fotos;
  try {
    const page = await browser.newPage();
    fotos = await page.evaluate(() => Array.from({ length: 13 }, (_, k) => {
      const c = document.createElement('canvas');
      c.width = 1920; c.height = 1440;
      const g = c.getContext('2d');
      const img = g.createImageData(1920, 1440);
      for (let i = 0; i < img.data.length; i += 4) {
        img.data[i] = (Math.random() * 255) | 0; img.data[i + 1] = (i * k) % 255; img.data[i + 2] = (Math.random() * 255) | 0; img.data[i + 3] = 255;
      }
      g.putImageData(img, 0, 0);
      return c.toDataURL('image/jpeg', 0.92);
    }));
  } finally {
    await browser.close();
  }
  const pesoFotos = fotos.reduce((s, f) => s + f.length * 0.75, 0);
  const d = {
    exec: { feito_por: 'Edson', iniciado_em: '2026-10-23T13:00:00Z', finalizado_em: '2026-10-23T13:20:00Z' },
    card: { os_numero: '7117', placa: 'ABC1D23', marca: 'BMW', modelo: '320i', ano: '2019', chassi: 'WBAGL61002DM57925', cliente_nome: 'Cliente Teste', veiculo_detalhes: {} },
    km: 87450, combustivel: '1/2', itensOpcoes: ['Estepe', 'Tapetes'], itensMarcados: ['Estepe'], logo: '',
    fotos: fotos.map((src, i) => ({ titulo: `Foto ${i + 1}`, src })),
    avarias: [{ ordem: 1, regiao: 'Capô', descricao: 'Amassado', criado_por: 'Edson', criado_em: '2026-10-23T13:10:00Z', fotos: [fotos[0]] }],
  };
  const buf = await pdf.renderizarPdf(pdf.montarHtmlVistoria(d), { chromePath: CHROME });
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pesoFotos > 8 * 1024 * 1024, 'as fotos de entrada precisam ser mais pesadas que o limite');
  assert.ok(buf.length < pdf.LIMITE_BYTES, `PDF com ${(buf.length / 1048576).toFixed(1)} MB`);
});
