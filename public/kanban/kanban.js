// Kanban de OS — Etapa 2: mover (arrastar no PC, "Mover para…" no card), arquivar,
// desarquivar, mecânico responsável, busca (ativos/arquivados) e filtros.
(() => {
  const $ = (id) => document.getElementById(id);
  const TZ = 'America/Sao_Paulo';
  const DIA_MS = 86_400_000;
  const VELHO_DIAS = 5;

  // ---------- armazenamento local (pode não existir em aba anônima) ----------
  const guardar = (area, k, v) => { try { (area === 's' ? sessionStorage : localStorage).setItem(k, v); } catch (_) { /* sem storage */ } };
  const ler = (area, k) => { try { return (area === 's' ? sessionStorage : localStorage).getItem(k); } catch (_) { return null; } };
  const apagar = (area, k) => { try { (area === 's' ? sessionStorage : localStorage).removeItem(k); } catch (_) { /* sem storage */ } };

  let estado = null;
  let faseEscolhida = Number(ler('s', 'kb.fase')) || null; // celular: aba escolhida
  let faseAtiva = faseEscolhida || 1;
  let filtroMecanico = ler('s', 'kb.filtroMecanico') || '';
  let filtroFase = ler('s', 'kb.filtroFase') || '';
  let modoBusca = 'ativos';
  let cardAberto = null; // { id, card } do painel
  let operador = ler('l', 'kb.operador') || '';

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtData = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const fmtHora = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dataBR = (iso) => (iso ? fmtData.format(new Date(iso)).replace(',', '') : '—');
  const horaBR = (iso) => (iso ? fmtHora.format(new Date(iso)) : '');
  const primeiro = (s) => String(s || '').trim().split(/\s+/)[0] || '';

  function tempoNaFase(iso, agora) {
    const ms = Math.max(0, agora - Date.parse(iso));
    const dias = Math.floor(ms / DIA_MS);
    if (dias >= 1) return { texto: `${dias} d`, dias };
    const horas = Math.floor(ms / 3_600_000);
    return { texto: horas >= 1 ? `${horas} h` : 'agora', dias: 0 };
  }

  async function api(caminho, opts = {}) {
    const init = { credentials: 'same-origin', ...opts };
    if (opts.json !== undefined) {
      init.method = init.method || 'POST';
      init.headers = { 'Content-Type': 'application/json' };
      init.body = JSON.stringify(opts.json);
      delete init.json;
    }
    const r = await fetch(caminho, init);
    if (r.status === 401) { location.href = '/login'; throw new Error('sessão expirada'); }
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(corpo.erro || `erro ${r.status}`), { status: r.status, corpo });
    return corpo;
  }

  // ---------- aviso rápido ----------
  let avisoTimer = null;
  function avisar(texto, erro = false) {
    const el = $('kbAviso');
    el.textContent = texto;
    el.classList.toggle('kb-aviso-erro', erro);
    el.hidden = false;
    clearTimeout(avisoTimer);
    avisoTimer = setTimeout(() => { el.hidden = true; }, erro ? 6000 : 3500);
  }

  // ---------- operador do aparelho ----------
  function mostrarOperador() {
    $('kbOperadorNome').textContent = operador || 'Quem é você?';
  }

  let resolverOperador = null;
  async function abrirModalOperador() {
    let nomes = [];
    try { nomes = await api('/api/kanban/operadores'); } catch (_) { /* segue com o campo livre */ }
    $('kbListaOperadores').innerHTML = nomes.map((n) =>
      `<button type="button" data-nome="${esc(n)}" aria-pressed="${n === operador}">${esc(primeiro(n))}</button>`).join('');
    $('kbOperadorLivre').value = nomes.includes(operador) ? '' : operador;
    $('kbModalOperador').hidden = false;
    return new Promise((res) => { resolverOperador = res; });
  }
  function fecharModalOperador(nome) {
    $('kbModalOperador').hidden = true;
    if (resolverOperador) resolverOperador(nome || null);
    resolverOperador = null;
  }
  // Antes de qualquer registro: se o aparelho ainda não tem operador, pergunta.
  async function garantirOperador() {
    if (operador) return operador;
    const nome = await abrirModalOperador();
    return nome || null;
  }

  $('kbListaOperadores').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-nome]');
    if (!b) return;
    definirOperador(b.dataset.nome);
    fecharModalOperador(operador);
  });
  $('kbFormOperador').addEventListener('submit', (ev) => {
    ev.preventDefault();
    const nome = $('kbOperadorLivre').value.replace(/\s+/g, ' ').trim();
    if (!nome) { $('kbOperadorLivre').focus(); return; }
    definirOperador(nome);
    fecharModalOperador(operador);
  });
  $('kbOperadorCancelar').addEventListener('click', () => fecharModalOperador(null));
  $('kbOperador').addEventListener('click', () => abrirModalOperador());

  function definirOperador(nome) {
    operador = nome;
    if (nome) guardar('l', 'kb.operador', nome); else apagar('l', 'kb.operador');
    mostrarOperador();
  }

  // ---------- quadro ----------
  function passaFiltros(c) {
    if (filtroMecanico === 'sem') { if (c.mecanico_id) return false; } else if (filtroMecanico && String(c.mecanico_id) !== filtroMecanico) return false;
    return true;
  }

  function cardHtml(c, agora) {
    const t = tempoNaFase(c.fase_desde, agora);
    const velho = t.dias > VELHO_DIAS;
    const veiculo = [c.marca, c.modelo].filter(Boolean).join(' ');
    return `<div class="kb-card${velho ? ' kb-velho' : ''}" role="button" tabindex="0" draggable="true" data-id="${c.id}" data-fase="${c.fase_id}"
        aria-label="OS ${esc(c.os_numero)}, ${esc(c.placa || '')}, ${t.texto} nesta fase">
      <div class="kb-card-l1">
        <span class="kb-os">OS ${esc(c.os_numero)}</span>
        ${c.placa ? `<span class="kb-placa">${esc(c.placa)}</span>` : ''}
        <span class="kb-tempo" title="Tempo nesta fase">${t.texto}</span>
      </div>
      <div class="kb-card-l2">${esc(veiculo || 'Veículo sem modelo')}${c.ano ? ` · ${esc(c.ano)}` : ''}</div>
      <div class="kb-card-l3">
        <span>${esc(c.primeiro_nome || 'Cliente')}</span>
        ${c.mecanico_nome ? `<span>🔧 ${esc(primeiro(c.mecanico_nome))}</span>` : ''}
        ${c.qtd_midias ? `<span title="Fotos, vídeos e áudios">📎 ${c.qtd_midias}</span>` : ''}
        ${c.vistoria_status === 'finalizado' ? '<span title="Vistoria de entrada feita">📋✓</span>' : ''}
        ${c.vistoria_status === 'em_andamento' ? '<span title="Vistoria de entrada em andamento">📋…</span>' : ''}
      </div>
      ${c.os_finalizada_em ? '<span class="kb-selo kb-selo-fin">OS finalizada no Onmotor</span>' : ''}
      ${!c.os_finalizada_em && c.os_sumiu_em ? '<span class="kb-selo kb-selo-sumiu">Saiu da Novidades do Onmotor</span>' : ''}
    </div>`;
  }

  function render() {
    const agora = Date.now();
    const visiveis = estado.cards.filter(passaFiltros);
    const porFase = new Map(estado.fases.map((f) => [f.id, []]));
    for (const c of visiveis) (porFase.get(c.fase_id) || []).push(c);
    // Filtro de fase só no PC; no celular as abas já mostram uma fase por vez.
    const noPC = window.matchMedia('(min-width: 900px)').matches;
    const fases = estado.fases.filter((f) => !noPC || !filtroFase || String(f.id) === filtroFase);

    $('kbAbas').innerHTML = estado.fases.map((f) =>
      `<button type="button" class="kb-aba" role="tab" data-fase="${f.id}" aria-selected="${f.id === faseAtiva}">
        ${f.id}. ${esc(f.nome)}<span class="kb-n">${porFase.get(f.id).length}</span></button>`).join('');

    $('kbQuadro').innerHTML = fases.map((f) => {
      const lista = porFase.get(f.id);
      return `<section class="kb-coluna${f.id === faseAtiva ? ' kb-ativa' : ''}" data-fase="${f.id}" aria-label="${esc(f.nome)}">
        <div class="kb-coluna-topo"><span>${f.id}. ${esc(f.nome)}</span><span class="kb-n">${lista.length}</span></div>
        <div class="kb-lista">${lista.length ? lista.map((c) => cardHtml(c, agora)).join('') : '<p class="kb-vazio">Nenhum card nesta fase.</p>'}</div>
      </section>`;
    }).join('');

    const ativa = $('kbAbas').querySelector('[aria-selected="true"]');
    if (ativa && getComputedStyle($('kbAbas')).display !== 'none') ativa.scrollIntoView({ block: 'nearest', inline: 'center' });
    renderSync();
  }

  function preencherFiltros() {
    const selM = $('kbFiltroMecanico');
    selM.innerHTML = '<option value="">Todos os mecânicos</option><option value="sem">Sem mecânico</option>' +
      estado.mecanicos.map((m) => `<option value="${m.id}">${esc(primeiro(m.nome))}</option>`).join('');
    selM.value = filtroMecanico;
    if (selM.value !== filtroMecanico) { filtroMecanico = ''; selM.value = ''; }
    const selF = $('kbFiltroFase');
    selF.innerHTML = '<option value="">Todas</option>' + estado.fases.map((f) => `<option value="${f.id}">${f.id}. ${esc(f.nome)}</option>`).join('');
    selF.value = filtroFase;
  }

  function renderSync() {
    const s = estado.sync;
    $('kbFonte').hidden = estado.fonte !== 'mock';
    $('kbUltimaSync').textContent = s.ultima_ok_em ? `Lido às ${horaBR(s.ultima_ok_em)}` : '';
    $('kbUltimaSync').title = 'Última leitura do Onmotor';
    const b = $('kbBanner');
    b.classList.remove('kb-banner-info');
    if (s.parada) {
      const desde = s.parada_desde ? horaBR(s.parada_desde) : '—';
      const dia = s.parada_desde && dataBR(s.parada_desde).slice(0, 10) !== dataBR(new Date().toISOString()).slice(0, 10)
        ? ` de ${dataBR(s.parada_desde).slice(0, 10)}` : '';
      b.innerHTML = `Sincronização com Onmotor parada desde ${desde}${dia}` + (s.ultimo_erro ? `<small>${esc(s.ultimo_erro)}</small>` : '');
      b.hidden = false;
    } else if (!estado.fonte_configurada) {
      b.classList.add('kb-banner-info');
      b.textContent = 'Leitura automática do Onmotor desligada: faltam as credenciais da conta de automação no servidor.';
      b.hidden = false;
    } else if (s.nunca_sincronizou) {
      b.classList.add('kb-banner-info');
      b.textContent = 'O Onmotor ainda não foi lido. Clique em "Sincronizar agora" para importar as OS abertas.';
      b.hidden = false;
    } else {
      b.hidden = true;
    }
  }

  async function carregar() {
    try {
      estado = await api('/api/kanban/estado');
      if (!faseEscolhida) {
        const comCard = estado.fases.find((f) => estado.cards.some((c) => c.fase_id === f.id));
        faseAtiva = comCard ? comCard.id : 1;
      }
      if (!estado.fases.some((f) => f.id === faseAtiva)) faseAtiva = 1;
      preencherFiltros();
      render();
      if (buscando()) buscarAgora();
    } catch (e) {
      $('kbQuadro').innerHTML = `<p class="kb-vazio">Não consegui carregar o kanban: ${esc(e.message)}</p>`;
    }
  }

  // ---------- ações ----------
  async function mover(id, faseId, faseAtual) {
    const op = await garantirOperador();
    if (!op) return null;
    try {
      const r = await api(`/api/kanban/cards/${id}/mover`, { json: { fase_id: faseId, fase_atual: faseAtual, operador: op } });
      if (r.arquivado) avisar(`OS ${r.card.os_numero} arquivada: a OS já estava finalizada no Onmotor`);
      else if (r.movido) avisar(`OS ${r.card.os_numero} → ${r.card.fase_nome}`);
      await carregar();
      return r;
    } catch (e) {
      avisar(e.message, true);
      await carregar();
      return null;
    }
  }

  async function arquivar(id) {
    const op = await garantirOperador();
    if (!op) return;
    try {
      const r = await api(`/api/kanban/cards/${id}/arquivar`, { json: { operador: op } });
      avisar(`OS ${r.card.os_numero} arquivada`);
      fecharCard();
      await carregar();
    } catch (e) { avisar(e.message, true); }
  }

  async function desarquivar(id) {
    const op = await garantirOperador();
    if (!op) return;
    try {
      const r = await api(`/api/kanban/cards/${id}/desarquivar`, { json: { operador: op } });
      avisar(`OS ${r.card.os_numero} voltou para ${r.card.fase_nome}`);
      await carregar();
      abrirCard(id);
    } catch (e) { avisar(e.message, true); }
  }

  async function trocarMecanico(id, valor) {
    const op = await garantirOperador();
    if (!op) { abrirCard(id); return; }
    try {
      await api(`/api/kanban/cards/${id}/mecanico`, { method: 'PUT', json: { mecanico_id: valor === '' ? null : Number(valor), operador: op } });
      avisar('Mecânico atualizado');
      await carregar();
      abrirCard(id);
    } catch (e) { avisar(e.message, true); }
  }

  // ---------- arrastar e soltar (PC) ----------
  let arrastado = null;
  $('kbQuadro').addEventListener('dragstart', (ev) => {
    const card = ev.target.closest('.kb-card');
    if (!card) return;
    arrastado = { id: Number(card.dataset.id), fase: Number(card.dataset.fase) };
    card.classList.add('kb-arrastando');
    ev.dataTransfer.effectAllowed = 'move';
    ev.dataTransfer.setData('text/plain', card.dataset.id);
  });
  $('kbQuadro').addEventListener('dragend', (ev) => {
    const card = ev.target.closest('.kb-card');
    if (card) card.classList.remove('kb-arrastando');
    document.querySelectorAll('.kb-alvo').forEach((el) => el.classList.remove('kb-alvo'));
  });
  $('kbQuadro').addEventListener('dragover', (ev) => {
    const col = ev.target.closest('.kb-coluna');
    if (!col || !arrastado) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    document.querySelectorAll('.kb-alvo').forEach((el) => { if (el !== col) el.classList.remove('kb-alvo'); });
    col.classList.add('kb-alvo');
  });
  $('kbQuadro').addEventListener('drop', async (ev) => {
    const col = ev.target.closest('.kb-coluna');
    if (!col || !arrastado) return;
    ev.preventDefault();
    col.classList.remove('kb-alvo');
    const destino = Number(col.dataset.fase);
    const { id, fase } = arrastado;
    arrastado = null;
    if (destino !== fase) await mover(id, destino, fase);
  });

  // ---------- painel do card ----------
  // Estado do painel: modo (mover/arquivar), compositor (texto/mídia/gravação), edição e
  // confirmação de remoção na linha do tempo. A linha do tempo, os envios pendentes e o
  // compositor têm contêineres próprios: recarregar um não apaga o que está sendo digitado no outro.
  const M = window.KanbanMidia;
  let refrescoUrls = null;

  async function abrirCard(id) {
    const mesmo = cardAberto && cardAberto.id === Number(id);
    if (!mesmo) cardAberto = { id: Number(id), card: null, modo: null, compositor: null, editando: null, removendo: null, versoes: {} };
    if ($('kbPainel').hidden) history.pushState({ kb: 'card' }, '');
    if (!mesmo) {
      $('kbPainelTitulo').textContent = 'Carregando…';
      $('kbPainelCorpo').innerHTML = '';
    }
    $('kbPainel').hidden = false;
    $('kbVeu').hidden = false;
    document.body.style.overflow = 'hidden';
    try {
      const dados = await api(`/api/kanban/cards/${id}`);
      if (!cardAberto || cardAberto.id !== Number(id)) return;
      cardAberto.card = dados.card;
      cardAberto.eventos = dados.eventos;
      if (mesmo && $('kbLinhaTempo')) {
        renderCabecalho();
        renderLinhaTempo();
        if (!cardAberto.compositor) renderCompositor(); // não redesenha o que está sendo digitado/gravado
      } else renderPainel();
      carregarChecklists();
    } catch (e) {
      $('kbPainelCorpo').innerHTML = `<p class="kb-vazio">${esc(e.message)}</p>`;
    }
    // As URLs das mídias valem 15 min: com o painel aberto, renova a cada 10 min.
    clearInterval(refrescoUrls);
    refrescoUrls = setInterval(() => { if (cardAberto && !cardAberto.editando) abrirCard(cardAberto.id); }, 10 * 60_000);
  }

  function renderPainel() {
    $('kbPainelCorpo').innerHTML = `
      <div id="kbCabecalho"></div>
      <div id="kbChecklists"></div>
      <div id="kbCompositor"></div>
      <h3 class="kb-sec">Linha do tempo</h3>
      <ul id="kbPendentes" class="kb-pendentes"></ul>
      <ul id="kbLinhaTempo" class="kb-tempo-linha"></ul>
      <div id="kbDadosOnmotor"></div>`;
    renderCabecalho();
    renderCompositor();
    renderLinhaTempo();
    M.listarItens().then(renderPendentes);
  }

  // ---------- checklists do card (Etapa 4: vistoria de entrada) ----------
  async function carregarChecklists() {
    if (!cardAberto) return;
    const id = cardAberto.id;
    try {
      const lista = await api(`/api/kanban/cards/${id}/checklists`);
      if (!cardAberto || cardAberto.id !== id) return;
      cardAberto.checklists = lista;
      renderChecklists();
    } catch (_) { /* o painel funciona sem a lista */ }
  }

  function renderChecklists() {
    const el = $('kbChecklists');
    if (!el || !cardAberto || !cardAberto.checklists) return;
    const c = cardAberto.card;
    const vistoria = cardAberto.checklists.find((x) => x.codigo === 'entrada');
    let situacao = 'não feita';
    let botao = 'Fazer vistoria';
    if (vistoria && vistoria.status === 'em_andamento') { situacao = `em andamento (${esc(primeiro(vistoria.feito_por))})`; botao = 'Continuar'; }
    if (vistoria && vistoria.status === 'finalizado') { situacao = `feita por ${esc(primeiro(vistoria.feito_por))} em ${dataBR(vistoria.finalizado_em)}`; botao = 'Ver'; }
    const pdfAtual = vistoria && vistoria.pdfs[0];
    const podeAbrir = !c.arquivado_em || (vistoria && vistoria.status === 'finalizado');
    el.innerHTML = `<div class="kb-checklists">
        <div class="kb-chk-linha">
          <span>📋 <strong>Vistoria de entrada</strong> <small>${situacao}</small></span>
          ${podeAbrir ? `<button type="button" class="kb-botao ${vistoria && vistoria.status === 'finalizado' ? 'kb-botao-sec' : ''}" data-acao="abrir-checklist" data-codigo="entrada">${botao}</button>` : ''}
        </div>
        ${pdfAtual && pdfAtual.url ? `<a class="kb-link-pequeno" href="${esc(pdfAtual.url)}" target="_blank" rel="noopener">📄 PDF da vistoria${vistoria.pdfs.length > 1 ? ` (versão ${pdfAtual.versao})` : ''}</a>` : ''}
        ${vistoria && vistoria.status === 'finalizado' && !pdfAtual ? '<small class="kb-dica">PDF sendo gerado…</small>' : ''}
      </div>`;
  }

  function renderCabecalho() {
    const { card: c, modo } = cardAberto;
    const fase = estado.fases.find((f) => f.id === c.fase_id);
    const d = c.veiculo_detalhes || {};
    const linha = (rotulo, valor) => (valor ? `<dt>${rotulo}</dt><dd>${esc(valor)}</dd>` : '');
    $('kbPainelTitulo').textContent = `OS ${c.os_numero}${c.placa ? ' · ' + c.placa : ''}`;

    let acoes;
    if (c.arquivado_em) {
      acoes = `<p class="kb-arquivado-info">Arquivado em ${dataBR(c.arquivado_em)} por ${esc(c.arquivado_por || '—')}. Ao desarquivar, volta para "${esc(fase ? fase.nome : '')}".</p>
        <div class="kb-acoes-card"><button type="button" class="kb-botao" data-acao="desarquivar">Desarquivar</button></div>`;
    } else if (modo === 'mover') {
      acoes = `<h3 class="kb-sec">Mover para…</h3>
        <div class="kb-lista-fases">${estado.fases.map((f) =>
          `<button type="button" data-acao="mover-para" data-fase="${f.id}" ${f.id === c.fase_id ? 'disabled aria-current="true"' : ''}>${f.id}. ${esc(f.nome)}${f.id === c.fase_id ? ' (atual)' : ''}</button>`).join('')}</div>
        <div class="kb-acoes-card"><button type="button" class="kb-botao kb-botao-sec" data-acao="voltar">Cancelar</button></div>`;
    } else if (modo === 'arquivar') {
      acoes = `<div class="kb-confirmar"><p>Arquivar a OS ${esc(c.os_numero)}? O card some do kanban, mas pode ser desarquivado depois pela busca de arquivados.</p>
        <div class="kb-acoes-card"><button type="button" class="kb-botao kb-botao-perigo" data-acao="confirmar-arquivar">Sim, arquivar</button>
        <button type="button" class="kb-botao kb-botao-sec" data-acao="voltar">Cancelar</button></div></div>`;
    } else {
      acoes = `<div class="kb-acoes-card">
          <button type="button" class="kb-botao" data-acao="mover">Mover para…</button>
          <button type="button" class="kb-botao kb-botao-sec" data-acao="arquivar">Arquivar</button>
        </div>
        <label class="kb-campo-mecanico">🔧 Mecânico
          <select data-acao="mecanico">
            <option value="">${c.mecanico_do_card ? 'Usar o do painel de pátio' : (c.mecanico_nome ? `Do pátio: ${esc(primeiro(c.mecanico_nome))}` : 'Nenhum')}</option>
            ${estado.mecanicos.map((m) => `<option value="${m.id}" ${c.mecanico_do_card && c.mecanico_id === m.id ? 'selected' : ''}>${esc(primeiro(m.nome))}</option>`).join('')}
          </select>
          ${c.mecanico_do_card ? '' : '<small>definido pelo painel de pátio</small>'}
        </label>`;
    }

    $('kbCabecalho').innerHTML = `
      <span class="kb-fase-atual">${fase ? `${fase.id}. ${esc(fase.nome)}` : ''}</span>
      ${c.os_finalizada_em ? `<p class="kb-selo kb-selo-fin">OS finalizada no Onmotor em ${dataBR(c.os_finalizada_em)}</p>` : ''}
      ${acoes}`;

    $('kbDadosOnmotor').innerHTML = `
      <h3 class="kb-sec">Veículo (Onmotor)</h3>
      <dl class="kb-dados">
        ${linha('Placa', c.placa)}${linha('Marca', c.marca)}${linha('Modelo', c.modelo)}${linha('Ano', c.ano_completo)}
        ${linha('Chassi', c.chassi || 'ainda não lido')}${linha('KM', c.km)}
        ${linha('Motor', d.motor)}${linha('Combustível', d.combustivel)}${linha('Câmbio', d.cambio)}${linha('Cor', d.cor)}
      </dl>
      <h3 class="kb-sec">Cliente (Onmotor)</h3>
      <dl class="kb-dados">
        ${linha('Nome', c.cliente_nome)}${linha('Telefone', c.cliente_telefone)}
        ${linha('Entrada', c.os_entrada_em ? dataBR(c.os_entrada_em) : '')}
      </dl>`;
  }

  // ---------- compositor: registrar texto, foto, vídeo, áudio ----------
  function renderCompositor() {
    const el = $('kbCompositor');
    if (!el || !cardAberto) return;
    const { card: c, compositor: comp } = cardAberto;
    if (c.arquivado_em || cardAberto.modo) { el.innerHTML = ''; return; }
    const semStorage = !estado.storage_configurado;

    if (!comp) {
      el.innerHTML = `<div class="kb-registrar" role="group" aria-label="Registrar">
          <button type="button" class="kb-reg" data-acao="reg-texto">✍️<span>Texto</span></button>
          <button type="button" class="kb-reg" data-acao="reg-foto" ${semStorage ? 'disabled' : ''}>📷<span>Foto</span></button>
          <button type="button" class="kb-reg" data-acao="reg-video" ${semStorage ? 'disabled' : ''}>🎥<span>Vídeo</span></button>
          <button type="button" class="kb-reg" data-acao="reg-audio" ${semStorage ? 'disabled' : ''}>🎙️<span>Áudio</span></button>
          <button type="button" class="kb-reg" data-acao="reg-galeria" ${semStorage ? 'disabled' : ''}>🖼️<span>Galeria</span></button>
        </div>
        ${semStorage ? '<p class="kb-dica">Foto, vídeo e áudio estão desligados: o armazenamento de mídia não foi configurado no servidor.</p>' : ''}`;
      return;
    }
    if (comp.tipo === 'texto') {
      el.innerHTML = `<div class="kb-comp">
          <textarea id="kbTexto" rows="4" maxlength="${estado.limites.texto_max}" placeholder="O que aconteceu com o veículo?">${esc(comp.texto || '')}</textarea>
          <div class="kb-acoes-card">
            <button type="button" class="kb-botao" data-acao="salvar-texto">Salvar</button>
            <button type="button" class="kb-botao kb-botao-sec" data-acao="cancelar-comp">Cancelar</button>
          </div></div>`;
      setTimeout(() => { const t = $('kbTexto'); if (t) t.focus(); }, 0);
      return;
    }
    if (comp.tipo === 'gravando') {
      el.innerHTML = `<div class="kb-comp kb-gravando">
          <p><span class="kb-rec">●</span> Gravando… <strong id="kbRecTempo">0:00</strong></p>
          <div class="kb-acoes-card">
            <button type="button" class="kb-botao" data-acao="parar-gravacao">■ Parar</button>
            <button type="button" class="kb-botao kb-botao-sec" data-acao="cancelar-comp">Descartar</button>
          </div></div>`;
      return;
    }
    if (comp.tipo === 'midia') {
      if (comp.preparando) { el.innerHTML = '<div class="kb-comp"><p class="kb-dica">Preparando o arquivo…</p></div>'; return; }
      const prontos = comp.preparados;
      const primeiroItem = prontos[0];
      let previa = '';
      if (primeiroItem) {
        if (primeiroItem.tipo === 'foto') previa = `<img class="kb-previa" src="${comp.urls[0]}" alt="Prévia da foto">`;
        else if (primeiroItem.tipo === 'video') previa = `<video class="kb-previa" src="${comp.urls[0]}" controls playsinline preload="metadata"></video>`;
        else previa = `<audio src="${comp.urls[0]}" controls preload="metadata"></audio>`;
      }
      const resumo = prontos.map((p) => `${p.tipo === 'foto' ? 'Foto' : p.tipo === 'video' ? `Vídeo de ${Math.round(p.duracao)} s` : `Áudio${p.duracao ? ` de ${Math.round(p.duracao)} s` : ''}`} · ${M.tamanhoTexto(p.blob.size)}`);
      el.innerHTML = `<div class="kb-comp">
          ${previa}
          ${prontos.length > 1 ? `<p class="kb-dica">${prontos.length} arquivos: ${resumo.join(' · ')}</p>` : (prontos.length ? `<p class="kb-dica">${resumo[0]}</p>` : '')}
          ${comp.avisos.map((a) => `<p class="kb-aviso-inline">${esc(a)}</p>`).join('')}
          ${comp.erros.map((a) => `<p class="kb-erro-inline">${esc(a)}</p>`).join('')}
          ${prontos.length ? `<label class="kb-campo">Legenda (opcional)
            <input id="kbLegenda" type="text" maxlength="500" value="${esc(comp.legenda || '')}" placeholder="Ex.: pastilha dianteira gasta"></label>` : ''}
          <div class="kb-acoes-card">
            ${prontos.length ? `<button type="button" class="kb-botao" data-acao="enviar-midia">Enviar${prontos.length > 1 ? ` ${prontos.length}` : ''}</button>` : ''}
            <button type="button" class="kb-botao kb-botao-sec" data-acao="cancelar-comp">${prontos.length ? 'Cancelar' : 'Fechar'}</button>
          </div></div>`;
    }
  }

  function fecharCompositor() {
    const comp = cardAberto && cardAberto.compositor;
    if (comp && comp.urls) comp.urls.forEach((u) => URL.revokeObjectURL(u));
    if (comp && comp.gravacao) comp.gravacao.cancelar();
    if (comp && comp.relogio) clearInterval(comp.relogio);
    if (cardAberto) cardAberto.compositor = null;
    renderCompositor();
  }

  async function arquivosEscolhidos(lista, tipoForcado) {
    if (!lista.length || !cardAberto) return;
    const comp = { tipo: 'midia', preparando: true, preparados: [], urls: [], avisos: [], erros: [], legenda: '' };
    cardAberto.compositor = comp;
    renderCompositor();
    for (const arq of lista) {
      const tipo = tipoForcado || (arq.type.startsWith('video/') ? 'video' : arq.type.startsWith('audio/') ? 'audio' : 'foto');
      try {
        const p = tipo === 'video' ? await M.prepararVideo(arq) : tipo === 'audio' ? await M.prepararAudio(arq) : await M.prepararFoto(arq);
        comp.preparados.push(p);
        comp.urls.push(URL.createObjectURL(p.blob));
        if (p.aviso) comp.avisos.push(p.aviso);
      } catch (e) {
        comp.erros.push(`${arq.name || 'Arquivo'}: ${e.message}`);
      }
    }
    comp.preparando = false;
    if (cardAberto && cardAberto.compositor === comp) renderCompositor();
  }

  async function enviarMidias() {
    const comp = cardAberto.compositor;
    const op = await garantirOperador();
    if (!op) return;
    const legenda = ($('kbLegenda') && $('kbLegenda').value.trim()) || '';
    for (const p of comp.preparados) await M.enfileirar({ cardId: cardAberto.id, preparado: p, legenda, operador: op });
    avisar(comp.preparados.length > 1 ? `${comp.preparados.length} arquivos na fila de envio` : 'Enviando…');
    fecharCompositor();
  }

  async function comecarGravacao() {
    if (!M.podeGravarAudio()) { $('kbInAudio').click(); return; }
    try {
      const gravacao = await M.iniciarGravacao();
      const comp = { tipo: 'gravando', gravacao };
      cardAberto.compositor = comp;
      renderCompositor();
      comp.relogio = setInterval(() => {
        const s = Math.floor((Date.now() - gravacao.inicio) / 1000);
        const el = $('kbRecTempo');
        if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
      }, 500);
    } catch (e) {
      avisar('Sem acesso ao microfone: escolha um arquivo de áudio', true);
      $('kbInAudio').click();
    }
  }

  async function pararGravacao() {
    const comp = cardAberto.compositor;
    clearInterval(comp.relogio);
    const { blob, duracao } = await comp.gravacao.parar();
    comp.gravacao = null;
    const p = await M.prepararAudio(blob, duracao);
    cardAberto.compositor = { tipo: 'midia', preparando: false, preparados: [p], urls: [URL.createObjectURL(blob)], avisos: [], erros: [], legenda: '' };
    renderCompositor();
  }

  // ---------- linha do tempo ----------
  const ICONE = {
    criado: '🆕', fase: '➡️', checklist_iniciado: '📋', checklist_finalizado: '✅', checklist_editado: '✏️', pdf: '📄', arquivado: '🗄️', desarquivado: '📤', os_finalizada_onmotor: '🏁', os_alterada_onmotor: '🔄',
    texto: '✍️', foto: '📷', video: '🎥', audio: '🎙️',
  };

  function midiaHtml(e) {
    const m = e.midia;
    if (!m) return '';
    if (!m.url) return '<p class="kb-dica">Mídia indisponível (armazenamento não configurado).</p>';
    if (m.tipo === 'foto') {
      return `<button type="button" class="kb-miniatura" data-acao="ver-foto" data-url="${esc(m.url)}" aria-label="Ampliar foto">
        <img src="${esc(m.miniatura_url || m.url)}" alt="${esc(e.texto || 'Foto')}" loading="lazy"></button>`;
    }
    if (m.tipo === 'video') {
      return `<video class="kb-player" src="${esc(m.url)}" ${m.miniatura_url ? `poster="${esc(m.miniatura_url)}"` : ''} controls playsinline preload="none"></video>
        <a class="kb-link-pequeno" href="${esc(m.url)}" target="_blank" rel="noopener">Abrir vídeo em outra aba</a>`;
    }
    if (m.tipo === 'audio') return `<audio class="kb-player-audio" src="${esc(m.url)}" controls preload="none"></audio>`;
    if (m.tipo === 'pdf') return `<a class="kb-botao kb-botao-sec kb-botao-pdf" href="${esc(m.url)}" target="_blank" rel="noopener">📄 Abrir PDF</a>`;
    return `<a href="${esc(m.url)}" target="_blank" rel="noopener">Abrir arquivo</a>`;
  }

  function eventoHtml(e) {
    const ca = cardAberto;
    const ativo = !ca.card.arquivado_em;
    let corpo;
    if (ca.editando === e.id) {
      corpo = `<textarea class="kb-editar" rows="4" maxlength="${estado.limites.texto_max}">${esc(e.texto || '')}</textarea>
        <div class="kb-acoes-card">
          <button type="button" class="kb-botao" data-acao="salvar-edicao" data-id="${e.id}">Salvar</button>
          <button type="button" class="kb-botao kb-botao-sec" data-acao="cancelar-edicao">Cancelar</button></div>`;
    } else {
      corpo = `${midiaHtml(e)}${e.texto ? `<div class="kb-tempo-texto">${esc(e.texto)}</div>` : ''}`;
    }
    const versoes = ca.versoes[e.id];
    const historico = versoes ? `<div class="kb-versoes"><strong>Versões anteriores</strong>${versoes.length ? versoes.map((v) =>
      `<div><span class="kb-tempo-meta">até ${dataBR(v.editado_em)} (editado por ${esc(v.editado_por)})</span><div>${esc(v.texto)}</div></div>`).join('') : '<div>Nenhuma.</div>'}</div>` : '';
    const confirmar = ca.removendo === e.id
      ? `<div class="kb-confirmar"><p>Remover este registro? Ele some da linha do tempo, mas fica guardado para auditoria.</p>
          <div class="kb-acoes-card"><button type="button" class="kb-botao kb-botao-perigo" data-acao="confirmar-remover" data-id="${e.id}">Sim, remover</button>
          <button type="button" class="kb-botao kb-botao-sec" data-acao="cancelar-remover">Cancelar</button></div></div>` : '';
    const menu = ativo && ca.editando !== e.id && ca.removendo !== e.id && (e.editavel || e.removivel)
      ? `<span class="kb-tempo-menu">${e.editavel ? `<button type="button" data-acao="editar" data-id="${e.id}">Editar</button>` : ''}${e.removivel ? `<button type="button" data-acao="remover" data-id="${e.id}">Remover</button>` : ''}</span>` : '';
    return `<li class="kb-ev kb-ev-${e.tipo}" data-id="${e.id}">
      <div class="kb-tempo-meta">${ICONE[e.tipo] || '•'} ${dataBR(e.criado_em)} · ${esc(e.operador_nome)}
        ${e.editado_em ? `· <button type="button" class="kb-link-pequeno" data-acao="versoes" data-id="${e.id}">editado</button>` : ''}${menu}</div>
      ${corpo}${historico}${confirmar}</li>`;
  }

  function renderLinhaTempo() {
    const el = $('kbLinhaTempo');
    if (!el || !cardAberto) return;
    el.innerHTML = cardAberto.eventos.map(eventoHtml).join('');
  }

  function renderPendentes(itens, progresso = new Map()) {
    const el = $('kbPendentes');
    if (!el || !cardAberto) return;
    const meus = itens.filter((i) => i.card_id === cardAberto.id);
    const nome = { foto: 'Foto', video: 'Vídeo', audio: 'Áudio' };
    el.innerHTML = meus.map((i) => {
      const pct = progresso.has(i.cliente_id) ? Math.round(progresso.get(i.cliente_id) * 100) : null;
      let situacao;
      if (i.estado === 'enviando') situacao = `Enviando${pct !== null ? ` ${pct}%` : '…'}`;
      else if (i.estado === 'falhou') situacao = `Não enviado: ${esc(i.erro || 'erro')}`;
      else if (i.erro) situacao = `Nova tentativa em instantes (${esc(i.erro)})`;
      else situacao = 'Na fila';
      return `<li class="kb-pendente${i.estado === 'falhou' ? ' kb-pendente-erro' : ''}">
        <div><strong>${ICONE[i.tipo]} ${nome[i.tipo]}${i.vinculo ? ' da vistoria' : ''}</strong> · ${M.tamanhoTexto(i.meta.tamanho)} · ${situacao}</div>
        ${pct !== null ? `<div class="kb-barra"><span style="width:${pct}%"></span></div>` : ''}
        ${i.estado === 'falhou' ? `<div class="kb-acoes-card"><button type="button" class="kb-botao" data-acao="fila-tentar" data-id="${i.cliente_id}">Tentar de novo</button>
          <button type="button" class="kb-botao kb-botao-sec" data-acao="fila-descartar" data-id="${i.cliente_id}">Descartar</button></div>` : ''}
      </li>`;
    }).join('');
  }

  // Barra global: envios em andamento em qualquer card.
  function renderFilaGlobal(itens) {
    const el = $('kbFila');
    const ativos = itens.filter((i) => i.estado !== 'falhou');
    const falhas = itens.length - ativos.length;
    if (!itens.length) { el.hidden = true; return; }
    el.hidden = false;
    el.textContent = [
      ativos.length ? `⬆️ Enviando ${ativos.length} arquivo(s)${navigator.onLine ? '' : ' — sem internet, continua quando a conexão voltar'}` : '',
      falhas ? `⚠️ ${falhas} envio(s) com erro: abra o card para tentar de novo` : '',
    ].filter(Boolean).join(' · ');
  }

  M.aoMudar((itens, progresso) => { renderPendentes(itens, progresso); renderFilaGlobal(itens); });
  M.aoConcluir((item) => {
    if (cardAberto && cardAberto.id === item.card_id) abrirCard(item.card_id);
    carregar();
  });

  // ---------- cliques no painel ----------
  $('kbPainelCorpo').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-acao]');
    if (!b || b.tagName === 'SELECT' || !cardAberto || !cardAberto.card) return;
    const c = cardAberto.card;
    const id = Number(b.dataset.id);
    switch (b.dataset.acao) {
      case 'mover': cardAberto.modo = 'mover'; renderCabecalho(); renderCompositor(); break;
      case 'arquivar': cardAberto.modo = 'arquivar'; renderCabecalho(); renderCompositor(); break;
      case 'voltar': cardAberto.modo = null; renderCabecalho(); renderCompositor(); break;
      case 'mover-para': {
        b.disabled = true;
        const r = await mover(c.id, Number(b.dataset.fase), c.fase_id);
        cardAberto && (cardAberto.modo = null);
        if (r && r.arquivado) fecharCard(); else abrirCard(c.id);
        break;
      }
      case 'confirmar-arquivar': b.disabled = true; await arquivar(c.id); break;
      case 'desarquivar': b.disabled = true; await desarquivar(c.id); break;

      case 'abrir-checklist': window.KanbanChecklist.abrir(c.id, b.dataset.codigo); break;
      case 'reg-texto': cardAberto.compositor = { tipo: 'texto', texto: '' }; renderCompositor(); break;
      case 'reg-foto': $('kbInFoto').click(); break;
      case 'reg-video': $('kbInVideo').click(); break;
      case 'reg-galeria': $('kbInGaleria').click(); break;
      case 'reg-audio': comecarGravacao(); break;
      case 'parar-gravacao': b.disabled = true; await pararGravacao(); break;
      case 'cancelar-comp': fecharCompositor(); break;
      case 'enviar-midia': b.disabled = true; await enviarMidias(); break;
      case 'salvar-texto': {
        const texto = $('kbTexto').value.trim();
        if (!texto) { $('kbTexto').focus(); break; }
        const op = await garantirOperador();
        if (!op) break;
        b.disabled = true;
        try {
          await api(`/api/kanban/cards/${c.id}/textos`, { json: { texto, operador: op } });
          fecharCompositor();
          abrirCard(c.id);
        } catch (e) { avisar(e.message, true); b.disabled = false; }
        break;
      }

      case 'ver-foto': abrirFoto(b.dataset.url); break;
      case 'editar': cardAberto.editando = id; cardAberto.removendo = null; renderLinhaTempo(); break;
      case 'cancelar-edicao': cardAberto.editando = null; renderLinhaTempo(); break;
      case 'salvar-edicao': {
        const t = b.closest('li').querySelector('textarea').value.trim();
        if (!t) break;
        const op = await garantirOperador();
        if (!op) break;
        b.disabled = true;
        try {
          await api(`/api/kanban/eventos/${id}`, { method: 'PUT', json: { texto: t, operador: op } });
          cardAberto.editando = null;
          delete cardAberto.versoes[id];
          abrirCard(c.id);
        } catch (e) { avisar(e.message, true); b.disabled = false; }
        break;
      }
      case 'versoes':
        if (cardAberto.versoes[id]) delete cardAberto.versoes[id];
        else {
          try { cardAberto.versoes[id] = (await api(`/api/kanban/eventos/${id}/versoes`)).versoes.slice().reverse(); } catch (e) { avisar(e.message, true); }
        }
        renderLinhaTempo();
        break;
      case 'remover': cardAberto.removendo = id; cardAberto.editando = null; renderLinhaTempo(); break;
      case 'cancelar-remover': cardAberto.removendo = null; renderLinhaTempo(); break;
      case 'confirmar-remover': {
        const op = await garantirOperador();
        if (!op) break;
        b.disabled = true;
        try {
          await api(`/api/kanban/eventos/${id}/remover`, { json: { operador: op } });
          cardAberto.removendo = null;
          avisar('Registro removido');
          abrirCard(c.id);
          carregar();
        } catch (e) { avisar(e.message, true); b.disabled = false; }
        break;
      }
      case 'fila-tentar': M.tentarDeNovo(b.dataset.id); break;
      case 'fila-descartar': M.descartar(b.dataset.id); break;
      default: break;
    }
  });
  $('kbPainelCorpo').addEventListener('change', (ev) => {
    const sel = ev.target.closest('select[data-acao="mecanico"]');
    if (sel && cardAberto) trocarMecanico(cardAberto.id, sel.value);
  });
  $('kbPainelCorpo').addEventListener('input', (ev) => {
    if (ev.target.id === 'kbTexto' && cardAberto && cardAberto.compositor) cardAberto.compositor.texto = ev.target.value;
    if (ev.target.id === 'kbLegenda' && cardAberto && cardAberto.compositor) cardAberto.compositor.legenda = ev.target.value;
  });

  // Entradas de arquivo (câmera, galeria, áudio). Zeradas depois de ler para permitir escolher o mesmo arquivo de novo.
  for (const [id, tipo] of [['kbInFoto', 'foto'], ['kbInVideo', 'video'], ['kbInAudio', 'audio'], ['kbInGaleria', null]]) {
    $(id).addEventListener('change', (ev) => {
      const arquivos = [...ev.target.files];
      ev.target.value = '';
      arquivosEscolhidos(arquivos, tipo);
    });
  }

  // ---------- foto ampliada ----------
  function abrirFoto(url) {
    $('kbFotoGrande').src = url;
    $('kbVisor').hidden = false;
  }
  $('kbVisor').addEventListener('click', () => { $('kbVisor').hidden = true; $('kbFotoGrande').src = ''; });

  // O painel do card ocupa uma entrada no histórico: o "voltar" do Android / gesto do iPhone
  // fecha o card em vez de sair do kanban. `historico: true` = chamado pelo próprio voltar.
  function fecharCard({ historico = false } = {}) {
    if (!historico && history.state && history.state.kb === 'card') { history.back(); return; }
    if (cardAberto && cardAberto.compositor) fecharCompositor();
    clearInterval(refrescoUrls);
    cardAberto = null;
    $('kbPainel').hidden = true;
    $('kbVeu').hidden = true;
    document.body.style.overflow = '';
  }

  // ---------- busca ----------
  const buscando = () => modoBusca === 'arquivados' || $('kbBusca').value.trim() !== '';
  let buscaTimer = null;
  let buscaSeq = 0;

  function mostrarModo() {
    const lista = buscando();
    $('kbQuadro').hidden = lista;
    $('kbAbas').hidden = lista;
    $('kbResultados').hidden = !lista;
    document.querySelector('.kb-filtros').hidden = lista; // filtros valem para o quadro, não para a busca
    document.querySelectorAll('.kb-modo-btn').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.modo === modoBusca)));
  }

  async function buscarAgora() {
    mostrarModo();
    if (!buscando()) return;
    const seq = ++buscaSeq;
    const q = $('kbBusca').value.trim();
    try {
      const r = await api(`/api/kanban/busca?modo=${modoBusca}&q=${encodeURIComponent(q)}`);
      if (seq !== buscaSeq) return;
      const titulo = modoBusca === 'arquivados'
        ? (q ? `${r.total} arquivado(s) para "${esc(q)}"` : `Arquivados mais recentes (${r.total})`)
        : `${r.total} card(s) ativo(s) para "${esc(q)}"`;
      $('kbResultados').innerHTML = `<p class="kb-res-topo">${titulo}</p>
        <div class="kb-res-lista">${r.cards.map((c) => `
          <button type="button" class="kb-res-item" data-id="${c.id}">
            <span><strong>OS ${esc(c.os_numero)}</strong> ${c.placa ? `<span class="kb-placa">${esc(c.placa)}</span>` : ''}</span>
            <span class="kb-res-fase">${c.arquivado_em ? `Arquivado em ${dataBR(c.arquivado_em)}` : `${c.fase_id}. ${esc(c.fase_nome)}`}</span>
            <span class="kb-res-sub">${esc([c.marca, c.modelo].filter(Boolean).join(' ') || 'Veículo')}${c.ano ? ' · ' + esc(c.ano) : ''} · ${esc(c.primeiro_nome || 'Cliente')}</span>
          </button>`).join('') || '<p class="kb-vazio">Nada encontrado.</p>'}</div>`;
    } catch (e) {
      $('kbResultados').innerHTML = `<p class="kb-vazio">${esc(e.message)}</p>`;
    }
  }

  $('kbBusca').addEventListener('input', () => {
    clearTimeout(buscaTimer);
    buscaTimer = setTimeout(buscarAgora, 250);
  });
  document.querySelector('.kb-modo').addEventListener('click', (ev) => {
    const b = ev.target.closest('.kb-modo-btn');
    if (!b) return;
    modoBusca = b.dataset.modo;
    buscarAgora();
  });
  $('kbResultados').addEventListener('click', (ev) => {
    const item = ev.target.closest('.kb-res-item');
    if (item) abrirCard(item.dataset.id);
  });

  // ---------- filtros e abas ----------
  $('kbFiltroMecanico').addEventListener('change', (ev) => {
    filtroMecanico = ev.target.value;
    guardar('s', 'kb.filtroMecanico', filtroMecanico);
    render();
  });
  $('kbFiltroFase').addEventListener('change', (ev) => {
    filtroFase = ev.target.value;
    guardar('s', 'kb.filtroFase', filtroFase);
    render();
  });
  $('kbAbas').addEventListener('click', (ev) => {
    const b = ev.target.closest('.kb-aba');
    if (!b) return;
    faseAtiva = Number(b.dataset.fase);
    faseEscolhida = faseAtiva;
    guardar('s', 'kb.fase', faseAtiva);
    render();
  });

  // ---------- abrir card: clique ou Enter ----------
  $('kbQuadro').addEventListener('click', (ev) => {
    const card = ev.target.closest('.kb-card');
    if (card) abrirCard(card.dataset.id);
  });
  $('kbQuadro').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    const card = ev.target.closest('.kb-card');
    if (!card) return;
    ev.preventDefault();
    abrirCard(card.dataset.id);
  });
  $('kbFechar').addEventListener('click', fecharCard);
  $('kbVeu').addEventListener('click', fecharCard);
  document.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    if (!$('kbModalOperador').hidden) fecharModalOperador(null);
    else if (!$('kbPainel').hidden) fecharCard();
  });

  $('kbSync').addEventListener('click', async () => {
    const btn = $('kbSync');
    btn.disabled = true;
    btn.textContent = '⟳ Lendo o Onmotor…';
    try {
      await api('/api/kanban/sync', { method: 'POST' });
    } catch (_) {
      // o banner mostra o motivo depois do recarregamento
    } finally {
      btn.disabled = false;
      btn.textContent = '⟳ Sincronizar';
      carregar();
    }
  });

  // Atualização em tempo real (mesmo canal SSE da agenda e do pátio)
  try {
    const es = new EventSource('/api/eventos');
    es.addEventListener('kanban', () => carregar());
  } catch (_) { /* sem SSE: o intervalo abaixo cobre */ }
  setInterval(carregar, 60_000);

  // Voltar do navegador/celular: fecha primeiro o checklist, depois o card.
  window.addEventListener('popstate', () => {
    if (!$('kbChk').hidden && window.KanbanChecklist) { window.KanbanChecklist.fechar({ historico: true }); return; }
    if (!$('kbPainel').hidden) fecharCard({ historico: true });
  });
  // Recarregou com um card "aberto" no histórico: limpa, senão o próximo fechar voltaria uma página.
  if (history.state && history.state.kb) history.replaceState(null, '');

  // Funções compartilhadas com a tela de checklist (checklist.js).
  window.KanbanApp = {
    api, avisar, esc, dataBR, garantirOperador, abrirModalOperador,
    operadorAtual: () => operador,
    // Ao fechar o checklist: atualiza o card aberto e o quadro.
    checklistFechado: (cardId) => {
      if (cardAberto && cardAberto.id === Number(cardId)) abrirCard(cardId);
      carregar();
    },
  };

  mostrarOperador();
  carregar();
})();
