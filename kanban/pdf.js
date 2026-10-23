// PDFs gerados no servidor (Etapa 4: "Vistoria de Entrada").
//
// O HTML é montado aqui e impresso pelo Chrome headless (puppeteer-core; no Railway o
// Chrome for Testing já está no container, em CHROME_PATH). As fotos saem do bucket,
// entram no HTML e são recomprimidas pelo próprio Chrome (canvas) antes de imprimir,
// para o PDF caber no WhatsApp: alvo < 8 MB. O PDF vai para o bucket e entra na linha do tempo.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const EMPRESA = require('./empresa');
const { formatarBR } = require('./datas');
const { ErroAcao } = require('./acoes');
const chk = require('./checklists');

const LIMITE_BYTES = 8 * 1024 * 1024;
const TENTATIVAS = [
  { lado: 1100, qualidade: 0.72 },
  { lado: 850, qualidade: 0.6 },
  { lado: 650, qualidade: 0.5 },
];

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const json = (s, p = null) => { try { return s ? JSON.parse(s) : p; } catch (_) { return p; } };

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
  h2 { font-size: 10.5pt; background: #1f2330; color: #fff; padding: 4px 8px; margin: 14px 0 6px; letter-spacing: .4px; }
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
  return `<tr>${celulas.map(([r, v, span]) => `<td${span ? ` colspan="${span}"` : ''}><span class="r">${esc(r)}</span>${esc(v || '—')}</td>`).join('')}</tr>`;
}

// HTML do PDF "Vistoria de Entrada" (função pura, testável sem Chrome).
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
  <div class="cab">
    ${d.logo ? `<img src="${d.logo}" alt="Cavallaria Garage">` : ''}
    <div class="emp"><strong>${esc(EMPRESA.nome)}</strong><br>${esc(EMPRESA.slogan)}<br>${esc(EMPRESA.endereco)}<br>
      ${esc(EMPRESA.telefone)} · ${esc(EMPRESA.email)}<br>CNPJ: ${esc(EMPRESA.cnpj)}</div>
  </div>
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

function rodape(d, geradoEm) {
  return `<div style="width:100%;font-size:7.5pt;color:#5b6170;padding:0 12mm;display:flex;justify-content:space-between;font-family:Arial,sans-serif">
    <span>Vistoria de entrada · OS ${esc(d.card.os_numero)} · gerado em ${esc(formatarBR(geradoEm))}</span>
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

// Junta os dados da vistoria (fotos já baixadas do bucket como data URL).
async function dadosVistoria(db, storage, execId) {
  const exec = db.prepare('SELECT * FROM kb_checklist_execucoes WHERE id = ?').get(Number(execId));
  if (!exec) throw new ErroAcao(404, 'Checklist não encontrado');
  const card = db.prepare('SELECT * FROM kb_cards WHERE id = ?').get(exec.card_id);
  card.veiculo_detalhes = json(card.veiculo_detalhes, {});
  const modelo = chk.carregarModelo(db, exec.modelo_id);
  const itens = chk.itensDoModelo(modelo);
  const respostas = new Map(db.prepare('SELECT item_id, valor FROM kb_checklist_respostas WHERE execucao_id = ?').all(exec.id)
    .map((r) => [r.item_id, json(r.valor, {})]));
  const midias = chk.midiasDaExecucao(db, exec.id).filter((m) => m.tipo === 'foto');

  const baixar = async (m) => {
    try {
      const b = await storage.ler(m.chave_objeto);
      return `data:${m.mime};base64,${b.toString('base64')}`;
    } catch (_) { return null; }
  };

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
      src: ultima ? await baixar(ultima) : null,
    });
  }
  const avarias = [];
  for (const a of db.prepare('SELECT * FROM kb_checklist_avarias WHERE execucao_id = ? AND removido_em IS NULL ORDER BY ordem').all(exec.id)) {
    const srcs = [];
    for (const m of midias.filter((x) => x.avaria_id === a.id)) srcs.push(await baixar(m));
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

// Gera o PDF, guarda no bucket como nova versão e registra na linha do tempo.
async function gerarPdfVistoria(db, storage, execId, { operador = 'Sistema', renderizar = renderizarPdf, agora = () => new Date().toISOString() } = {}) {
  if (!storage || !storage.configurado) throw new ErroAcao(503, 'Armazenamento não configurado: não dá para guardar o PDF');
  const d = await dadosVistoria(db, storage, execId);
  if (d.exec.status !== 'finalizado') throw new ErroAcao(409, 'Finalize a vistoria antes de gerar o PDF');

  const geradoEm = agora();
  let pdf = null;
  for (const t of TENTATIVAS) {
    pdf = await renderizar(montarHtmlVistoria(d, t), { rodapeHtml: rodape(d, geradoEm) });
    if (pdf.length <= LIMITE_BYTES) break;
  }

  const versao = db.prepare('SELECT COALESCE(MAX(versao), 0) + 1 AS v FROM kb_pdfs WHERE execucao_id = ?').get(d.exec.id).v;
  const chave = `cards/${d.card.id}/pdf/vistoria-entrada-${d.exec.id}-v${versao}-${crypto.randomUUID()}.pdf`;
  await storage.enviar(chave, pdf, 'application/pdf');

  return db.transaction(() => {
    const midiaId = db.prepare(`INSERT INTO kb_midias (cliente_id, chave_objeto, tipo, mime, tamanho_bytes, card_id, checklist_execucao_id,
        status, autor_nome, criado_em, enviado_em) VALUES (?, ?, 'pdf', 'application/pdf', ?, ?, ?, 'enviado', ?, ?, ?)`)
      .run(`pdf-${crypto.randomUUID()}`, chave, pdf.length, d.card.id, d.exec.id, operador, geradoEm, geradoEm).lastInsertRowid;
    const pdfId = db.prepare(`INSERT INTO kb_pdfs (card_id, tipo, execucao_id, versao, midia_id, gerado_por, gerado_em)
        VALUES (?, 'vistoria_entrada', ?, ?, ?, ?, ?)`).run(d.card.id, d.exec.id, versao, midiaId, operador, geradoEm).lastInsertRowid;
    db.prepare(`INSERT INTO kb_eventos (card_id, tipo, texto, dados, midia_id, operador_nome, criado_em) VALUES (?, 'pdf', ?, ?, ?, ?, ?)`)
      .run(d.card.id, `PDF "Vistoria de Entrada" gerado${versao > 1 ? ` (versão ${versao})` : ''} — ${(pdf.length / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`,
        JSON.stringify({ pdf_id: pdfId, execucao_id: d.exec.id, versao }), midiaId, operador, geradoEm);
    return { pdf_id: pdfId, midia_id: midiaId, versao, tamanho: pdf.length };
  })();
}

// Um PDF por vez (cada um abre um Chrome).
let fila = Promise.resolve();
function naFila(fn) {
  const p = fila.then(fn);
  fila = p.catch(() => {});
  return p;
}

module.exports = { montarHtmlVistoria, renderizarPdf, dadosVistoria, gerarPdfVistoria, naFila, caminhoChrome, LIMITE_BYTES };
