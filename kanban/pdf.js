// PDFs gerados no servidor: "Vistoria de Entrada" (Etapa 4) e "Checklist de Revisão
// Básica/Completa" (Etapa 5).
//
// O HTML é montado aqui e impresso pelo Chrome headless (puppeteer-core; no Railway o
// Chrome for Testing já está no container, em CHROME_PATH). As fotos saem do bucket, entram
// no HTML e são recomprimidas pelo próprio Chrome (canvas) antes de imprimir. Vídeos e áudios
// entram como quadro + QR code para um link com validade (kanban/links.js).
// O PDF vai para o bucket como nova versão e entra na linha do tempo.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');
const EMPRESA = require('./empresa');
const { formatarBR } = require('./datas');
const { ErroAcao } = require('./acoes');
const chk = require('./checklists');
const links = require('./links');

const MB = 1024 * 1024;
const LIMITE_BYTES = 8 * MB;          // vistoria: WhatsApp
const LIMITE_REVISAO_BYTES = 10 * MB; // revisão: prompt, seção 10
const TENTATIVAS = [
  { lado: 1100, qualidade: 0.72 },
  { lado: 850, qualidade: 0.6 },
  { lado: 650, qualidade: 0.5 },
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (s, p = null) => { try { return s ? JSON.parse(s) : p; } catch (_) { return p; } };
const num = (n) => Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 2 });

let logoCache = null;
function logoDataUrl() {
  if (logoCache === null) {
    try {
      const b = fs.readFileSync(path.join(__dirname, '..', EMPRESA.logo));
      logoCache = `data:image/webp;base64,${b.toString('base64')}`;
    } catch (_) { logoCache = ''; }
  }
  return logoCache;
}

const CSS = `
  @page { size: A4; margin: 12mm 12mm 16mm; }
  * { box-sizing: border-box; }
  body { font-family: Arial, Helvetica, sans-serif; color: #1f2330; font-size: 10.5pt; margin: 0; }
  .cab { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid #1f2330; padding-bottom: 8px; }
  .cab img { height: 62px; }
  .cab .emp { margin-left: auto; text-align: right; font-size: 9pt; line-height: 1.35; padding-right: 1.5mm; }
  .cab .emp strong { font-size: 13pt; }
  h1 { font-size: 15pt; margin: 12px 0 2px; letter-spacing: .5px; }
  .sub { color: #5b6170; font-size: 9.5pt; margin: 0 0 10px; }
  h2 { font-size: 10.5pt; background: #1f2330; color: #fff; padding: 4px 8px; margin: 14px 0 6px; letter-spacing: .4px; break-after: avoid; page-break-after: avoid; }
  table.info { width: 100%; border-collapse: collapse; font-size: 9pt; }
  table.info td { border: 1px solid #c9ced8; padding: 3px 6px; vertical-align: top; }
  table.info .r { display: block; color: #5b6170; font-size: 7.5pt; text-transform: uppercase; }
  .grade { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  figure { margin: 0; break-inside: avoid; page-break-inside: avoid; }
  figure .foto { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border: 1px solid #c9ced8; display: block; background: #eee; }
  figcaption { font-size: 8.5pt; margin-top: 2px; }
  figcaption b { display: inline-block; min-width: 14px; }
  .avaria { display: grid; grid-template-columns: 62mm 1fr; gap: 10px; margin-bottom: 8px; break-inside: avoid; page-break-inside: avoid; }
  .avaria .fotos { display: grid; gap: 4px; }
  .nenhuma { padding: 8px; border: 1px dashed #9aa1ad; text-align: center; color: #3c4250; }
  .itens span { display: inline-block; margin: 2px 10px 2px 0; }
  .fim { break-inside: avoid; page-break-inside: avoid; margin-top: 14px; font-size: 9.5pt; }
  .ass { display: grid; grid-template-columns: 1fr 1fr; gap: 30px; margin-top: 34px; }
  .ass div { border-top: 1px solid #1f2330; padding-top: 4px; text-align: center; font-size: 9pt; }
  /* revisão */
  .item { border-bottom: 1px solid #e3e6eb; padding: 5px 2px; break-inside: avoid; page-break-inside: avoid; }
  .item .lin { display: flex; gap: 8px; align-items: baseline; }
  .item .n { color: #5b6170; min-width: 18px; }
  .item .t { flex: 1; }
  .item .r { text-align: right; max-width: 55%; }
  .tag { display: inline-block; padding: 1px 7px; border-radius: 3px; font-size: 8.5pt; font-weight: bold; }
  .tag.bom { background: #e3f3e6; color: #1b6e2c; }
  .tag.regular { background: #fff3c4; color: #7a5a00; }
  .tag.troca, .tag.reparo { background: #fde3e1; color: #a32018; }
  .tag.nt { background: #eceef2; color: #4b5160; }
  .med { font-size: 9pt; color: #3c4250; margin-left: 4px; }
  .desc { font-size: 9pt; color: #a32018; margin: 2px 0 0 26px; }
  .anexos { margin: 4px 0 0 26px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; }
  .anexo { font-size: 8pt; color: #3c4250; }
  .anexo img.foto { width: 100%; aspect-ratio: 4 / 3; object-fit: cover; border: 1px solid #c9ced8; display: block; }
  .anexo.video { display: grid; grid-template-columns: 42mm 1fr 22mm; gap: 6px; grid-column: 1 / -1; align-items: start; }
  .anexo.video img.foto { width: 42mm; }
  .anexo.video img.qr { width: 22mm; height: 22mm; }
  .anexo a { color: #185FA5; word-break: break-all; }
  .com { grid-column: 1 / -1; font-size: 8.5pt; background: #f4f5f8; padding: 3px 6px; border-radius: 3px; }
  table.pecas { width: 100%; border-collapse: collapse; font-size: 9.5pt; }
  table.pecas th, table.pecas td { border: 1px solid #c9ced8; padding: 4px 6px; text-align: left; }
  table.pecas th { background: #f1f2f5; }
  table.pecas td.h { text-align: right; white-space: nowrap; }
`;

