// Checklist guiado (Etapa 4: vistoria de entrada). Uma pergunta por tela, botões grandes,
// Voltar/Próximo e barra de progresso. Cada resposta é salva na hora; as fotos entram na
// fila de envio do aparelho (midia.js), presas ao item. Dá para sair e continuar depois.
(() => {
  const $ = (id) => document.getElementById(id);
  const A = () => window.KanbanApp;
  const M = window.KanbanMidia;
  const esc = (s) => A().esc(s);

  let ch = null;

  // ---------- estrutura ----------
  function montarPassos(modelo) {
    const passos = [];
    for (const s of modelo.secoes) {
      if (s.tipo === 'fotos_obrigatorias') {
        s.itens.forEach((item, i) => passos.push({ tipo: 'foto', item, n: i + 1, total: s.itens.length }));
      } else if (s.tipo === 'avarias') {
        passos.push({ tipo: 'avarias', item: s.itens[0] });
      } else {
        passos.push({ tipo: 'itens', itens: s.itens, titulo: s.titulo });
      }
    }
    passos.push({ tipo: 'resumo' });
    return passos;
  }

  const resposta = (itemId) => ((ch.estado.respostas[itemId] || {}).valor) || {};
  const medida = (item) => item.componentes.find((c) => c.tipo === 'medida');

  // Fotos já enviadas (servidor) ou só capturadas no aparelho (fila). Chave: item ou avaria.
  function fotoDe({ itemId = null, avariaId = null }) {
    const chave = avariaId ? `a${avariaId}` : `i${itemId}`;
    if (ch.local[chave]) return { url: ch.local[chave], local: true };
    const doServidor = ch.estado.midias.filter((m) => (avariaId ? m.avaria_id === avariaId : m.item_id === itemId && !m.avaria_id));
    const ultima = doServidor[doServidor.length - 1];
    if (ultima) return { url: ultima.miniatura_url || ultima.url, local: false };
    const naFila = ch.fila.filter((f) => f.vinculo && (avariaId ? f.vinculo.avaria_id === avariaId : f.vinculo.checklist_item_id === itemId && !f.vinculo.avaria_id));
    if (naFila.length) {
      const f = naFila[naFila.length - 1];
      ch.local[chave] = URL.createObjectURL(f.miniatura || f.blob);
      return { url: ch.local[chave], local: true };
    }
    return null;
  }

  async function atualizarFila() {
    const itens = await M.listarItens();
    ch.fila = itens.filter((i) => i.vinculo && i.vinculo.checklist_execucao_id === ch.execId);
  }

  async function carregarEstado() {
    ch.estado = await A().api(`/api/kanban/checklists/${ch.execId}`);
    if (!ch.passos) ch.passos = montarPassos(ch.estado.modelo);
    await atualizarFila();
  }

  function primeiroPassoPendente() {
    for (let i = 0; i < ch.passos.length; i++) {
      const p = ch.passos[i];
      if (p.tipo === 'foto') {
        const m = medida(p.item);
        if (!fotoDe({ itemId: p.item.id }) || (m && m.obrigatorio && !(resposta(p.item.id).medidas || {})[m.rotulo] && (resposta(p.item.id).medidas || {})[m.rotulo] !== 0)) return i;
      } else if (p.tipo === 'avarias') {
        if (typeof resposta(p.item.id).sim !== 'boolean') return i;
      } else if (p.tipo === 'itens') {
        if (p.itens.some((it) => it.componentes.some((c) => c.tipo === 'opcoes' && c.obrigatorio) && !resposta(it.id).opcao)) return i;
      }
    }
    return ch.passos.length - 1;
  }

  // ---------- abrir / fechar ----------
  async function abrir(cardId, codigo) {
    ch = { cardId: Number(cardId), codigo, execId: null, estado: null, passos: null, i: 0, local: {}, fila: [], avaria: null, sub: 'pergunta' };
    if ($('kbChk').hidden) history.pushState({ kb: 'chk' }, '');
    $('kbChk').hidden = false;
    $('kbChkTitulo').textContent = `Vistoria de entrada · ${($('kbPainelTitulo').textContent || '').split(' · ')[0]}`;
    corpo('<p class="kb-dica">Carregando…</p>');
    nav(null);
    try {
      const lista = await A().api(`/api/kanban/cards/${cardId}/checklists`);
      const existente = lista.find((x) => x.codigo === codigo);
      if (!existente) return telaQuem();
      ch.execId = existente.id;
      ch.pdfs = existente.pdfs;
      await carregarEstado();
      if (ch.estado.execucao.status === 'finalizado') return telaVisualizar();
      ch.i = primeiroPassoPendente();
      render();
    } catch (e) {
      corpo(`<p class="kb-erro-inline">${esc(e.message)}</p>`);
    }
  }

  function fechar({ historico = false } = {}) {
    if (!historico && history.state && history.state.kb === 'chk') { history.back(); return; } // o popstate fecha
    const id = ch && ch.cardId;
    Object.values((ch && ch.local) || {}).forEach((u) => URL.revokeObjectURL(u));
    ch = null;
    $('kbChk').hidden = true;
    if (id) A().checklistFechado(id);
  }

  const corpo = (html) => { $('kbChkCorpo').innerHTML = html; $('kbChkCorpo').scrollTop = 0; };
  function nav(opts) {
    const el = $('kbChkNav');
    if (!opts) { el.innerHTML = ''; return; }
    el.innerHTML = `
      ${opts.voltar ? '<button type="button" class="kb-botao kb-botao-sec" data-acao="chk-voltar">← Voltar</button>' : '<span></span>'}
      ${opts.proximo ? `<button type="button" class="kb-botao" data-acao="chk-proximo" ${opts.proximoOk ? '' : 'disabled'}>${opts.proximoTexto || 'Próximo →'}</button>` : ''}`;
  }
  function progresso() {
    const total = ch.passos.length;
    $('kbChkProgresso').innerHTML = `<span style="width:${Math.round(((ch.i + 1) / total) * 100)}%"></span>`;
  }

  // ---------- "Quem está fazendo este checklist?" ----------
  async function telaQuem() {
    let nomes = [];
    try { nomes = await A().api('/api/kanban/operadores'); } catch (_) { /* campo livre */ }
    const atual = A().operadorAtual();
    corpo(`<h2 class="kb-chk-pergunta">Quem está fazendo este checklist?</h2>
      <div class="kb-lista-operadores">${nomes.map((n) => `<button type="button" data-acao="chk-quem" data-nome="${esc(n)}" aria-pressed="${n === atual}">${esc(n.split(' ')[0])}</button>`).join('')}</div>
      <label class="kb-campo">Outro nome<input id="kbChkQuemLivre" type="text" maxlength="60" value="${nomes.includes(atual) ? '' : esc(atual || '')}"></label>
      <div class="kb-acoes-card" style="margin-top:14px"><button type="button" class="kb-botao" data-acao="chk-comecar">Começar a vistoria</button></div>`);
    $('kbChkProgresso').innerHTML = '';
  }

  async function comecar(nome) {
    const quem = String(nome || '').replace(/\s+/g, ' ').trim();
    if (!quem) { A().avisar('Diga quem está fazendo o checklist', true); return; }
    try {
      const r = await A().api(`/api/kanban/cards/${ch.cardId}/checklists`, {
        json: { codigo: ch.codigo, feito_por: quem, operador: A().operadorAtual() || quem },
      });
      ch.execId = r.execucao_id;
      await carregarEstado();
      ch.i = primeiroPassoPendente();
      render();
    } catch (e) { A().avisar(e.message, true); }
  }

  const operador = () => A().operadorAtual() || (ch.estado && ch.estado.execucao.feito_por);

  // ---------- passos ----------
  function render() {
    const p = ch.passos[ch.i];
    progresso();
    if (p.tipo === 'foto') return renderFoto(p);
    if (p.tipo === 'avarias') return renderAvarias(p);
    if (p.tipo === 'itens') return renderItens(p);
    return renderResumo();
  }

  function renderFoto(p) {
    const foto = fotoDe({ itemId: p.item.id });
    const m = medida(p.item);
    const valorM = m ? (resposta(p.item.id).medidas || {})[m.rotulo] : undefined;
    corpo(`<p class="kb-chk-etapa">Foto ${p.n} de ${p.total}</p>
      <h2 class="kb-chk-pergunta">${esc(p.item.texto)}</h2>
      <p class="kb-chk-instrucao">📐 ${esc(p.item.instrucao || '')}</p>
      <div class="kb-chk-foto">${foto ? `<img src="${esc(foto.url)}" alt="Foto: ${esc(p.item.texto)}">${foto.local ? '<span class="kb-chk-selo">enviando…</span>' : ''}` : '<span>Nenhuma foto ainda</span>'}</div>
      <button type="button" class="kb-botao kb-chk-camera" data-acao="chk-camera">📷 ${foto ? 'Tirar de novo' : 'Abrir câmera'}</button>
      ${m ? `<label class="kb-campo kb-chk-medida">${esc(m.rotulo)} lido no painel
        <input id="kbChkMedida" type="text" inputmode="numeric" autocomplete="off" placeholder="Ex.: 87450" value="${valorM !== undefined ? esc(valorM) : ''}"></label>` : ''}`);
    atualizarNavFoto(p);
  }

  function atualizarNavFoto(p) {
    const m = medida(p.item);
    const okFoto = Boolean(fotoDe({ itemId: p.item.id }));
    const okMedida = !m || !m.obrigatorio || /^\d[\d.]*$/.test(($('kbChkMedida') && $('kbChkMedida').value.trim()) || '');
    nav({ voltar: ch.i > 0, proximo: true, proximoOk: okFoto && okMedida });
  }

  function renderAvarias(p) {
    const avarias = ch.estado.avarias;
    const lista = avarias.map((a) => {
      const f = fotoDe({ avariaId: a.id });
      return `<li class="kb-chk-avaria">${f ? `<img src="${esc(f.url)}" alt="">` : '<span class="kb-chk-semfoto">sem foto</span>'}
        <div><strong>${a.ordem}. ${esc(a.regiao)}</strong><br>${esc(a.descricao)}</div>
        <button type="button" class="kb-link-pequeno" data-acao="chk-avaria-remover" data-id="${a.id}">Remover</button></li>`;
    }).join('');

    if (ch.sub === 'form' && ch.avaria) {
      const regioes = p.item.componentes.find((c) => c.tipo === 'avarias').regioes;
      corpo(`<h2 class="kb-chk-pergunta">Avaria ${avarias.length + 1}</h2>
        <div class="kb-chk-foto"><img src="${esc(ch.avaria.url)}" alt="Foto da avaria"></div>
        <button type="button" class="kb-botao kb-botao-sec" data-acao="chk-avaria-foto">📷 Tirar de novo</button>
        <p class="kb-chk-rotulo">Região</p>
        <div class="kb-chk-opcoes kb-chk-regioes">${regioes.map((r) => `<button type="button" data-acao="chk-regiao" data-valor="${esc(r)}" aria-pressed="${ch.avaria.regiao === r}">${esc(r)}</button>`).join('')}</div>
        <label class="kb-campo">Descrição curta<textarea id="kbChkAvariaDesc" rows="2" maxlength="300" placeholder="Ex.: risco de 10 cm na porta">${esc(ch.avaria.descricao || '')}</textarea></label>
        <div class="kb-acoes-card" style="margin-top:12px">
          <button type="button" class="kb-botao" data-acao="chk-avaria-salvar">Salvar avaria</button>
          <button type="button" class="kb-botao kb-botao-sec" data-acao="chk-avaria-cancelar">Cancelar</button></div>`);
      nav(null);
      return;
    }
    const temAvarias = avarias.length > 0;
    corpo(`<h2 class="kb-chk-pergunta">${temAvarias ? 'Tem outra avaria?' : esc(p.item.texto)}</h2>
      ${temAvarias ? `<ul class="kb-chk-avarias">${lista}</ul>` : ''}
      <div class="kb-chk-simnao">
        <button type="button" class="kb-botao kb-chk-grande" data-acao="chk-avaria-sim">Sim</button>
        <button type="button" class="kb-botao kb-botao-sec kb-chk-grande" data-acao="chk-avaria-nao">Não</button>
      </div>
      <p class="kb-dica">${temAvarias ? 'Sim: a câmera abre para a próxima avaria.' : 'Sim: a câmera abre para fotografar a avaria.'}</p>`);
    nav({ voltar: true, proximo: false });
  }

  function renderItens(p) {
    corpo(`<h2 class="kb-chk-pergunta">${esc(p.titulo)}</h2>${p.itens.map((it) => {
      const c = it.componentes[0];
      const r = resposta(it.id);
      if (c.tipo === 'opcoes') {
        return `<p class="kb-chk-rotulo">${esc(it.texto)}</p><div class="kb-chk-opcoes" data-item="${it.id}" data-tipo="opcoes">${c.opcoes.map((o) =>
          `<button type="button" data-acao="chk-opcao" data-valor="${esc(o)}" aria-pressed="${r.opcao === o}">${esc(o)}</button>`).join('')}</div>`;
      }
      const marcados = r.marcados || [];
      return `<p class="kb-chk-rotulo">${esc(it.texto)}</p><div class="kb-chk-opcoes kb-chk-multi" data-item="${it.id}" data-tipo="multipla">${c.opcoes.map((o) =>
        `<button type="button" data-acao="chk-multi" data-valor="${esc(o)}" aria-pressed="${marcados.includes(o)}">${marcados.includes(o) ? '☑' : '☐'} ${esc(o)}</button>`).join('')}</div>`;
    }).join('')}`);
    atualizarNavItens(p);
  }

  function atualizarNavItens(p) {
    const ok = p.itens.every((it) => !(it.componentes[0].tipo === 'opcoes' && it.componentes[0].obrigatorio)
      || document.querySelector(`.kb-chk-opcoes[data-item="${it.id}"] button[aria-pressed="true"]`));
    nav({ voltar: true, proximo: true, proximoOk: ok });
  }

  async function renderResumo() {
    corpo('<p class="kb-dica">Conferindo…</p>');
    nav(null);
    try { await carregarEstado(); } catch (e) { corpo(`<p class="kb-erro-inline">${esc(e.message)}</p>`); return; }
    const enviando = ch.fila.length;
    // Fotos que estão na fila deste aparelho não contam como pendência: vão chegar.
    const naFila = (texto) => ch.passos.some((p) => p.tipo === 'foto' && texto === `Foto: ${p.item.texto}` && fotoDe({ itemId: p.item.id }))
      || (/^Foto da avaria (\d+)/.test(texto) && ch.fila.some((f) => f.vinculo.avaria_id && ch.estado.avarias.some((a) => a.id === f.vinculo.avaria_id && texto.startsWith(`Foto da avaria ${a.ordem} `))));
    const faltas = ch.estado.pendencias.filter((f) => !naFila(f));
    const comb = ch.passos.find((p) => p.tipo === 'itens');
    corpo(`<h2 class="kb-chk-pergunta">Conferir e finalizar</h2>
      <ul class="kb-chk-resumo">
        <li>📷 ${ch.passos.filter((p) => p.tipo === 'foto' && fotoDe({ itemId: p.item.id })).length} de ${ch.passos.filter((p) => p.tipo === 'foto').length} fotos</li>
        <li>⚠️ ${ch.estado.avarias.length ? `${ch.estado.avarias.length} avaria(s)` : (resposta(ch.passos.find((p) => p.tipo === 'avarias').item.id).sim === false ? 'Nenhuma avaria' : 'Avarias não respondidas')}</li>
        ${comb ? `<li>⛽ Combustível: ${esc(resposta(comb.itens[0].id).opcao || '—')}</li>` : ''}
        <li>👤 Feita por ${esc(ch.estado.execucao.feito_por)}</li>
      </ul>
      ${enviando ? `<p class="kb-aviso-inline">⬆️ Enviando ${enviando} foto(s). Pode finalizar: a vistoria fecha sozinha quando o envio terminar.</p>` : ''}
      ${faltas.length ? `<div class="kb-erro-inline"><strong>Ainda falta:</strong><ul>${faltas.map((f) => `<li>${esc(f)}</li>`).join('')}</ul></div>` : ''}
      ${ch.aguardandoEnvio ? '<p class="kb-dica">Aguardando o envio das fotos para finalizar…</p>' : ''}`);
    nav({ voltar: true, proximo: true, proximoOk: !faltas.length && !ch.aguardandoEnvio, proximoTexto: '✓ Finalizar vistoria' });
  }

  async function finalizar() {
    await atualizarFila();
    if (ch.fila.length) {
      ch.aguardandoEnvio = true; // M.aoConcluir chama de novo quando a fila desta vistoria esvaziar
      renderResumo();
      return;
    }
    try {
      await A().api(`/api/kanban/checklists/${ch.execId}/finalizar`, { json: { operador: operador() } });
      ch.aguardandoEnvio = false;
      corpo(`<div class="kb-chk-fim"><div class="kb-chk-ok">✓</div><h2>Vistoria finalizada</h2>
        <p>O PDF "Vistoria de Entrada" é gerado em instantes e aparece na linha do tempo do card.</p>
        <button type="button" class="kb-botao" data-acao="chk-fechar">Fechar</button></div>`);
      nav(null);
      $('kbChkProgresso').innerHTML = '<span style="width:100%"></span>';
    } catch (e) {
      ch.aguardandoEnvio = false;
      A().avisar(e.message, true);
      renderResumo();
    }
  }

  // ---------- vistoria finalizada: visualizar e exportar PDF ----------
  function telaVisualizar() {
    const fotos = ch.passos.filter((p) => p.tipo === 'foto');
    const pAv = ch.passos.find((p) => p.tipo === 'avarias');
    const pIt = ch.passos.find((p) => p.tipo === 'itens');
    const km = (resposta(fotos[0].item.id).medidas || {}).KM;
    const e = ch.estado.execucao;
    corpo(`<p class="kb-dica">Feita por <strong>${esc(e.feito_por)}</strong> · ${A().dataBR(e.iniciado_em)} a ${A().dataBR(e.finalizado_em)}${km !== undefined ? ` · KM ${Number(km).toLocaleString('pt-BR')}` : ''}</p>
      <div class="kb-acoes-card">
        ${(ch.pdfs || []).length ? `<a class="kb-botao" href="${esc(ch.pdfs[0].url)}" target="_blank" rel="noopener">📄 Abrir PDF${ch.pdfs.length > 1 ? ` (v${ch.pdfs[0].versao})` : ''}</a>` : '<span class="kb-dica">PDF sendo gerado…</span>'}
        <button type="button" class="kb-botao kb-botao-sec" data-acao="chk-pdf">Exportar PDF de novo</button>
      </div>
      <div class="kb-chk-grade">${fotos.map((p) => {
        const f = fotoDe({ itemId: p.item.id });
        return `<figure>${f ? `<img src="${esc(f.url)}" alt="">` : '<div class="kb-chk-semfoto">sem foto</div>'}<figcaption>${p.n}. ${esc(p.item.texto)}</figcaption></figure>`;
      }).join('')}</div>
      <h3 class="kb-sec">Avarias</h3>
      ${ch.estado.avarias.length ? `<ul class="kb-chk-avarias">${ch.estado.avarias.map((a) => {
        const f = fotoDe({ avariaId: a.id });
        return `<li class="kb-chk-avaria">${f ? `<img src="${esc(f.url)}" alt="">` : ''}<div><strong>${a.ordem}. ${esc(a.regiao)}</strong><br>${esc(a.descricao)}</div></li>`;
      }).join('')}</ul>` : `<p>${resposta(pAv.item.id).sim === false ? 'Nenhuma avaria identificada' : '—'}</p>`}
      ${pIt ? `<h3 class="kb-sec">Combustível e itens</h3><p>Combustível: <strong>${esc(resposta(pIt.itens[0].id).opcao || '—')}</strong><br>
        Itens: ${esc((resposta(pIt.itens[1].id).marcados || []).join(', ') || 'nenhum marcado')}</p>` : ''}
      ${(ch.pdfs || []).length > 1 ? `<h3 class="kb-sec">Versões do PDF</h3><ul>${ch.pdfs.map((p) => `<li><a href="${esc(p.url)}" target="_blank" rel="noopener">Versão ${p.versao}</a> · ${A().dataBR(p.gerado_em)} · ${esc(p.gerado_por)}</li>`).join('')}</ul>` : ''}`);
    nav(null);
    $('kbChkProgresso').innerHTML = '';
  }

  async function exportarPdf(botao) {
    const op = await A().garantirOperador();
    if (!op) return;
    botao.disabled = true;
    botao.textContent = 'Gerando PDF…';
    try {
      await A().api(`/api/kanban/checklists/${ch.execId}/pdf`, { json: { operador: op } });
      const lista = await A().api(`/api/kanban/cards/${ch.cardId}/checklists`);
      ch.pdfs = (lista.find((x) => x.id === ch.execId) || {}).pdfs || [];
      A().avisar('PDF gerado');
      telaVisualizar();
    } catch (e) {
      A().avisar(e.message, true);
      botao.disabled = false;
      botao.textContent = 'Exportar PDF de novo';
    }
  }

  // ---------- fotos ----------
  async function fotoCapturada(arquivo, { itemId, avaria = false }) {
    if (!arquivo || !ch) return;
    const preparado = await M.prepararFoto(arquivo);
    if (avaria) {
      if (ch.avaria && ch.avaria.url) URL.revokeObjectURL(ch.avaria.url);
      ch.avaria = { ...(ch.avaria || {}), preparado, url: URL.createObjectURL(preparado.miniatura || preparado.blob) };
      ch.sub = 'form';
      render();
      return;
    }
    await M.enfileirar({
      cardId: ch.cardId, preparado, operador: operador(),
      vinculo: { checklist_execucao_id: ch.execId, checklist_item_id: itemId },
    });
    const chave = `i${itemId}`;
    if (ch.local[chave]) URL.revokeObjectURL(ch.local[chave]);
    ch.local[chave] = URL.createObjectURL(preparado.miniatura || preparado.blob);
    await atualizarFila();
    render();
  }

  async function salvarAvaria() {
    const desc = ($('kbChkAvariaDesc').value || '').trim();
    if (!ch.avaria.regiao) { A().avisar('Escolha a região', true); return; }
    if (desc.length < 3) { A().avisar('Descreva a avaria em poucas palavras', true); $('kbChkAvariaDesc').focus(); return; }
    try {
      const a = await A().api(`/api/kanban/checklists/${ch.execId}/avarias`, { json: { regiao: ch.avaria.regiao, descricao: desc, operador: operador() } });
      const passoAv = ch.passos.find((p) => p.tipo === 'avarias');
      await M.enfileirar({
        cardId: ch.cardId, preparado: ch.avaria.preparado, operador: operador(),
        vinculo: { checklist_execucao_id: ch.execId, checklist_item_id: passoAv.item.id, avaria_id: a.id },
      });
      ch.local[`a${a.id}`] = ch.avaria.url;
      ch.avaria = null;
      ch.sub = 'pergunta';
      await carregarEstado();
      render();
    } catch (e) { A().avisar(e.message, true); }
  }

  async function salvarResposta(itemId, valor) {
    await A().api(`/api/kanban/checklists/${ch.execId}/respostas/${itemId}`, { method: 'PUT', json: { valor, operador: operador() } });
    ch.estado.respostas[itemId] = { valor };
  }

  // Avança; se o próximo passo é foto sem foto, abre a câmera direto (ainda dentro do toque).
  function irPara(i, { abrirCamera = false } = {}) {
    ch.i = Math.max(0, Math.min(ch.passos.length - 1, i));
    render();
    const p = ch.passos[ch.i];
    if (abrirCamera && p.tipo === 'foto' && !fotoDe({ itemId: p.item.id })) {
      ch.alvoFoto = { itemId: p.item.id }; // a foto que voltar da câmera é deste item
      $('kbInChk').click();
    }
  }

  // ---------- eventos ----------
  $('kbChk').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-acao]');
    if (!b || !ch) return;
    const p = ch.passos && ch.passos[ch.i];
    switch (b.dataset.acao) {
      case 'chk-sair': fechar(); break;
      case 'chk-fechar': fechar(); break;
      case 'chk-quem':
        document.querySelectorAll('[data-acao="chk-quem"]').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        $('kbChkQuemLivre').value = '';
        ch.quem = b.dataset.nome;
        break;
      case 'chk-comecar': b.disabled = true; await comecar(($('kbChkQuemLivre').value.trim()) || ch.quem || A().operadorAtual()); b.disabled = false; break;
      case 'chk-camera': ch.alvoFoto = { itemId: p.item.id }; $('kbInChk').click(); break;
      case 'chk-voltar':
        if (p.tipo === 'avarias' && ch.sub === 'form') { ch.sub = 'pergunta'; render(); break; }
        irPara(ch.i - 1);
        break;
      case 'chk-proximo': {
        b.disabled = true;
        if (p.tipo === 'foto') {
          const m = medida(p.item);
          if (m) {
            const bruto = $('kbChkMedida').value.trim();
            try { await salvarResposta(p.item.id, { medidas: { [m.rotulo]: bruto } }); } catch (e) { A().avisar(e.message, true); b.disabled = false; break; }
            irPara(ch.i + 1); // depois de esperar a rede o navegador não deixa abrir a câmera sozinho
          } else {
            irPara(ch.i + 1, { abrirCamera: true });
          }
        } else if (p.tipo === 'itens') {
          try {
            for (const it of p.itens) {
              const grupo = document.querySelector(`.kb-chk-opcoes[data-item="${it.id}"]`);
              const marcados = [...grupo.querySelectorAll('button[aria-pressed="true"]')].map((x) => x.dataset.valor);
              await salvarResposta(it.id, grupo.dataset.tipo === 'opcoes' ? { opcao: marcados[0] } : { marcados });
            }
            irPara(ch.i + 1);
          } catch (e) { A().avisar(e.message, true); b.disabled = false; }
        } else if (p.tipo === 'resumo') {
          await finalizar();
        }
        break;
      }
      case 'chk-avaria-sim':
        ch.avaria = {};
        ch.alvoFoto = { avaria: true };
        $('kbInChk').click();
        break;
      case 'chk-avaria-foto': ch.alvoFoto = { avaria: true }; $('kbInChk').click(); break;
      case 'chk-avaria-nao':
        try {
          if (!ch.estado.avarias.length) await salvarResposta(p.item.id, { sim: false });
          irPara(ch.i + 1);
        } catch (e) { A().avisar(e.message, true); }
        break;
      case 'chk-regiao':
        ch.avaria.regiao = b.dataset.valor;
        ch.avaria.descricao = $('kbChkAvariaDesc').value;
        b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        break;
      case 'chk-avaria-salvar': b.disabled = true; await salvarAvaria(); if (b.isConnected) b.disabled = false; break;
      case 'chk-avaria-cancelar': ch.avaria = null; ch.sub = 'pergunta'; render(); break;
      case 'chk-avaria-remover':
        try {
          await A().api(`/api/kanban/checklists/avarias/${b.dataset.id}/remover`, { json: { operador: operador() } });
          await carregarEstado();
          render();
        } catch (e) { A().avisar(e.message, true); }
        break;
      case 'chk-opcao':
        b.parentElement.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
        atualizarNavItens(p);
        break;
      case 'chk-multi': {
        const on = b.getAttribute('aria-pressed') !== 'true';
        b.setAttribute('aria-pressed', String(on));
        b.textContent = `${on ? '☑' : '☐'} ${b.dataset.valor}`;
        break;
      }
      case 'chk-pdf': await exportarPdf(b); break;
      default: break;
    }
  });
  $('kbChk').addEventListener('input', (ev) => {
    if (ev.target.id === 'kbChkMedida' && ch) atualizarNavFoto(ch.passos[ch.i]);
  });
  $('kbInChk').addEventListener('change', (ev) => {
    const arq = ev.target.files[0];
    ev.target.value = '';
    if (!ch || !arq) return;
    const alvo = ch.alvoFoto || {};
    if (alvo.avaria) fotoCapturada(arq, { avaria: true });
    else if (alvo.itemId) fotoCapturada(arq, { itemId: alvo.itemId });
  });

  // Quando a fila desta vistoria esvaziar e o mecânico já pediu para finalizar, finaliza.
  M.aoConcluir(async (item) => {
    if (!ch || !item.vinculo || item.vinculo.checklist_execucao_id !== ch.execId) return;
    await atualizarFila();
    if (ch.aguardandoEnvio && !ch.fila.length) { ch.aguardandoEnvio = false; finalizar(); }
  });

  window.KanbanChecklist = { abrir, fechar };
})();
