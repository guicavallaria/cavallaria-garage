const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const fs = require('fs');
const path = require('path');
const { bancoDeTeste } = require('./helpers/db');
const nov = require('./helpers/novidades');
const { aplicarLeitura } = require('../kanban/sync');
const chk = require('../kanban/checklists');
const lt = require('../kanban/linha-tempo');
const pdf = require('../kanban/pdf');
const links = require('../kanban/links');
const modelos = require('../kanban/modelos');
const { criarStorage } = require('../kanban/storage');
const { iniciarS3Dev } = require('../tools/s3-dev');

let s3;
let storage;
let pasta;
before(async () => {
  pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'kb-rev-'));
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
const porCodigo = (modelo, codigo) => chk.itensDoModelo(modelo).find((i) => i.codigo === codigo);
let seq = 0;

async function midiaDoItem(db, cardId, execId, itemId, { tipo = 'foto', mime = 'image/jpeg', duracao = null } = {}) {
  const corpo = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff]), Buffer.alloc(800, 3)]);
  const p = await lt.pedirEnvio(db, storage, cardId, {
    cliente_id: `rev-${process.pid}-${++seq}`, tipo, mime, tamanho: corpo.length, duracao, operador: 'Iago',
    checklist_execucao_id: execId, checklist_item_id: itemId,
  });
  assert.equal((await fetch(p.upload_url, { method: 'PUT', headers: { 'Content-Type': mime }, body: corpo })).status, 200);
  return lt.confirmarEnvio(db, storage, p.midia_id, { operador: 'Iago' });
}

// Responde todos os itens com "Bom"/"Não"/medidas mínimas, para poder finalizar.
async function responderTudo(db, card, execId, modelo, { ruins = {} } = {}) {
  for (const item of chk.itensDoModelo(modelo)) {
    if (ruins[item.codigo]) { chk.responder(db, execId, item.id, { valor: ruins[item.codigo], operador: 'Iago' }); continue; }
    const v = {};
    for (const c of item.componentes) {
      if (c.tipo === 'estado') v.estado = 'bom';
      if (c.tipo === 'sim_nao') v.sim = false;
      if (c.tipo === 'opcoes') v.opcao = c.opcoes[1];
      if (c.tipo === 'texto') v.texto = 'Pirelli';
      if (c.tipo === 'medida' && c.obrigatorio) v.medidas = { ...(v.medidas || {}), [c.rotulo]: c.rotulo === 'GAP' ? '0,8' : '18' };
      if (c.tipo === 'foto') await midiaDoItem(db, card.id, execId, item.id);
    }
    chk.responder(db, execId, item.id, { valor: v, operador: 'Iago' });
  }
}

test('modelo da revisão básica: 19 itens numerados na ordem da folha + freios, freio de mão e peças', () => {
  const db = banco();
  const m = chk.modeloAtivo(db, 'revisao_basica');
  assert.equal(m.nome, 'Checklist de Revisão Básica');
  assert.deepEqual(m.secoes.map((s) => s.titulo), ['Inspeção pré-elevador', 'Elevador', 'Freios dianteiros', 'Freios traseiros', 'Freio de mão', 'Peças defeituosas']);
  const numerados = [...m.secoes[0].itens, ...m.secoes[1].itens].map((i) => i.texto);
  assert.equal(numerados.length, 19);
  assert.equal(numerados[0], 'Verificação das palhetas do limpador');
  assert.equal(numerados[7], 'Teste dos sulcos dos pneus via ferramenta LAUNCH');
  assert.equal(numerados[18], 'Verificação do filtro de combustível');
  assert.ok(porCodigo(m, 'rb_19').componentes[0].nao_tem);
  assert.ok(porCodigo(m, 'rb_06').componentes[0].descricao_se_reparo);
  assert.deepEqual(m.secoes[2].itens.map((i) => i.texto), ['Trocar pastilhas', 'Trocar discos', 'Pro Cut']);
});