// Recomprime as fotos no próprio Chrome antes de imprimir.
const SCRIPT = (lado, qualidade) => `
  (async () => {
    const imgs = [...document.querySelectorAll('img[data-foto]')];
    await Promise.all(imgs.map(async (img) => {
      try {
        if (!img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
        if (!img.naturalWidth) return;
        const k = Math.min(1, ${lado} / Math.max(img.naturalWidth, img.naturalHeight));
        const c = document.createElement('canvas');
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
        img.src = c.toDataURL('image/jpeg', ${qualidade});
        await img.decode();
      } catch (e) { /* mantém a original */ }
    }));
    document.body.dataset.pronto = '1';
  })();`;

function linhaInfo(celulas) {
  return `<tr>${celulas.map(([r, v, span]) => `<td${span ? ` colspan="${span}"` : ''}><span class="r">${esc(r)}</span>${esc(v === null || v === undefined || v === '' ? '—' : v)}</td>`).join('')}</tr>`;
}

function cabecalho(d) {
  return `<div class="cab">
    ${d.logo ? `<img src="${d.logo}" alt="Cavallaria Garage">` : ''}
    <div class="emp"><strong>${esc(EMPRESA.nome)}</strong><br>${esc(EMPRESA.slogan)}<br>${esc(EMPRESA.endereco)}<br>
      ${esc(EMPRESA.telefone)} · ${esc(EMPRESA.email)}<br>CNPJ: ${esc(EMPRESA.cnpj)}</div>
  </div>`;
}

