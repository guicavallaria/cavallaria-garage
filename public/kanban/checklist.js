// Checklists guiados: vistoria de entrada (Etapa 4) e revisões básica/completa (Etapa 5).
// Uma pergunta por tela, botões grandes, Voltar/Próximo e barra de progresso. Cada resposta
// é salva na hora; fotos e vídeos entram na fila de envio do aparelho (midia.js), presos ao
// item. Dá para sair e continuar depois. Depois de finalizado, cada item pode ser editado
// (o servidor guarda a versão anterior e registra na linha do tempo).
(() => {
  const $ = (id) => document.getElementById(id);
  const A = () => window.KanbanApp;
  const M = window.KanbanMidia;
  const esc = (s) => A().esc(s);

  const NOMES = { entrada: 'Vistoria de entrada', revisao_basica: 'Revisão básica', revisao_completa: 'Revisão completa' };
  const ESTADOS = {
    troca: [['bom', 'Bom'], ['regular', 'Regular'], ['troca', 'Necessita troca']],
    reparo: [['bom', 'Bom'], ['regular', 'Regular'], ['reparo', 'Necessita reparo']],
  };

  let ch = null;

  // ---------- estrutura ----------
  function montarPassos(modelo) {
    const passos = [];
    const entrada = modelo.codigo === 'entrada';
    let n = 0;
    for (const s of modelo.secoes) {
      if (s.tipo === 'fotos_obrigatorias') {
        s.itens.forEach((item, i) => passos.push({ tipo: 'foto', item, n: i + 1, total: s.itens.length }));
      } else if (s.tipo === 'avarias') {
        passos.push({ tipo: 'avarias', item: s.itens[0] });
      } else if (s.tipo === 'pecas_defeituosas') {
        passos.push({ tipo: 'pecas', titulo: s.titulo });
      } else if (entrada) {
        passos.push({ tipo: 'itens', itens: s.itens, titulo: s.titulo });
      } else {
        const numerar = !/^Freio/i.test(s.titulo);
        s.itens.forEach((item) => passos.push({ tipo: 'item', item, secao: s, n: numerar ? ++n : null }));
      }
    }
    passos.push({ tipo: 'resumo' });
    return passos;
  }

  const resposta = (itemId) => ((ch.estado.respostas[itemId] || {}).valor) || {};
  const medida = (item) => item.componentes.find((c) => c.tipo === 'medida');
  const temFotoObrigatoria = (item) => item.componentes.some((c) => c.tipo === 'foto' && c.obrigatorio);

  // Fotos já enviadas (servidor) ou só capturadas no aparelho (fila). Chave: item ou avaria.
  function fotoDe({ itemId = null, avariaId = null }) {
    const chave = avariaId ? `a${avariaId}` : `i${itemId}`;
    if (ch.local[chave]) return { url: ch.local[chave], local: true };
    const doServidor = ch.estado.midias.filter((m) => m.tipo === 'foto' && (avariaId ? m.avaria_id === avariaId : m.item_id === itemId && !m.avaria_id));
    const ultima = doServidor[doServidor.length - 1];
    if (ultima) return { url: ultima.miniatura_url || ultima.url, local: false };
    const naFila = ch.fila.filter((f) => f.tipo === 'foto' && f.vinculo && (avariaId ? f.vinculo.avaria_id === avariaId : f.vinculo.checklist_item_id === itemId && !f.vinculo.avaria_id));
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
    ch.codigo = ch.estado.modelo.codigo;
    ch.passos = montarPassos(ch.estado.modelo);
    await atualizarFila();
  }

  function itemRespondido(item) {
    const v = resposta(item.id);
    if (v.nao_tem) return true;
    for (const c of item.componentes) {
      if (c.tipo === 'estado' && c.obrigatorio && !v.estado) return false;
      if (c.tipo === 'sim_nao' && c.obrigatorio && typeof v.sim !== 'boolean') return false;
      if (c.tipo === 'opcoes' && c.obrigatorio && !v.opcao) return false;
      if (c.tipo === 'texto' && c.obrigatorio && !v.texto) return false;
      if (c.tipo === 'medida' && c.obrigatorio && !(v.medidas && v.medidas[c.rotulo] !== undefined)) return false;
      if (c.tipo === 'foto' && c.obrigatorio && !fotoDe({ itemId: item.id })) return false;
    }
    return true;
  }

  function primeiroPassoPendente() {
    for (let i = 0; i < ch.passos.length; i++) {
      const p = ch.passos[i];
      if (p.tipo === 'foto') {
        const m = medida(p.item);
        const v = (resposta(p.item.id).medidas || {})[m ? m.rotulo : ''];
        if (!fotoDe({ itemId: p.item.id }) || (m && m.obrigatorio && v === undefined)) return i;
      } else if (p.tipo === 'avarias') {
        if (typeof resposta(p.item.id).sim !== 'boolean') return i;
      } else if (p.tipo === 'itens') {
        if (p.itens.some((it) => it.componentes.some((c) => c.tipo === 'opcoes' && c.obrigatorio) && !resposta(it.id).opcao)) return i;
      } else if (p.tipo === 'item') {
        if (!itemRespondido(p.item)) return i;
      }
    }
    return ch.passos.length - 1;
  }

  // ---------- abrir / fechar ----------
  // abrir(card, 'entrada') → a vistoria do card; abrir(card, 'revisao_basica') → a revisão em
  // andamento ou uma nova; abrir(card, codigo, { execId }) → um checklist específico.
  async function abrir(cardId, codigo, { execId = null } = {}) {
    ch = { cardId: Number(cardId), codigo, execId: null, estado: null, passos: null, i: 0, local: {}, fila: [], avaria: null, sub: 'pergunta', rascunho: {}, edicao: false };
    if ($('kbChk').hidden) history.pushState({ kb: 'chk' }, '');
    $('kbChk').hidden = false;
    titulo();
    corpo('<p class="kb-dica">Carregando…</p>');
    nav(null);
    try {
      const lista = await A().api(`/api/kanban/cards/${cardId}/checklists`);
      const existente = execId ? lista.find((x) => x.id === Number(execId))
        : lista.find((x) => x.codigo === codigo && (codigo === 'entrada' || x.status === 'em_andamento'));
      if (!existente) return telaQuem();
      ch.execId = existente.id;
      ch.pdfs = existente.pdfs;
      await carregarEstado();
      titulo();
      if (ch.estado.execucao.status === 'finalizado') return telaVisualizar();
      ch.i = primeiroPassoPendente();
      render();
    } catch (e) {
      corpo(`<p class="kb-erro-inline">${esc(e.message)}</p>`);
    }
  }

  function titulo() {
    const os = ($('kbPainelTitulo').textContent || '').split(' · ')[0];
    $('kbChkTitulo').textContent = `${NOMES[ch.codigo] || 'Checklist'} · ${os}`;
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
      ${opts.voltar ? `<button type="button" class="kb-botao kb-botao-sec" data-acao="chk-voltar">${opts.voltarTexto || '← Voltar'}</button>` : '<span></span>'}
      ${opts.proximo ? `<button type="button" class="kb-botao" data-acao="chk-proximo" ${opts.proximoOk ? '' : 'disabled'}>${opts.proximoTexto || 'Próximo →'}</button>` : ''}`;
  }
  function progresso() {
    const total = ch.passos.length;
    $('kbChkProgresso').innerHTML = ch.edicao ? '' : `<span style="width:${Math.round(((ch.i + 1) / total) * 100)}%"></span>`;
  }
  // Em edição pós-finalização, a navegação vira "Cancelar / Salvar alteração".
  function navPasso(proximoOk, extra = {}) {
    if (ch.edicao) nav({ voltar: true, voltarTexto: 'Cancelar', proximo: true, proximoOk, proximoTexto: '✓ Salvar alteração' });
    else nav({ voltar: ch.i > 0, proximo: true, proximoOk, ...extra });
  }

  // ---------- "Quem está fazendo este checklist?" ----------
  async function telaQuem() {
    let nomes = [];
    try { nomes = await A().api('/api/kanban/operadores'); } catch (_) { /* campo livre */ }
    const atual = A().operadorAtual();
    corpo(`<h2 class="kb-chk-pergunta">Quem está fazendo este checklist?</h2>
      <div class="kb-lista-operadores">${nomes.map((n) => `<button type="button" data-acao="chk-quem" data-nome="${esc(n)}" aria-pressed="${n === atual}">${esc(n.split(' ')[0])}</button>`).join('')}</div>
      <label class="kb-campo">Outro nome<input id="kbChkQuemLivre" type="text" maxlength="60" value="${nomes.includes(atual) ? '' : esc(atual || '')}"></label>
      <div class="kb-acoes-card" style="margin-top:14px"><button type="button" class="kb-botao" data-acao="chk-comecar">Começar</button></div>`);
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
    if (p.tipo === 'item') return renderItem(p);
    if (p.tipo === 'pecas') return renderPecas(p);
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
    navPasso(okFoto && okMedida);
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
    nav(ch.edicao ? { voltar: true, voltarTexto: 'Concluir', proximo: false } : { voltar: true, proximo: false });
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
    navPasso(ok);
  }

  // ---------- item de revisão (genérico) ----------
  function rascunhoDe(item) {
    if (!ch.rascunho[item.id]) ch.rascunho[item.id] = JSON.parse(JSON.stringify(resposta(item.id)));
    return ch.rascunho[item.id];
  }

  function anexosDoItem(item) {
    const midias = ch.estado.midias.filter((m) => m.item_id === item.id && !m.avaria_id)
      .map((m) => ({ quando: m.enviado_em, html: m.tipo === 'foto'
        ? `<button type="button" class="kb-miniatura" data-acao="chk-ver-foto" data-url="${esc(m.url)}"><img src="${esc(m.miniatura_url || m.url)}" alt=""></button>`
        : m.tipo === 'video' ? `<video class="kb-player" src="${esc(m.url)}" ${m.miniatura_url ? `poster="${esc(m.miniatura_url)}"` : ''} controls playsinline preload="none"></video>`
          : `<audio class="kb-player-audio" src="${esc(m.url)}" controls preload="none"></audio>`,
      remover: `<button type="button" class="kb-link-pequeno" data-acao="chk-midia-remover" data-id="${m.id}">remover</button>`, autor: m.autor }));
    const fila = ch.fila.filter((f) => f.vinculo.checklist_item_id === item.id && !f.vinculo.avaria_id)
      .map((f) => ({ quando: f.criado_em, html: `<span class="kb-dica">${f.tipo === 'foto' ? '📷' : '🎥'} enviando…</span>`, remover: '', autor: f.operador }));
    const coms = ch.estado.comentarios.filter((c) => c.item_id === item.id)
      .map((c) => ({ quando: c.criado_em, html: `<div class="kb-chk-com">💬 ${esc(c.texto)}</div>`,
        remover: `<button type="button" class="kb-link-pequeno" data-acao="chk-com-remover" data-id="${c.id}">remover</button>`, autor: c.autor_nome }));
    return [...midias, ...fila, ...coms].sort((a, b) => String(a.quando).localeCompare(String(b.quando)));
  }

  function renderItem(p) {
    const item = p.item;
    const v = rascunhoDe(item);
    const comps = item.componentes;
    const temNT = comps.some((c) => c.nao_tem);
    const nt = v.nao_tem === true;
    const blocos = comps.map((c) => {
      if (nt) return '';
      if (c.tipo === 'estado') {
        const op = ESTADOS[c.escala] || ESTADOS.troca;
        return `<div class="kb-chk-opcoes kb-chk-estado">${op.map(([k, rot]) => `<button type="button" class="kb-est-${k}" data-acao="chk-estado" data-valor="${k}" aria-pressed="${v.estado === k}">${rot}</button>`).join('')}</div>
          ${v.estado === 'reparo' || v.estado === 'troca' ? `<label class="kb-campo">Descreva ${v.estado === 'reparo' ? 'o reparo necessário' : 'a troca (opcional)'}
            <textarea id="kbChkDesc" rows="2" maxlength="300">${esc(v.descricao || '')}</textarea></label>` : ''}`;
      }
      if (c.tipo === 'sim_nao') {
        const [s, n] = c.rotulos || ['Sim', 'Não'];
        return `<div class="kb-chk-opcoes kb-chk-simnao2"><button type="button" data-acao="chk-sim" data-valor="1" aria-pressed="${v.sim === true}">${esc(s)}</button>
          <button type="button" data-acao="chk-sim" data-valor="0" aria-pressed="${v.sim === false}">${esc(n)}</button></div>
          ${c.texto_se_sim && v.sim === true ? `<label class="kb-campo">Detalhe<textarea id="kbChkTexto" rows="2" maxlength="1000">${esc(v.texto || '')}</textarea></label>` : ''}`;
      }
      if (c.tipo === 'opcoes') {
        return `<div class="kb-chk-opcoes">${c.opcoes.map((o) => `<button type="button" data-acao="chk-item-opcao" data-valor="${esc(o)}" aria-pressed="${v.opcao === o}">${esc(o)}</button>`).join('')}</div>`;
      }
      if (c.tipo === 'medida') {
        const val = v.medidas && v.medidas[c.rotulo] !== undefined ? String(v.medidas[c.rotulo]).replace('.', ',') : '';
        return `<label class="kb-campo kb-chk-medida-p">${esc(c.rotulo)}${c.unidade ? ` (${esc(c.unidade)})` : ''}${c.obrigatorio ? ' *' : ' — opcional'}
          <input type="text" inputmode="decimal" autocomplete="off" data-medida="${esc(c.rotulo)}" value="${esc(val)}"></label>`;
      }
      if (c.tipo === 'texto') return `<label class="kb-campo">${esc(c.rotulo || 'Texto')}<input type="text" id="kbChkCampoTexto" maxlength="200" value="${esc(v.texto || '')}"></label>`;
      if (c.tipo === 'foto') {
        const foto = fotoDe({ itemId: item.id });
        return `<div class="kb-chk-foto kb-chk-foto-p">${foto ? `<img src="${esc(foto.url)}" alt="">` : `<span>${esc(c.rotulo || 'Foto obrigatória')}</span>`}</div>
          <button type="button" class="kb-botao kb-chk-camera" data-acao="chk-camera">📷 ${foto ? 'Tirar de novo' : esc(c.rotulo || 'Abrir câmera')}</button>`;
      }
      return '';
    }).join('');
    const anexos = anexosDoItem(item);
    corpo(`<p class="kb-chk-etapa">${esc(p.secao.titulo)}${p.n ? ` · item ${p.n}` : ''}</p>
      <h2 class="kb-chk-pergunta">${esc(item.texto)}</h2>
      ${item.instrucao ? `<p class="kb-chk-instrucao">${esc(item.instrucao)}</p>` : ''}
      ${blocos}
      ${temNT ? `<button type="button" class="kb-botao kb-botao-sec kb-chk-nt" data-acao="chk-nt" aria-pressed="${nt}">${nt ? '✓ Não tem' : 'Não tem'}</button>` : ''}
      <div class="kb-chk-anexos">
        <p class="kb-chk-rotulo">Anexos (opcional)</p>
        ${anexos.length ? `<ul>${anexos.map((a) => `<li>${a.html}<small class="kb-dica">${esc(a.autor || '')}</small> ${a.remover}</li>`).join('')}</ul>` : ''}
        <div class="kb-acoes-card">
          <button type="button" class="kb-botao kb-botao-sec" data-acao="chk-anexo-foto">+ Foto</button>
          <button type="button" class="kb-botao kb-botao-sec" data-acao="chk-anexo-video">+ Vídeo</button>
          <button type="button" class="kb-botao kb-botao-sec" data-acao="chk-anexo-com">+ Comentário</button>
        </div>
        ${ch.comentando ? `<label class="kb-campo">Comentário<textarea id="kbChkCom" rows="2" maxlength="1000"></textarea></label>
          <div class="kb-acoes-card"><button type="button" class="kb-botao" data-acao="chk-com-salvar">Salvar comentário</button>
          <button type="button" class="kb-botao kb-botao-sec" data-acao="chk-com-cancelar">Cancelar</button></div>` : ''}
      </div>`);
    if (ch.comentando) setTimeout(() => $('kbChkCom') && $('kbChkCom').focus(), 0);
    navPasso(itemPronto(item));
  }

  // Dá para avançar? (o servidor confere de novo)
  function itemPronto(item) {
    lerCampos(item);
    const v = rascunhoDe(item);
    if (v.nao_tem) return true;
    for (const c of item.componentes) {
      if (c.tipo === 'estado' && c.obrigatorio && !v.estado) return false;
      if (c.tipo === 'estado' && v.estado === 'reparo' && c.descricao_se_reparo && String(v.descricao || '').trim().length < 3) return false;
      if (c.tipo === 'sim_nao' && c.obrigatorio && typeof v.sim !== 'boolean') return false;
      if (c.tipo === 'sim_nao' && c.texto_se_sim && v.sim === true && String(v.texto || '').trim().length < 3) return false;
      if (c.tipo === 'opcoes' && c.obrigatorio && !v.opcao) return false;
      if (c.tipo === 'texto' && c.obrigatorio && !String(v.texto || '').trim()) return false;
      if (c.tipo === 'medida' && c.obrigatorio && !(v.medidas && String(v.medidas[c.rotulo] ?? '').trim() !== '')) return false;
      if (c.tipo === 'foto' && c.obrigatorio && !fotoDe({ itemId: item.id })) return false;
    }
    return true;
  }

  // Copia o que está digitado na tela para o rascunho do item.
  function lerCampos(item) {
    const v = rascunhoDe(item);
    if ($('kbChkDesc')) v.descricao = $('kbChkDesc').value;
    if ($('kbChkTexto')) v.texto = $('kbChkTexto').value;
    if ($('kbChkCampoTexto')) v.texto = $('kbChkCampoTexto').value;
    document.querySelectorAll('#kbChkCorpo input[data-medida]').forEach((inp) => {
      v.medidas = { ...(v.medidas || {}) };
      if (inp.value.trim() === '') delete v.medidas[inp.dataset.medida];
      else v.medidas[inp.dataset.medida] = inp.value.trim();
    });
  }

  // ---------- peças defeituosas ----------
  // A lista muda a cada resposta "Necessita troca/reparo": recarrega do servidor ao abrir.
  async function renderPecas(p) {
    corpo('<p class="kb-dica">Carregando peças…</p>');
    nav(null);
    try { await carregarEstado(); } catch (e) { corpo(`<p class="kb-erro-inline">${esc(e.message)}</p>`); return; }
    if (!ch || ch.passos[ch.i].tipo !== 'pecas') return;
    const pecas = ch.estado.pecas;
    corpo(`<h2 class="kb-chk-pergunta">${esc(p.titulo)}</h2>
      <p class="kb-dica">Os itens marcados "Necessita troca/reparo" entram aqui sozinhos. Informe a descrição e o tempo de troca em horas.</p>
      <div class="kb-chk-pecas">${pecas.map((pc) => `<div class="kb-chk-peca" data-peca="${pc.id}">
          <small class="kb-dica">${pc.origem === 'automatica' ? `do item: ${esc(pc.item_texto || '')}` : 'adicionada pelo mecânico'}</small>
          <input type="text" data-campo="descricao" maxlength="300" placeholder="Descrição da peça/serviço" value="${esc(pc.descricao || '')}">
          <label class="kb-chk-horas"><input type="text" inputmode="decimal" data-campo="tempo" placeholder="0,0" value="${pc.tempo_troca_horas !== null && pc.tempo_troca_horas !== undefined ? esc(String(pc.tempo_troca_horas).replace('.', ',')) : ''}"> h</label>
          ${pc.origem === 'manual' ? `<button type="button" class="kb-link-pequeno" data-acao="chk-peca-remover" data-id="${pc.id}">remover</button>` : ''}
        </div>`).join('') || '<p class="kb-dica">Nenhuma peça defeituosa até agora.</p>'}</div>
      <button type="button" class="kb-botao kb-botao-sec" data-acao="chk-peca-nova">+ Adicionar peça</button>`);
    navPasso(true);
  }

  async function salvarPecas() {
    for (const el of document.querySelectorAll('.kb-chk-peca')) {
      const id = Number(el.dataset.peca);
      const atual = ch.estado.pecas.find((x) => x.id === id);
      const descricao = el.querySelector('[data-campo="descricao"]').value.trim();
      const tempo = el.querySelector('[data-campo="tempo"]').value.trim();
      const tempoAtual = atual.tempo_troca_horas === null || atual.tempo_troca_horas === undefined ? '' : String(atual.tempo_troca_horas).replace('.', ',');
      if (descricao === (atual.descricao || '') && tempo === tempoAtual) continue;
      await A().api(`/api/kanban/checklists/pecas/${id}`, { method: 'PUT', json: { descricao, tempo_troca_horas: tempo, operador: operador() } });
    }
  }

  // ---------- resumo e finalizar ----------
  async function renderResumo() {
    corpo('<p class="kb-dica">Conferindo…</p>');
    nav(null);
    try { await carregarEstado(); } catch (e) { corpo(`<p class="kb-erro-inline">${esc(e.message)}</p>`); return; }
    const enviando = ch.fila.length;
    // Fotos que estão na fila deste aparelho não contam como pendência: vão chegar.
    const naFila = (texto) => ch.passos.some((p) => (p.tipo === 'foto' || p.tipo === 'item') && texto === `Foto: ${p.item.texto}` && fotoDe({ itemId: p.item.id }))
      || (/^Foto da avaria (\d+)/.test(texto) && ch.fila.some((f) => f.vinculo.avaria_id && ch.estado.avarias.some((a) => a.id === f.vinculo.avaria_id && texto.startsWith(`Foto da avaria ${a.ordem} `))));
    const faltas = ch.estado.pendencias.filter((f) => !naFila(f));
    let linhas;
    if (ch.codigo === 'entrada') {
      const comb = ch.passos.find((p) => p.tipo === 'itens');
      linhas = `<li>📷 ${ch.passos.filter((p) => p.tipo === 'foto' && fotoDe({ itemId: p.item.id })).length} de ${ch.passos.filter((p) => p.tipo === 'foto').length} fotos</li>
        <li>⚠️ ${ch.estado.avarias.length ? `${ch.estado.avarias.length} avaria(s)` : (resposta(ch.passos.find((p) => p.tipo === 'avarias').item.id).sim === false ? 'Nenhuma avaria' : 'Avarias não respondidas')}</li>
        ${comb ? `<li>⛽ Combustível: ${esc(resposta(comb.itens[0].id).opcao || '—')}</li>` : ''}`;
    } else {
      const itens = ch.passos.filter((p) => p.tipo === 'item');
      const ruins = itens.filter((p) => ['troca', 'reparo'].includes(resposta(p.item.id).estado)).length;
      const horas = ch.estado.pecas.reduce((s, pc) => s + (pc.tempo_troca_horas || 0), 0);
      linhas = `<li>✔️ ${itens.filter((p) => itemRespondido(p.item)).length} de ${itens.length} itens respondidos</li>
        <li>🔧 ${ruins} item(ns) com troca/reparo · ${ch.estado.pecas.length} peça(s) · ${horas.toLocaleString('pt-BR')} h</li>`;
    }
    corpo(`<h2 class="kb-chk-pergunta">Conferir e finalizar</h2>
      <ul class="kb-chk-resumo">${linhas}<li>👤 Feito por ${esc(ch.estado.execucao.feito_por)}</li></ul>
      ${enviando ? `<p class="kb-aviso-inline">⬆️ Enviando ${enviando} arquivo(s). Pode finalizar: o checklist fecha sozinho quando o envio terminar.</p>` : ''}
      ${faltas.length ? `<div class="kb-erro-inline"><strong>Ainda falta:</strong><ul>${faltas.map((f) => `<li><button type="button" class="kb-link-pequeno" data-acao="chk-ir" data-texto="${esc(f)}">${esc(f)}</button></li>`).join('')}</ul></div>` : ''}
      ${ch.aguardandoEnvio ? '<p class="kb-dica">Aguardando o envio dos arquivos para finalizar…</p>' : ''}`);
    nav({ voltar: true, proximo: true, proximoOk: !faltas.length && !ch.aguardandoEnvio, proximoTexto: `✓ Finalizar ${ch.codigo === 'entrada' ? 'vistoria' : 'revisão'}` });
  }

  // "Ainda falta: X" → vai direto ao passo do item.
  function irParaPendencia(texto) {
    const idx = ch.passos.findIndex((p) => (p.item && texto.includes(p.item.texto)) || (p.tipo === 'pecas' && texto.startsWith('Peças defeituosas'))
      || (p.tipo === 'avarias' && /avaria/i.test(texto)) || (p.itens && p.itens.some((it) => texto.includes(it.texto))));
    if (idx >= 0) irPara(idx);
  }

  async function finalizar() {
    await atualizarFila();
    if (ch.fila.length) {
      ch.aguardandoEnvio = true; // M.aoConcluir chama de novo quando a fila deste checklist esvaziar
      renderResumo();
      return;
    }
    try {
      await A().api(`/api/kanban/checklists/${ch.execId}/finalizar`, { json: { operador: operador() } });
      ch.aguardandoEnvio = false;
      const nome = ch.codigo === 'entrada' ? 'Vistoria finalizada' : 'Revisão finalizada';
      const doc = ch.codigo === 'entrada' ? 'Vistoria de Entrada' : (ch.codigo === 'revisao_basica' ? 'Checklist de Revisão Básica' : 'Checklist de Revisão Completa');
      corpo(`<div class="kb-chk-fim"><div class="kb-chk-ok">✓</div><h2>${nome}</h2>
        <p>O PDF "${doc}" é gerado em instantes e aparece na linha do tempo do card.</p>
        <button type="button" class="kb-botao" data-acao="chk-fechar">Fechar</button></div>`);
      nav(null);
      $('kbChkProgresso').innerHTML = '<span style="width:100%"></span>';
    } catch (e) {
      ch.aguardandoEnvio = false;
      A().avisar(e.message, true);
      renderResumo();
    }
  }

  // ---------- finalizado: visualizar, editar, exportar PDF, link para o cliente ----------
  // Revisões: via cliente (sem peças/horas) e via orçamento (uso interno). Vistoria: via única.
  const NOME_VIA = { unica: 'PDF', cliente: 'Via cliente', orcamento: 'Via orçamento' };
  function blocoPdf() {
    const pdfs = ch.pdfs || [];
    const ultima = pdfs.length ? pdfs[0].versao : null;
    const atuais = pdfs.filter((p) => p.versao === ultima);
    const paraCliente = atuais.find((p) => p.via !== 'orcamento');
    const versoes = [...new Set(pdfs.map((p) => p.versao))];
    return `<div class="kb-acoes-card">
        ${atuais.length ? atuais.map((p) => `<a class="kb-botao ${p.via === 'orcamento' ? 'kb-botao-sec' : ''}" href="${esc(p.url)}" target="_blank" rel="noopener">📄 ${NOME_VIA[p.via] || 'PDF'}${versoes.length > 1 ? ` (v${p.versao})` : ''}</a>`).join('')
          : '<span class="kb-dica">PDF sendo gerado…</span>'}
        ${paraCliente ? `<button type="button" class="kb-botao kb-botao-sec" data-acao="chk-link-cliente" data-id="${paraCliente.id}">📤 Link para o cliente (7 dias)</button>` : ''}
        <button type="button" class="kb-botao kb-botao-sec" data-acao="chk-pdf">Exportar PDF de novo</button>
      </div>
      <div id="kbChkLink"></div>
      ${atuais.some((p) => p.via === 'orcamento') ? '<p class="kb-dica">A via orçamento tem as peças e os tempos de troca: é de uso interno. Para o cliente vai a via cliente.</p>' : ''}
      ${versoes.length > 1 ? `<details><summary class="kb-dica">Versões anteriores do PDF</summary><ul>${versoes.map((v) => {
        const daVersao = pdfs.filter((p) => p.versao === v);
        return `<li>Versão ${v} · ${A().dataBR(daVersao[0].gerado_em)} · ${esc(daVersao[0].gerado_por)}: ${daVersao.map((p) => `<a href="${esc(p.url)}" target="_blank" rel="noopener">${NOME_VIA[p.via] || 'PDF'}</a>`).join(' · ')}</li>`;
      }).join('')}</ul></details>` : ''}
      <p class="kb-dica">Depois de editar, toque em "Exportar PDF de novo" para gerar a versão atualizada.</p>`;
  }

  function telaVisualizar() {
    ch.edicao = false;
    ch.rascunho = {};
    const e = ch.estado.execucao;
    const cab = `<p class="kb-dica">Feito por <strong>${esc(e.feito_por)}</strong> · ${A().dataBR(e.iniciado_em)} a ${A().dataBR(e.finalizado_em)}</p>${blocoPdf()}`;
    $('kbChkProgresso').innerHTML = '';
    nav(null);
    if (ch.codigo === 'entrada') return visualizarEntrada(cab);

    let secaoAtual = null;
    const linhas = ch.passos.map((p, idx) => {
      if (p.tipo === 'pecas') {
        const total = ch.estado.pecas.reduce((s, pc) => s + (pc.tempo_troca_horas || 0), 0);
        return `<h3 class="kb-sec">${esc(p.titulo)} <button type="button" class="kb-link-pequeno" data-acao="chk-editar" data-passo="${idx}">editar</button></h3>
          ${ch.estado.pecas.length ? `<ul>${ch.estado.pecas.map((pc) => `<li>${esc(pc.descricao || '—')} · ${pc.tempo_troca_horas ?? '—'} h</li>`).join('')}</ul><p>Total: <strong>${total.toLocaleString('pt-BR')} h</strong></p>` : '<p>Nenhuma peça defeituosa.</p>'}`;
      }
      if (p.tipo !== 'item') return '';
      const cabecalho = p.secao.titulo !== secaoAtual ? `<h3 class="kb-sec">${esc(p.secao.titulo)}</h3>` : '';
      secaoAtual = p.secao.titulo;
      const r = ch.estado.respostas[p.item.id] || {};
      const qtd = anexosDoItem(p.item).length;
      return `${cabecalho}<div class="kb-chk-ver">
        <span>${p.n ? `${p.n}. ` : ''}${esc(p.item.texto)}</span>
        <span>${resumoHtml(p.item, r.valor || {})}${qtd ? ` · 📎 ${qtd}` : ''}${r.alteracoes ? ` · <em>alterado</em>` : ''}
          <button type="button" class="kb-link-pequeno" data-acao="chk-editar" data-passo="${idx}">editar</button></span></div>`;
    }).join('');
    corpo(cab + linhas);
  }

  function resumoHtml(item, v) {
    if (item.componentes.every((c) => c.tipo === 'foto')) return fotoDe({ itemId: item.id }) ? '<strong>Foto registrada</strong>' : '<em>sem foto</em>';
    if (!v || !Object.keys(v).length) return '<em>sem resposta</em>';
    if (v.nao_tem) return '<span class="kb-tag kb-tag-nt">Não tem</span>';
    const partes = [];
    for (const c of item.componentes) {
      if (c.tipo === 'estado' && v.estado) partes.push(`<span class="kb-tag kb-tag-${v.estado}">${(ESTADOS[c.escala] || ESTADOS.troca).find(([k]) => k === v.estado)[1]}</span>`);
      if (c.tipo === 'sim_nao' && typeof v.sim === 'boolean') partes.push(`<strong>${esc((c.rotulos || ['Sim', 'Não'])[v.sim ? 0 : 1])}</strong>`);
      if (c.tipo === 'medida' && v.medidas && v.medidas[c.rotulo] !== undefined) partes.push(`${esc(c.rotulo)} ${esc(String(v.medidas[c.rotulo]).replace('.', ','))} ${esc(c.unidade || '')}`);
      if ((c.tipo === 'opcoes' && v.opcao)) partes.push(esc(v.opcao));
      if (c.tipo === 'texto' && v.texto) partes.push(esc(v.texto));
    }
    return partes.join(' · ');
  }

  function visualizarEntrada(cab) {
    const fotos = ch.passos.map((p, idx) => ({ p, idx })).filter(({ p }) => p.tipo === 'foto');
    const iAv = ch.passos.findIndex((p) => p.tipo === 'avarias');
    const iIt = ch.passos.findIndex((p) => p.tipo === 'itens');
    const pAv = ch.passos[iAv];
    const pIt = ch.passos[iIt];
    const km = (resposta(fotos[0].p.item.id).medidas || {}).KM;
    corpo(`${cab}${km !== undefined ? `<p>KM na entrada: <strong>${Number(km).toLocaleString('pt-BR')}</strong></p>` : ''}
      <div class="kb-chk-grade">${fotos.map(({ p, idx }) => {
        const f = fotoDe({ itemId: p.item.id });
        return `<figure>${f ? `<img src="${esc(f.url)}" alt="">` : '<div class="kb-chk-semfoto">sem foto</div>'}<figcaption>${p.n}. ${esc(p.item.texto)}
          <button type="button" class="kb-link-pequeno" data-acao="chk-editar" data-passo="${idx}">editar</button></figcaption></figure>`;
      }).join('')}</div>
      <h3 class="kb-sec">Avarias <button type="button" class="kb-link-pequeno" data-acao="chk-editar" data-passo="${iAv}">editar</button></h3>
      ${ch.estado.avarias.length ? `<ul class="kb-chk-avarias">${ch.estado.avarias.map((a) => {
        const f = fotoDe({ avariaId: a.id });
        return `<li class="kb-chk-avaria">${f ? `<img src="${esc(f.url)}" alt="">` : ''}<div><strong>${a.ordem}. ${esc(a.regiao)}</strong><br>${esc(a.descricao)}</div></li>`;
      }).join('')}</ul>` : `<p>${resposta(pAv.item.id).sim === false ? 'Nenhuma avaria identificada' : '—'}</p>`}
      ${pIt ? `<h3 class="kb-sec">Combustível e itens <button type="button" class="kb-link-pequeno" data-acao="chk-editar" data-passo="${iIt}">editar</button></h3>
        <p>Combustível: <strong>${esc(resposta(pIt.itens[0].id).opcao || '—')}</strong><br>
        Itens: ${esc((resposta(pIt.itens[1].id).marcados || []).join(', ') || 'nenhum marcado')}</p>` : ''}`);
  }

  async function voltarParaVisualizar() {
    await carregarEstado();
    const lista = await A().api(`/api/kanban/cards/${ch.cardId}/checklists`);
    ch.pdfs = (lista.find((x) => x.id === ch.execId) || {}).pdfs || [];
    telaVisualizar();
  }

  async function exportarPdf(botao) {
    const op = await A().garantirOperador();
    if (!op) return;
    botao.disabled = true;
    botao.textContent = 'Gerando PDF…';
    try {
      await A().api(`/api/kanban/checklists/${ch.execId}/pdf`, { json: { operador: op } });
      A().avisar('PDF gerado');
      await voltarParaVisualizar();
    } catch (e) {
      A().avisar(e.message, true);
      botao.disabled = false;
      botao.textContent = 'Exportar PDF de novo';
    }
  }

  async function linkCliente(pdfId) {
    const op = await A().garantirOperador();
    if (!op) return;
    try {
      const l = await A().api(`/api/kanban/pdfs/${pdfId}/link`, { json: { operador: op } });
      let copiado = false;
      try { await navigator.clipboard.writeText(l.url); copiado = true; } catch (_) { /* sem área de transferência */ }
      $('kbChkLink').innerHTML = `<div class="kb-aviso-inline">${copiado ? 'Link copiado. ' : ''}Válido até ${A().dataBR(l.expira_em)}:<br>
        <input type="text" readonly value="${esc(l.url)}" style="width:100%;font-size:14px;margin-top:6px" onfocus="this.select()"></div>`;
    } catch (e) { A().avisar(e.message, true); }
  }

  // ---------- fotos e anexos ----------
  async function arquivoCapturado(arquivo, alvo) {
    if (!arquivo || !ch) return;
    if (alvo.avaria) {
      const preparado = await M.prepararFoto(arquivo);
      if (ch.avaria && ch.avaria.url) URL.revokeObjectURL(ch.avaria.url);
      ch.avaria = { ...(ch.avaria || {}), preparado, url: URL.createObjectURL(preparado.miniatura || preparado.blob) };
      ch.sub = 'form';
      render();
      return;
    }
    let preparado;
    try {
      preparado = alvo.video ? await M.prepararVideo(arquivo) : await M.prepararFoto(arquivo);
    } catch (e) { A().avisar(e.message, true); return; }
    if (preparado.aviso) A().avisar(preparado.aviso);
    await M.enfileirar({
      cardId: ch.cardId, preparado, operador: operador(),
      vinculo: { checklist_execucao_id: ch.execId, checklist_item_id: alvo.itemId },
    });
    if (!alvo.video && alvo.principal) {
      const chave = `i${alvo.itemId}`;
      if (ch.local[chave]) URL.revokeObjectURL(ch.local[chave]);
      ch.local[chave] = URL.createObjectURL(preparado.miniatura || preparado.blob);
    }
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
    const r = await A().api(`/api/kanban/checklists/${ch.execId}/respostas/${itemId}`, { method: 'PUT', json: { valor, operador: operador() } });
    ch.estado.respostas[itemId] = { ...(ch.estado.respostas[itemId] || {}), valor: r.valor };
    delete ch.rascunho[itemId];
  }

  // Avança; se o próximo passo é foto sem foto, abre a câmera direto (ainda dentro do toque).
  function irPara(i, { abrirCamera = false } = {}) {
    ch.i = Math.max(0, Math.min(ch.passos.length - 1, i));
    ch.comentando = false;
    render();
    const p = ch.passos[ch.i];
    if (abrirCamera && p.tipo === 'foto' && !fotoDe({ itemId: p.item.id })) {
      ch.alvoFoto = { itemId: p.item.id, principal: true }; // a foto que voltar da câmera é deste item
      $('kbInChk').click();
    }
  }

  // Depois de salvar um passo: no modo edição volta para a visão do checklist finalizado.
  async function depoisDeSalvar(proximo, opts) {
    if (ch.edicao) { A().avisar('Alteração salva'); await voltarParaVisualizar(); return; }
    irPara(proximo, opts);
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
      case 'chk-camera': ch.alvoFoto = { itemId: p.item.id, principal: true }; $('kbInChk').click(); break;
      case 'chk-anexo-foto': lerCampos(p.item); ch.alvoFoto = { itemId: p.item.id }; $('kbInChk').click(); break;
      case 'chk-anexo-video': lerCampos(p.item); ch.alvoFoto = { itemId: p.item.id, video: true }; $('kbInChkVideo').click(); break;
      case 'chk-anexo-com': lerCampos(p.item); ch.comentando = true; render(); break;
      case 'chk-com-cancelar': lerCampos(p.item); ch.comentando = false; render(); break;
      case 'chk-com-salvar': {
        const texto = ($('kbChkCom').value || '').trim();
        if (!texto) break;
        lerCampos(p.item);
        try {
          await A().api(`/api/kanban/checklists/${ch.execId}/itens/${p.item.id}/comentarios`, { json: { texto, operador: operador() } });
          ch.comentando = false;
          const rasc = ch.rascunho;
          await carregarEstado();
          ch.rascunho = rasc;
          render();
        } catch (e) { A().avisar(e.message, true); }
        break;
      }
      case 'chk-com-remover':
      case 'chk-midia-remover': {
        lerCampos(p.item);
        const url = b.dataset.acao === 'chk-com-remover' ? `/api/kanban/checklists/comentarios/${b.dataset.id}/remover` : `/api/kanban/checklists/midias/${b.dataset.id}/remover`;
        try {
          await A().api(url, { json: { operador: operador() } });
          const rasc = ch.rascunho;
          await carregarEstado();
          ch.rascunho = rasc;
          render();
        } catch (e) { A().avisar(e.message, true); }
        break;
      }
      case 'chk-ver-foto': window.open(b.dataset.url, '_blank', 'noopener'); break;
      case 'chk-estado': {
        lerCampos(p.item);
        const v = rascunhoDe(p.item);
        v.estado = b.dataset.valor;
        delete v.nao_tem;
        if (v.estado !== 'reparo' && v.estado !== 'troca') delete v.descricao;
        render();
        break;
      }
      case 'chk-sim': {
        lerCampos(p.item);
        const v = rascunhoDe(p.item);
        v.sim = b.dataset.valor === '1';
        delete v.nao_tem;
        if (!v.sim) delete v.texto;
        render();
        break;
      }
      case 'chk-item-opcao': { lerCampos(p.item); rascunhoDe(p.item).opcao = b.dataset.valor; render(); break; }
      case 'chk-nt': {
        lerCampos(p.item);
        const v = rascunhoDe(p.item);
        if (v.nao_tem) delete v.nao_tem;
        else { for (const k of Object.keys(v)) delete v[k]; v.nao_tem = true; }
        render();
        break;
      }
      case 'chk-voltar':
        if (p && p.tipo === 'avarias' && ch.sub === 'form') { ch.sub = 'pergunta'; render(); break; }
        if (ch.edicao) { await voltarParaVisualizar(); break; }
        irPara(ch.i - 1);
        break;
      case 'chk-proximo': {
        b.disabled = true;
        try {
          if (p.tipo === 'foto') {
            const m = medida(p.item);
            if (m) {
              await salvarResposta(p.item.id, { medidas: { [m.rotulo]: $('kbChkMedida').value.trim() } });
              await depoisDeSalvar(ch.i + 1); // depois de esperar a rede o navegador não deixa abrir a câmera sozinho
            } else {
              await depoisDeSalvar(ch.i + 1, { abrirCamera: true });
            }
          } else if (p.tipo === 'itens') {
            for (const it of p.itens) {
              const grupo = document.querySelector(`.kb-chk-opcoes[data-item="${it.id}"]`);
              const marcados = [...grupo.querySelectorAll('button[aria-pressed="true"]')].map((x) => x.dataset.valor);
              await salvarResposta(it.id, grupo.dataset.tipo === 'opcoes' ? { opcao: marcados[0] } : { marcados });
            }
            await depoisDeSalvar(ch.i + 1);
          } else if (p.tipo === 'item') {
            lerCampos(p.item);
            await salvarResposta(p.item.id, rascunhoDe(p.item));
            await depoisDeSalvar(ch.i + 1);
          } else if (p.tipo === 'pecas') {
            await salvarPecas();
            await carregarEstado();
            await depoisDeSalvar(ch.i + 1);
          } else if (p.tipo === 'resumo') {
            await finalizar();
          }
        } catch (e) {
          A().avisar(e.message, true);
          if (b.isConnected) b.disabled = false;
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
          await depoisDeSalvar(ch.i + 1);
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
      case 'chk-peca-nova':
        try {
          await salvarPecas();
          await A().api(`/api/kanban/checklists/${ch.execId}/pecas`, { json: { descricao: '', operador: operador() } });
          await carregarEstado();
          render();
          const campos = document.querySelectorAll('.kb-chk-peca [data-campo="descricao"]');
          if (campos.length) campos[campos.length - 1].focus();
        } catch (e) { A().avisar(e.message, true); }
        break;
      case 'chk-peca-remover':
        try {
          await salvarPecas();
          await A().api(`/api/kanban/checklists/pecas/${b.dataset.id}/remover`, { json: { operador: operador() } });
          await carregarEstado();
          render();
        } catch (e) { A().avisar(e.message, true); }
        break;
      case 'chk-ir': irParaPendencia(b.dataset.texto); break;
      case 'chk-editar': {
        const op = await A().garantirOperador();
        if (!op) break;
        ch.edicao = true;
        ch.rascunho = {};
        ch.sub = 'pergunta';
        ch.i = Number(b.dataset.passo);
        render();
        break;
      }
      case 'chk-pdf': await exportarPdf(b); break;
      case 'chk-link-cliente': await linkCliente(b.dataset.id); break;
      default: break;
    }
  });
  $('kbChk').addEventListener('input', (ev) => {
    if (!ch || !ch.passos) return;
    const p = ch.passos[ch.i];
    if (ev.target.id === 'kbChkMedida') atualizarNavFoto(p);
    else if (p && p.tipo === 'item') navPasso(itemPronto(p.item));
  });
  for (const id of ['kbInChk', 'kbInChkVideo']) {
    $(id).addEventListener('change', (ev) => {
      const arq = ev.target.files[0];
      ev.target.value = '';
      if (!ch || !arq) return;
      arquivoCapturado(arq, ch.alvoFoto || {});
    });
  }

  // Quando a fila deste checklist esvaziar e o mecânico já pediu para finalizar, finaliza.
  M.aoConcluir(async (item) => {
    if (!ch || !item.vinculo || item.vinculo.checklist_execucao_id !== ch.execId) return;
    await atualizarFila();
    if (ch.aguardandoEnvio && !ch.fila.length) { ch.aguardandoEnvio = false; finalizar(); return; }
    // um anexo terminou de subir: atualiza a tela do item (sem perder o que foi digitado)
    const p = ch.passos && ch.passos[ch.i];
    if (p && p.tipo === 'item' && !ch.comentando) {
      lerCampos(p.item);
      const rasc = ch.rascunho;
      await carregarEstado();
      ch.rascunho = rasc;
      render();
    }
  });

  window.KanbanChecklist = { abrir, fechar };
})();