test('modelo da revisão completa: 37 itens na ordem; discos, GAP e pneus são campos numéricos', () => {
  const db = banco();
  const m = chk.modeloAtivo(db, 'revisao_completa');
  const numerados = [...m.secoes[0].itens, ...m.secoes[1].itens];
  assert.equal(numerados.length, 37);
  assert.equal(numerados[0].texto, 'Teste da bateria');
  assert.equal(numerados[36].texto, 'Verificar vazamentos (motor, arrefecimento, transmissão, direção, diferencial)');
  const gap = porCodigo(m, 'rc_25').componentes.find((c) => c.tipo === 'medida');
  assert.deepEqual([gap.rotulo, gap.unidade, gap.obrigatorio], ['GAP', 'mm', true]);
  assert.deepEqual(porCodigo(m, 'rc_17').componentes.filter((c) => c.tipo === 'medida').map((c) => c.rotulo), ['Largura', 'Perfil', 'Aro']);
  assert.deepEqual(m.secoes[2].itens.map((i) => i.texto), ['Medida disco DE', 'Medida disco DD', 'Trocar pastilhas', 'Trocar discos', 'Pro Cut']);
  assert.ok(m.secoes[2].itens[0].componentes.every((c) => c.tipo === 'medida' && c.unidade === 'mm'));
  assert.deepEqual(porCodigo(m, 'rc_23').componentes[0].opcoes, ['Tem vazamento', 'Sem vazamento']);
  assert.ok(porCodigo(m, 'rc_37').componentes[0].texto_se_sim);
});

test('respostas das revisões: reparo exige descrição, "Não tem", texto obrigatório se Sim, medidas com vírgula', () => {
  const db = banco();
  const c = umCard(db);
  const { execucao } = chk.iniciar(db, c.id, 'revisao_completa', { feitoPor: 'Iago', operador: 'Iago' });
  const m = chk.modeloAtivo(db, 'revisao_completa');
  const r = (cod, valor) => chk.responder(db, execucao.id, porCodigo(m, cod).id, { valor, operador: 'Iago' });
  assert.throws(() => r('rc_09', { estado: 'reparo' }), /Descreva o reparo/);
  assert.deepEqual(r('rc_09', { estado: 'reparo', descricao: 'Bucha da bandeja com folga' }).valor, { estado: 'reparo', descricao: 'Bucha da bandeja com folga' });
  assert.throws(() => r('rc_09', { estado: 'troca' }), /Estado inválido/, 'escala "reparo" não tem "troca"');
  assert.deepEqual(r('rc_26', { nao_tem: true }).valor, { nao_tem: true });
  assert.throws(() => r('rc_25', { nao_tem: true }), /Não tem/);
  assert.throws(() => r('rc_25', { estado: 'bom' }), /Informe GAP/);
  assert.deepEqual(r('rc_25', { estado: 'regular', medidas: { GAP: '0,9' } }).valor, { estado: 'regular', medidas: { GAP: 0.9 } });
  assert.throws(() => r('rc_37', { sim: true }), /Detalhe/);
  assert.equal(r('rc_37', { sim: true, texto: 'Vazamento no cárter' }).valor.texto, 'Vazamento no cárter');
  assert.deepEqual(r('rc_17', { estado: 'bom', medidas: { Largura: '225', Perfil: '45', Aro: '18' } }).valor.medidas, { Largura: 225, Perfil: 45, Aro: 18 });
  assert.throws(() => r('rc_29', { estado: 'bom', medidas: { Umidade: '120' } }), /máximo/);
});