// ---------- vistoria de entrada ----------
function montarHtmlVistoria(d, { lado = 1100, qualidade = 0.72 } = {}) {
  const det = d.card.veiculo_detalhes || {};
  const fotos = d.fotos.map((f, i) => `
    <figure>
      ${f.src ? `<img class="foto" data-foto src="${f.src}" alt="">` : '<div class="foto"></div>'}
      <figcaption><b>${i + 1}.</b> ${esc(f.titulo)}${f.extra ? ` — ${esc(f.extra)}` : ''}</figcaption>
    </figure>`).join('');
  const avarias = d.avarias.length
    ? d.avarias.map((a) => `
      <div class="avaria">
        <div class="fotos">${a.fotos.map((src) => `<img class="foto" data-foto src="${src}" alt="" style="width:100%;border:1px solid #c9ced8">`).join('') || '<div class="nenhuma">sem foto</div>'}</div>
        <div><b>Avaria ${a.ordem} — ${esc(a.regiao)}</b><br>${esc(a.descricao)}<br><span class="sub">Registrada por ${esc(a.criado_por)} em ${esc(formatarBR(a.criado_em))}</span></div>
      </div>`).join('')
    : '<div class="nenhuma">Nenhuma avaria identificada</div>';
  const itens = d.itensOpcoes.map((o) => `<span>${d.itensMarcados.includes(o) ? '☑' : '☐'} ${esc(o)}</span>`).join('');

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Vistoria de Entrada — OS ${esc(d.card.os_numero)}</title>
<style>${CSS}</style></head><body>
  ${cabecalho(d)}
  <h1>VISTORIA DE ENTRADA</h1>
  <p class="sub">OS nº ${esc(d.card.os_numero)} · Vistoria feita por ${esc(d.exec.feito_por)} · início ${esc(formatarBR(d.exec.iniciado_em))}${d.exec.finalizado_em ? ` · fim ${esc(formatarBR(d.exec.finalizado_em))}` : ''}</p>

  <h2>INFORMAÇÕES DO CLIENTE E DO VEÍCULO</h2>
  <table class="info">
    ${linhaInfo([['Nome do cliente', d.card.cliente_nome, 3], ['Telefone', d.card.cliente_telefone]])}
    ${linhaInfo([['Placa', d.card.placa], ['Fabricante', d.card.marca], ['Modelo', d.card.modelo], ['Ano', d.card.ano]])}
    ${linhaInfo([['Chassi', d.card.chassi, 2], ['Motor', det.motor], ['Cor', det.cor]])}
    ${linhaInfo([['KM na entrada', d.km !== null ? d.km.toLocaleString('pt-BR') : ''], ['Tanque', d.combustivel], ['Data de entrada', d.card.os_entrada_em ? formatarBR(d.card.os_entrada_em) : ''], ['Nº Ordem de serviço', d.card.os_numero]])}
  </table>

  <h2>FOTOS DO VEÍCULO</h2>
  <div class="grade">${fotos}</div>

  <h2>AVARIAS IDENTIFICADAS</h2>
  ${avarias}

  <h2>COMBUSTÍVEL E ITENS PRESENTES</h2>
  <p>Nível de combustível: <b>${esc(d.combustivel || '—')}</b></p>
  <p class="itens">${itens}</p>

  <div class="fim">
    <p>Este documento comprova o estado em que o veículo acima foi recebido pela ${esc(EMPRESA.nome)} na data e hora indicadas,
    conforme as fotos e avarias registradas no momento da entrada.</p>
    <div class="ass">
      <div>Assinatura do cliente<br>${esc(d.card.cliente_nome || '')}</div>
      <div>Responsável pela vistoria<br>${esc(d.exec.feito_por)}</div>
    </div>
  </div>
  <script>${SCRIPT(lado, qualidade)}</script>
</body></html>`;
}

// ---------- revisão básica / completa ----------
function respostaHtml(item, v) {
  // Item que é só foto (ex.: tela do Launch): a resposta é a própria foto, logo abaixo.
  if (item.componentes.every((c) => c.tipo === 'foto')) return '<b>Foto registrada</b>';
  if (!v || !Object.keys(v).length) return '<span class="tag nt">sem resposta</span>';
  if (v.nao_tem) return '<span class="tag nt">Não tem</span>';
  const partes = [];
  for (const c of item.componentes) {
    if (c.tipo === 'estado' && v.estado) partes.push(`<span class="tag ${v.estado}">${esc((chk.ESTADOS[c.escala] || chk.ESTADOS.troca)[v.estado])}</span>`);
    if (c.tipo === 'sim_nao' && typeof v.sim === 'boolean') partes.push(`<b>${esc((c.rotulos || ['Sim', 'Não'])[v.sim ? 0 : 1])}</b>`);
    if (c.tipo === 'opcoes' && v.opcao) partes.push(`<b>${esc(v.opcao)}</b>`);
    if (c.tipo === 'texto' && v.texto) partes.push(`<b>${esc(v.texto)}</b>`);
    if (c.tipo === 'medida' && v.medidas && v.medidas[c.rotulo] !== undefined) {
      partes.push(`<span class="med">${esc(c.rotulo)}: <b>${esc(num(v.medidas[c.rotulo]))}</b> ${esc(c.unidade || '')}</span>`);
    }
  }
  return partes.join(' ');
}

function anexoHtml(a) {
  if (a.tipo === 'comentario') return `<div class="com">💬 ${esc(formatarBR(a.quando))} · ${esc(a.autor)}: ${esc(a.texto)}</div>`;
  if (a.tipo === 'foto') return `<div class="anexo">${a.src ? `<img class="foto" data-foto src="${a.src}" alt="">` : ''}${esc(formatarBR(a.quando))} · ${esc(a.autor)}</div>`;
  // vídeo / áudio: quadro (se houver) + QR code + link com validade
  return `<div class="anexo video">
    ${a.src ? `<img class="foto" data-foto src="${a.src}" alt="">` : '<span></span>'}
    <div>${a.tipo === 'video' ? '🎥 Vídeo' : '🎙️ Áudio'}${a.duracao ? ` de ${Math.round(a.duracao)} s` : ''} · ${esc(formatarBR(a.quando))} · ${esc(a.autor)}<br>
      Aponte a câmera do celular para o QR code ou acesse:<br><a href="${esc(a.url)}">${esc(a.url)}</a><br>
      <span class="sub">link válido até ${esc(formatarBR(a.expira))}</span></div>
    ${a.qr ? `<img class="qr" src="${a.qr}" alt="QR code">` : '<span></span>'}
  </div>`;
}

// `via`: "orcamento" (uso interno, com peças e tempos de troca) ou "cliente" (sem peças e sem horas).
function montarHtmlRevisao(d, { lado = 1100, qualidade = 0.72, via = 'orcamento' } = {}) {
  const cliente = via === 'cliente';
  const det = d.card.veiculo_detalhes || {};
  let n = 0;
  const secoes = d.modelo.secoes.filter((s) => s.tipo !== 'pecas_defeituosas').map((s) => {
    const numerar = !/^Freio/i.test(s.titulo);
    const itens = s.itens.map((item) => {
      if (numerar) n += 1;
      const v = d.respostas.get(item.id) || {};
      const anexos = d.anexos.get(item.id) || [];
      return `<div class="item">
        <div class="lin"><span class="n">${numerar ? `${n}.` : '•'}</span><span class="t">${esc(item.texto)}</span><span class="r">${respostaHtml(item, v)}</span></div>
        ${v.descricao ? `<div class="desc">Reparo/troca: ${esc(v.descricao)}</div>` : ''}
        ${v.texto && item.componentes.some((c) => c.tipo === 'sim_nao' && c.texto_se_sim) ? `<div class="desc">${esc(v.texto)}</div>` : ''}
        ${anexos.length ? `<div class="anexos">${anexos.map(anexoHtml).join('')}</div>` : ''}
      </div>`;
    }).join('');
    return `<h2>${esc(s.titulo.toUpperCase())}</h2>${itens}`;
  }).join('');

  const totalHoras = d.pecas.reduce((s, p) => s + (p.tempo_troca_horas || 0), 0);
  const pecas = cliente ? '' : d.pecas.length
    ? `<table class="pecas"><thead><tr><th>Peça / serviço</th><th>Item do checklist</th><th>Tempo de troca</th></tr></thead><tbody>
        ${d.pecas.map((p) => `<tr><td>${esc(p.descricao || '—')}</td><td>${esc(p.item_texto || 'Adicionada pelo mecânico')}</td><td class="h">${p.tempo_troca_horas !== null ? `${esc(num(p.tempo_troca_horas))} h` : '—'}</td></tr>`).join('')}
        <tr><td colspan="2"><b>Total</b></td><td class="h"><b>${esc(num(totalHoras))} h</b></td></tr></tbody></table>`
    : '<div class="nenhuma">Nenhuma peça defeituosa</div>';

  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>${esc(d.modelo.nome)} — OS ${esc(d.card.os_numero)}</title>
<style>${CSS}</style></head><body>
  ${cabecalho(d)}
  <h2>INFORMAÇÕES DO CLIENTE</h2>
  <table class="info">
    ${linhaInfo([['Nome do cliente', d.card.cliente_nome, 4], ['Telefones', d.card.cliente_telefone, 3]])}
    ${linhaInfo([['Placa', d.card.placa], ['Fabricante', d.card.marca], ['Modelo', d.card.modelo], ['Ano', d.card.ano], ['Motor', det.motor], ['Portas', det.portas], ['Combustível', det.combustivel]])}
    ${linhaInfo([['Tanque', d.tanque], ['KM', d.km !== null ? d.km.toLocaleString('pt-BR') : ''], ['Direção', det.direcao], ['Ar', det.ar], ['Cor', det.cor], ['Data de entrada', d.card.os_entrada_em ? formatarBR(d.card.os_entrada_em) : ''], ['Nº Ordem de serviço', d.card.os_numero]])}
  </table>
  <h1>${esc(d.modelo.nome.toUpperCase())}</h1>
  <p class="sub">Mecânico responsável: <b>${esc(d.exec.feito_por)}</b> · início ${esc(formatarBR(d.exec.iniciado_em))}${d.exec.finalizado_em ? ` · fim ${esc(formatarBR(d.exec.finalizado_em))}` : ''}
    · <b>${cliente ? 'Via do cliente' : 'Via orçamento — uso interno'}</b></p>
  ${secoes}
  ${cliente ? '' : `<h2>PEÇAS DEFEITUOSAS — DESCRIÇÃO — TEMPO DE TROCA EM HORAS</h2>
  ${pecas}`}
  <script>${SCRIPT(lado, qualidade)}</script>
</body></html>`;
}

function rodape(titulo, d, geradoEm) {
  return `<div style="width:100%;font-size:7.5pt;color:#5b6170;padding:0 12mm;display:flex;justify-content:space-between;font-family:Arial,sans-serif">
    <span>${esc(titulo)} · OS ${esc(d.card.os_numero)} · gerado em ${esc(formatarBR(geradoEm))}</span>
    <span>Página <span class="pageNumber"></span> de <span class="totalPages"></span></span></div>`;
}

function caminhoChrome(env = process.env) {
  return env.KANBAN_CHROME_PATH || env.CHROME_PATH || null;
}

// Imprime o HTML em A4 com o Chrome headless.
async function renderizarPdf(html, { rodapeHtml, chromePath = caminhoChrome() } = {}) {
  if (!chromePath) throw new ErroAcao(503, 'Chrome não configurado no servidor (KANBAN_CHROME_PATH ou CHROME_PATH)');
  const puppeteer = require('puppeteer-core');
  const browser = await puppeteer.launch({
    executablePath: chromePath,
    headless: true,
    // Mesmo conjunto que funciona no Railway para o WhatsApp (sem --single-process/--no-zygote: dão SIGTRAP).
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--no-first-run', '--disable-extensions'],
  });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load', timeout: 60_000 });
    await page.waitForFunction(() => document.body.dataset.pronto === '1', { timeout: 60_000 });
    return Buffer.from(await page.pdf({
      format: 'A4',
      printBackground: true,
      preferCSSPageSize: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: rodapeHtml || '<span></span>',
    }));
  } finally {
    await browser.close();
  }
}