test('peças defeituosas: "Necessita troca/reparo" e "Trocar pastilhas" geram linha; voltar para Bom tira; linhas manuais', () => {
  const db = banco();
  const c = umCard(db);
  const { execucao } = chk.iniciar(db, c.id, 'revisao_basica', { feitoPor: 'Iago', operador: 'Iago' });
  const m = chk.modeloAtivo(db, 'revisao_basica');
  chk.responder(db, execucao.id, porCodigo(m, 'rb_06').id, { valor: { estado: 'reparo', descricao: 'Pivô com folga' }, operador: 'Iago' });
  chk.responder(db, execucao.id, porCodigo(m, 'rb_17').id, { valor: { estado: 'troca' }, operador: 'Iago' });
  chk.responder(db, execucao.id, porCodigo(m, 'rb_fd_pastilhas').id, { valor: { sim: true }, operador: 'Iago' });
  chk.responder(db, execucao.id, porCodigo(m, 'rb_fd_procut').id, { valor: { sim: true }, operador: 'Iago' });
  let pecas = chk.listarPecas(db, execucao.id);
  assert.deepEqual(pecas.map((p) => p.descricao), ['Pivô com folga', 'Verificação da correia de acessórios', 'Trocar pastilhas (freios dianteiros)']);
  assert.ok(pecas.every((p) => p.origem === 'automatica'));

  chk.responder(db, execucao.id, porCodigo(m, 'rb_17').id, { valor: { estado: 'regular' }, operador: 'Iago' });
  pecas = chk.listarPecas(db, execucao.id);
  assert.equal(pecas.length, 2);

  const manual = chk.adicionarPeca(db, execucao.id, { descricao: 'Palheta traseira', tempo_troca_horas: '0,3', operador: 'Iago' });
  assert.equal(manual.tempo_troca_horas, 0.3);
  assert.throws(() => chk.removerPeca(db, pecas[0].id, { operador: 'Iago' }), /mude a resposta/);
  chk.removerPeca(db, manual.id, { operador: 'Iago' });
  assert.throws(() => chk.salvarPeca(db, pecas[0].id, { descricao: 'x', tempo_troca_horas: '-1', operador: 'Iago' }), /inválido/);
  chk.salvarPeca(db, pecas[0].id, { descricao: 'Pivô inferior esquerdo', tempo_troca_horas: '1,5', operador: 'Iago' });
  assert.ok(chk.pendencias(db, execucao.id).some((f) => /tempo de troca de "Trocar pastilhas/.test(f)), 'linha sem tempo é pendência');
});

test('revisão completa de ponta a ponta: finaliza, edita depois (versão anterior + linha do tempo) e gera PDF com QR do vídeo', async () => {
  const db = banco();
  const c = umCard(db);
  const { execucao } = chk.iniciar(db, c.id, 'revisao_completa', { feitoPor: 'Iago', operador: 'Iago' });
  const ini = db.prepare("SELECT texto FROM kb_eventos WHERE card_id = ? AND tipo = 'checklist_iniciado'").get(c.id);
  assert.equal(ini.texto, 'Checklist de Revisão Completa iniciado por Iago');
  const m = chk.modeloAtivo(db, 'revisao_completa');
  await responderTudo(db, c, execucao.id, m, { ruins: { rc_13: { estado: 'reparo', descricao: 'Folga na caixa de direção' } } });
  // anexos opcionais presos ao item: vídeo + comentário
  const itemVaz = porCodigo(m, 'rc_13');
  await midiaDoItem(db, c.id, execucao.id, itemVaz.id, { tipo: 'video', mime: 'video/mp4', duracao: 14 });
  chk.comentar(db, execucao.id, itemVaz.id, { texto: 'Barulho ao virar para a esquerda', operador: 'Iago' });

  const faltas = chk.pendencias(db, execucao.id);
  assert.deepEqual(faltas, ['Peças defeituosas: tempo de troca de "Folga na caixa de direção"']);
  const peca = chk.listarPecas(db, execucao.id)[0];
  chk.salvarPeca(db, peca.id, { descricao: peca.descricao, tempo_troca_horas: 2, operador: 'Iago' });
  const f = chk.finalizar(db, execucao.id, { operador: 'Iago' }, { agora: '2026-10-23T16:00:00.000Z' });
  assert.equal(f.execucao.status, 'finalizado');
  const fim = db.prepare("SELECT texto FROM kb_eventos WHERE card_id = ? AND tipo = 'checklist_finalizado'").get(c.id);
  assert.equal(fim.texto, 'Checklist de Revisão Completa finalizado por Iago em 23/10/2026 13:00 — 1 peça defeituosa (2 h de troca)');

  // edição pós-finalização: resposta, comentário e foto — tudo com operador, hora e versão anterior
  const gap = porCodigo(m, 'rc_25');
  chk.responder(db, execucao.id, gap.id, { valor: { estado: 'troca', medidas: { GAP: '1,2' } }, operador: 'Vanilton' }, { agora: '2026-10-23T17:00:00.000Z' });
  const hist = chk.historicoItem(db, execucao.id, gap.id);
  assert.equal(hist.length, 1);
  assert.deepEqual(hist[0].valor_anterior, { estado: 'bom', medidas: { GAP: 0.8 } });
  assert.equal(hist[0].alterado_por, 'Vanilton');
  chk.comentar(db, execucao.id, gap.id, { texto: 'Cliente autorizou troca das velas', operador: 'Vanilton' });
  await midiaDoItem(db, c.id, execucao.id, gap.id);
  const edicoes = db.prepare("SELECT texto, operador_nome FROM kb_eventos WHERE card_id = ? AND tipo = 'checklist_editado' ORDER BY id").all(c.id);
  assert.deepEqual(edicoes.map((e) => e.texto), [
    'Checklist de Revisão Completa: "Verificação das velas de ignição" alterado por Vanilton: Bom · GAP 0,8 mm → Necessita troca · GAP 1,2 mm',
    'Checklist de Revisão Completa: comentário em "Verificação das velas de ignição" por Vanilton: Cliente autorizou troca das velas',
    'Checklist de Revisão Completa: foto adicionada em "Verificação das velas de ignição" por Iago',
  ]);
  // a troca das velas virou peça defeituosa nova (precisa de tempo antes de... já está finalizado: só aparece na lista)
  assert.ok(chk.listarPecas(db, execucao.id).some((p) => p.descricao === 'Verificação das velas de ignição'));

  // PDF: cabeçalho, título, mecânico, estados coloridos, anexos sob o item e QR do vídeo com link de 7 dias
  const htmls = [];
  const v1 = await pdf.gerarPdfChecklist(db, storage, execucao.id, { renderizar: async (h) => { htmls.push(h); return Buffer.from('%PDF-falso'); } });
  assert.equal(v1.versao, 1);
  assert.deepEqual(v1.vias.map((v) => v.via), ['orcamento', 'cliente'], 'revisão gera as duas vias na mesma versão');
  const [html, htmlCliente] = htmls;
  for (const t of ['CHECKLIST DE REVISÃO COMPLETA', 'Mecânico responsável: <b>Iago</b>', 'INFORMAÇÕES DO CLIENTE', 'CNPJ: 07.954.296/0001-29',
    'PEÇAS DEFEITUOSAS — DESCRIÇÃO — TEMPO DE TROCA EM HORAS', 'Folga na caixa de direção', 'Barulho ao virar para a esquerda', 'Via orçamento — uso interno']) {
    assert.ok(html.includes(t), `faltou "${t}" na via orçamento`);
  }
  // via cliente: sem peças a substituir e sem tempos de reparo em horas
  assert.ok(htmlCliente.includes('Via do cliente'));
  for (const t of ['PEÇAS DEFEITUOSAS', 'Tempo de troca', 'class="pecas"', ' h</td>', 'Adicionada pelo mecânico']) {
    assert.ok(!htmlCliente.includes(t), `a via cliente não pode ter "${t}"`);
  }
  assert.ok(htmlCliente.includes('Barulho ao virar para a esquerda'), 'a via cliente mantém o diagnóstico dos itens');
  const vias = db.prepare('SELECT via FROM kb_pdfs WHERE execucao_id = ? ORDER BY id').all(execucao.id).map((r) => r.via);
  assert.deepEqual(vias, ['orcamento', 'cliente']);
  assert.match(html, /<span class="tag reparo">Necessita reparo<\/span>/);
  assert.match(html, /<span class="tag bom">Bom<\/span>/);
  assert.match(html, /<span class="tag troca">Necessita troca<\/span>/);
  assert.match(html, /GAP: <b>1,2<\/b> mm/);
  assert.match(html, /<img class="qr" src="data:image\/png;base64,/);
  const urlVideo = html.match(/href="(http:\/\/localhost:\d+\/m\/[A-Za-z0-9_-]+)"/)[1];
  const token = urlVideo.split('/m/')[1];
  const r = links.resolverLink(db, token);
  assert.equal(r.midia.tipo, 'video');
  assert.ok(Date.parse(r.link.expira_em) - Date.now() > 6.9 * 86_400_000);
  // ordem cronológica sob o item: vídeo antes do comentário (enviados nessa ordem)
  const blocoItem = html.slice(html.indexOf('Teste de folga na caixa de direção'));
  assert.ok(blocoItem.indexOf('🎥 Vídeo') < blocoItem.indexOf('Barulho ao virar'));

  const evPdf = db.prepare("SELECT texto FROM kb_eventos WHERE card_id = ? AND tipo = 'pdf' ORDER BY id").all(c.id).map((e) => e.texto);
  assert.match(evPdf[0], /^PDF "Checklist de Revisão Completa" — via orçamento gerado/);
  assert.match(evPdf[1], /^PDF "Checklist de Revisão Completa" — via cliente gerado/);
  const lista = await chk.listarDoCard(db, storage, c.id);
  assert.deepEqual(lista[0].pdfs.map((p) => p.via), ['cliente', 'orcamento'], 'na tela, a via do cliente vem primeiro');
});

test('link para o cliente: só a via cliente (a via orçamento é interna)', async () => {
  const db = banco();
  const c = umCard(db);
  const { execucao } = chk.iniciar(db, c.id, 'revisao_basica', { feitoPor: 'Iago', operador: 'Iago' });
  await responderTudo(db, c, execucao.id, chk.modeloAtivo(db, 'revisao_basica'));
  chk.finalizar(db, execucao.id, { operador: 'Iago' });
  const r = await pdf.gerarPdfChecklist(db, storage, execucao.id, { renderizar: async () => Buffer.from('%PDF-falso') });
  const orc = r.vias.find((v) => v.via === 'orcamento');
  const cli = r.vias.find((v) => v.via === 'cliente');
  assert.equal(r.pdf_id, cli.pdf_id, 'o PDF "principal" é a via do cliente');

  const express = require('express');
  const { criarRouter } = require('../kanban/routes');
  const app = express();
  app.use(express.json());
  app.use('/api/kanban', criarRouter({ db, log: () => {}, criarCliente: () => null, storage }));
  const srv = app.listen(0);
  const base = `http://127.0.0.1:${srv.address().port}/api/kanban`;
  const post = (p) => fetch(base + p, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operador: 'Luan' }) });
  try {
    const recusa = await post(`/pdfs/${orc.pdf_id}/link`);
    assert.equal(recusa.status, 400);
    assert.match((await recusa.json()).erro, /uso interno/);
    const ok = await post(`/pdfs/${cli.pdf_id}/link`);
    assert.equal(ok.status, 200);
    assert.match((await ok.json()).url, /\/m\//);
  } finally {
    srv.close();
  }
});

test('revisões: pode haver várias por card; retoma a que está em andamento', () => {
  const db = banco();
  const c = umCard(db);
  const a = chk.iniciar(db, c.id, 'revisao_basica', { feitoPor: 'Iago', operador: 'Iago' });
  const b = chk.iniciar(db, c.id, 'revisao_basica', { feitoPor: 'Edson', operador: 'Edson' });
  assert.equal(b.execucao.id, a.execucao.id);
  db.prepare("UPDATE kb_checklist_execucoes SET status = 'finalizado' WHERE id = ?").run(a.execucao.id);
  const novo = chk.iniciar(db, c.id, 'revisao_basica', { feitoPor: 'Edson', operador: 'Edson' });
  assert.notEqual(novo.execucao.id, a.execucao.id);
  assert.equal(novo.retomada, false);
});

test('links públicos: expiram, podem ser revogados e não aceitam token inválido', () => {
  const db = banco();
  const c = umCard(db);
  const m = db.prepare(`INSERT INTO kb_midias (cliente_id, chave_objeto, tipo, mime, card_id, status, autor_nome, criado_em)
    VALUES ('lk-1', 'cards/x/v.mp4', 'video', 'video/mp4', ?, 'enviado', 'Iago', 'x')`).run(c.id).lastInsertRowid;
  const l = links.criarLink(db, m, { finalidade: 'pdf_cliente', operador: 'Luan', agora: new Date('2026-10-01T00:00:00Z') });
  assert.match(l.url, /\/m\/[A-Za-z0-9_-]{32}$/);
  assert.match(links.resolverLink(db, l.token, { agora: new Date('2026-10-07T23:00:00Z') }).midia.chave_objeto, /v\.mp4/);
  assert.match(links.resolverLink(db, l.token, { agora: new Date('2026-10-08T00:00:01Z') }).erro, /expirou/);
  const l2 = links.criarLink(db, m, { finalidade: 'pdf_cliente', operador: 'Luan' });
  const id = db.prepare('SELECT id FROM kb_links WHERE token = ?').get(l2.token).id;
  links.revogarLink(db, id, { operador: 'Gerência' });
  assert.match(links.resolverLink(db, l2.token).erro, /cancelado/);
  assert.match(links.resolverLink(db, '../../etc').erro, /inválido/);
});

test('administração de modelos: salvar cria versão nova ativa; checklist antigo continua na versão dele', () => {
  const db = banco();
  const c = umCard(db);
  const antigo = chk.iniciar(db, c.id, 'revisao_basica', { feitoPor: 'Iago', operador: 'Iago' }).execucao;
  const m = chk.modeloAtivo(db, 'revisao_basica');
  const dados = {
    nome: m.nome,
    secoes: m.secoes.map((s) => ({ titulo: s.titulo, tipo: s.tipo, itens: s.itens.map((i) => ({ codigo: i.codigo, texto: i.texto, instrucao: i.instrucao, componentes: JSON.stringify(i.componentes) })) })),
    operador: 'Guilherme',
  };
  dados.secoes[0].itens.push({ codigo: '', texto: 'Verificação do nível do óleo do motor', componentes: '[{"tipo":"estado","escala":"troca","obrigatorio":true}]' });
  const novo = modelos.salvarNovaVersao(db, 'revisao_basica', dados);
  assert.equal(novo.versao, 2);
  assert.equal(chk.modeloAtivo(db, 'revisao_basica').id, novo.id);
  assert.equal(novo.secoes[0].itens.length, 6);
  assert.equal(chk.carregarModelo(db, antigo.modelo_id).secoes[0].itens.length, 5, 'checklist já iniciado não muda');
  const lista = modelos.listar(db).find((x) => x.codigo === 'revisao_basica');
  assert.deepEqual(lista.versoes.map((v) => [v.versao, v.ativo, v.usos]), [[2, true, 0], [1, false, 1]]);

  assert.throws(() => modelos.salvarNovaVersao(db, 'revisao_basica', { ...dados, secoes: [{ titulo: 'X', itens: [{ texto: 'a', componentes: '[{"tipo":"cor"}]' }] }] }), /desconhecido/);
  assert.throws(() => modelos.salvarNovaVersao(db, 'revisao_basica', { ...dados, secoes: [{ titulo: 'X', itens: [{ texto: 'a', componentes: '{quebrado' }] }] }), /JSON/);
  assert.throws(() => modelos.salvarNovaVersao(db, 'revisao_basica', { ...dados, secoes: [{ titulo: 'X', itens: [{ texto: 'a', componentes: '[{"tipo":"estado","cor":1}]' }] }] }), /"cor" não existe/);
  modelos.ativarVersao(db, lista.versoes[1].id, { operador: 'Guilherme' });
  assert.equal(chk.modeloAtivo(db, 'revisao_basica').versao, 1);
});

const CHROME = [process.env.KANBAN_CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', '/usr/local/bin/chrome-stable']
  .find((p) => p && fs.existsSync(p));
test('PDF real da revisão completa no Chrome (A4, abaixo de 10 MB)', { skip: !CHROME && 'Chrome não encontrado', timeout: 120_000 }, async () => {
  const db = banco();
  const c = umCard(db);
  const { execucao } = chk.iniciar(db, c.id, 'revisao_completa', { feitoPor: 'Iago', operador: 'Iago' });
  const m = chk.modeloAtivo(db, 'revisao_completa');
  await responderTudo(db, c, execucao.id, m);
  chk.finalizar(db, execucao.id, { operador: 'Iago' });
  const d = await pdf.dadosRevisao(db, storage, execucao.id);
  const buf = await pdf.renderizarPdf(pdf.montarHtmlRevisao(d), { chromePath: CHROME });
  assert.equal(buf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(buf.length < pdf.LIMITE_REVISAO_BYTES);
});