// ---------- dados ----------
async function baixar(storage, chave, mime) {
  try {
    const b = await storage.ler(chave);
    return `data:${mime};base64,${b.toString('base64')}`;
  } catch (_) { return null; }
}

function basico(db, execId) {
  const exec = db.prepare('SELECT * FROM kb_checklist_execucoes WHERE id = ?').get(Number(execId));
  if (!exec) throw new ErroAcao(404, 'Checklist não encontrado');
  const card = db.prepare('SELECT * FROM kb_cards WHERE id = ?').get(exec.card_id);
  card.veiculo_detalhes = json(card.veiculo_detalhes, {});
  const modelo = chk.carregarModelo(db, exec.modelo_id);
  const respostas = new Map(db.prepare('SELECT item_id, valor FROM kb_checklist_respostas WHERE execucao_id = ?').all(exec.id)
    .map((r) => [r.item_id, json(r.valor, {})]));
  return { exec, card, modelo, itens: chk.itensDoModelo(modelo), respostas };
}

// KM e combustível da vistoria de entrada (se existir) para o cabeçalho das revisões.
function dadosDaEntrada(db, cardId) {
  const e = db.prepare(`SELECT x.id FROM kb_checklist_execucoes x JOIN kb_checklist_modelos m ON m.id = x.modelo_id
      WHERE x.card_id = ? AND m.codigo = 'entrada' ORDER BY x.id DESC LIMIT 1`).get(cardId);
  if (!e) return { km: null, tanque: '' };
  const b = basico(db, e.id);
  let km = null;
  let tanque = '';
  for (const it of b.itens) {
    const v = b.respostas.get(it.id) || {};
    if (v.medidas && v.medidas.KM !== undefined) km = v.medidas.KM;
    if (it.codigo === 'e_combustivel' && v.opcao) tanque = v.opcao;
  }
  return { km, tanque };
}

async function dadosVistoria(db, storage, execId) {
  const { exec, card, modelo, itens, respostas } = basico(db, execId);
  const midias = chk.midiasDaExecucao(db, exec.id).filter((m) => m.tipo === 'foto');
  let km = null;
  const fotos = [];
  for (const item of itens.filter((i) => i.secao.tipo === 'fotos_obrigatorias')) {
    const r = respostas.get(item.id) || {};
    if (r.medidas && r.medidas.KM !== undefined) km = r.medidas.KM;
    const daItem = midias.filter((m) => m.checklist_item_id === item.id && !m.avaria_id);
    const ultima = daItem[daItem.length - 1]; // foto refeita: vale a mais recente
    fotos.push({
      titulo: item.texto,
      extra: r.medidas && r.medidas.KM !== undefined ? `KM ${Number(r.medidas.KM).toLocaleString('pt-BR')}` : '',
      src: ultima ? await baixar(storage, ultima.chave_objeto, ultima.mime) : null,
    });
  }
  const avarias = [];
  for (const a of db.prepare('SELECT * FROM kb_checklist_avarias WHERE execucao_id = ? AND removido_em IS NULL ORDER BY ordem').all(exec.id)) {
    const srcs = [];
    for (const m of midias.filter((x) => x.avaria_id === a.id)) srcs.push(await baixar(storage, m.chave_objeto, m.mime));
    avarias.push({ ...a, fotos: srcs.filter(Boolean) });
  }
  const itemComb = itens.find((i) => i.codigo === 'e_combustivel');
  const itemPres = itens.find((i) => i.codigo === 'e_itens_presentes');
  const compPres = itemPres ? itemPres.componentes.find((c) => c.tipo === 'multipla') : null;
  return {
    exec, card, modelo, km, fotos, avarias,
    combustivel: itemComb ? (respostas.get(itemComb.id) || {}).opcao || '' : '',
    itensOpcoes: compPres ? compPres.opcoes : [],
    itensMarcados: itemPres ? (respostas.get(itemPres.id) || {}).marcados || [] : [],
    logo: logoDataUrl(),
  };
}

// Fotos, vídeos/áudios (quadro + QR) e comentários de cada item, em ordem cronológica.
async function dadosRevisao(db, storage, execId, { operador = 'Sistema', agora = new Date() } = {}) {
  const b = basico(db, execId);
  const anexos = new Map();
  const add = (itemId, a) => { if (!anexos.has(itemId)) anexos.set(itemId, []); anexos.get(itemId).push(a); };
  for (const m of chk.midiasDaExecucao(db, b.exec.id)) {
    if (!m.checklist_item_id || m.tipo === 'pdf') continue;
    if (m.tipo === 'foto') {
      add(m.checklist_item_id, { tipo: 'foto', quando: m.enviado_em, autor: m.autor_nome, src: await baixar(storage, m.chave_objeto, m.mime) });
    } else {
      const l = links.criarLink(db, m.id, { finalidade: 'video_pdf', operador, agora });
      add(m.checklist_item_id, {
        tipo: m.tipo, quando: m.enviado_em, autor: m.autor_nome, duracao: m.duracao_s, url: l.url, expira: l.expira_em,
        qr: await QRCode.toDataURL(l.url, { margin: 1, width: 220 }),
        src: m.chave_miniatura ? await baixar(storage, m.chave_miniatura, 'image/jpeg') : null,
      });
    }
  }
  for (const c of db.prepare('SELECT * FROM kb_checklist_comentarios WHERE execucao_id = ? AND removido_em IS NULL').all(b.exec.id)) {
    add(c.item_id, { tipo: 'comentario', quando: c.criado_em, autor: c.autor_nome, texto: c.texto });
  }
  for (const lista of anexos.values()) lista.sort((x, y) => String(x.quando).localeCompare(String(y.quando)));
  const entrada = dadosDaEntrada(db, b.card.id);
  return { ...b, anexos, pecas: chk.listarPecas(db, b.exec.id), km: entrada.km, tanque: entrada.tanque, logo: logoDataUrl() };
}

// ---------- gerar e guardar ----------
const TIPOS_PDF = {
  entrada: { tipo: 'vistoria_entrada', titulo: 'Vistoria de Entrada', limite: LIMITE_BYTES, arquivo: 'vistoria-entrada' },
  revisao_basica: { tipo: 'revisao_basica', titulo: 'Checklist de Revisão Básica', limite: LIMITE_REVISAO_BYTES, arquivo: 'revisao-basica' },
  revisao_completa: { tipo: 'revisao_completa', titulo: 'Checklist de Revisão Completa', limite: LIMITE_REVISAO_BYTES, arquivo: 'revisao-completa' },
};

// Gera o PDF do checklist (qualquer tipo), guarda como nova versão e registra na linha do tempo.
async function gerarPdfChecklist(db, storage, execId, { operador = 'Sistema', renderizar = renderizarPdf, agora = () => new Date().toISOString() } = {}) {
  if (!storage || !storage.configurado) throw new ErroAcao(503, 'Armazenamento não configurado: não dá para guardar o PDF');
  const { exec, modelo } = basico(db, execId);
  if (exec.status !== 'finalizado') throw new ErroAcao(409, 'Finalize o checklist antes de gerar o PDF');
  const conf = TIPOS_PDF[modelo.codigo];
  if (!conf) throw new ErroAcao(400, 'Este checklist não tem PDF');

  const geradoEm = agora();
  const entrada = modelo.codigo === 'entrada';
  const d = entrada
    ? await dadosVistoria(db, storage, exec.id)
    : await dadosRevisao(db, storage, exec.id, { operador, agora: new Date(geradoEm) });
  const montar = entrada ? montarHtmlVistoria : montarHtmlRevisao;
  // Revisões: duas vias com o mesmo número de versão. Vistoria: via única.
  const vias = entrada ? ['unica'] : ['orcamento', 'cliente'];
  const NOME_VIA = { unica: '', orcamento: ' — via orçamento', cliente: ' — via cliente' };

  const versao = db.prepare('SELECT COALESCE(MAX(versao), 0) + 1 AS v FROM kb_pdfs WHERE execucao_id = ?').get(exec.id).v;
  const gerados = [];
  for (const via of vias) {
    let pdf = null;
    for (const t of TENTATIVAS) {
      pdf = await renderizar(montar(d, { ...t, via }), { rodapeHtml: rodape(conf.titulo + NOME_VIA[via], d, geradoEm) });
      if (pdf.length <= conf.limite) break;
    }
    const sufixo = via === 'unica' ? '' : `-${via}`;
    const chave = `cards/${d.card.id}/pdf/${conf.arquivo}${sufixo}-${exec.id}-v${versao}-${crypto.randomUUID()}.pdf`;
    await storage.enviar(chave, pdf, 'application/pdf');
    gerados.push({ via, chave, pdf });
  }

  return db.transaction(() => {
    const out = [];
    for (const g of gerados) {
      const midiaId = db.prepare(`INSERT INTO kb_midias (cliente_id, chave_objeto, tipo, mime, tamanho_bytes, card_id, checklist_execucao_id,
          status, autor_nome, criado_em, enviado_em) VALUES (?, ?, 'pdf', 'application/pdf', ?, ?, ?, 'enviado', ?, ?, ?)`)
        .run(`pdf-${crypto.randomUUID()}`, g.chave, g.pdf.length, d.card.id, exec.id, operador, geradoEm, geradoEm).lastInsertRowid;
      const pdfId = db.prepare(`INSERT INTO kb_pdfs (card_id, tipo, via, execucao_id, versao, midia_id, gerado_por, gerado_em)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(d.card.id, conf.tipo, g.via, exec.id, versao, midiaId, operador, geradoEm).lastInsertRowid;
      db.prepare(`INSERT INTO kb_eventos (card_id, tipo, texto, dados, midia_id, operador_nome, criado_em) VALUES (?, 'pdf', ?, ?, ?, ?, ?)`)
        .run(d.card.id, `PDF "${conf.titulo}"${NOME_VIA[g.via]} gerado${versao > 1 ? ` (versão ${versao})` : ''} — ${(g.pdf.length / MB).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`,
          JSON.stringify({ pdf_id: pdfId, execucao_id: exec.id, versao, tipo: conf.tipo, via: g.via }), midiaId, operador, geradoEm);
      out.push({ via: g.via, pdf_id: pdfId, midia_id: midiaId, tamanho: g.pdf.length });
    }
    // Campos de topo = a via que pode ir para o cliente (cliente ou única).
    const principal = out.find((x) => x.via !== 'orcamento');
    return { versao, pdf_id: principal.pdf_id, midia_id: principal.midia_id, tamanho: principal.tamanho, vias: out };
  })();
}

// Compatibilidade com a Etapa 4.
const gerarPdfVistoria = gerarPdfChecklist;

// Um PDF por vez (cada um abre um Chrome).
let fila = Promise.resolve();
function naFila(fn) {
  const p = fila.then(fn);
  fila = p.catch(() => {});
  return p;
}

module.exports = {
  montarHtmlVistoria, montarHtmlRevisao, renderizarPdf, dadosVistoria, dadosRevisao, gerarPdfChecklist, gerarPdfVistoria,
  naFila, caminhoChrome, LIMITE_BYTES, LIMITE_REVISAO_BYTES, TIPOS_PDF,
};
