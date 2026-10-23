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
  async function abrirCard(id) {
    cardAberto = { id: Number(id), card: null, modo: null };
    $('kbPainelTitulo').textContent = 'Carregando…';
    $('kbPainelCorpo').innerHTML = '';
    $('kbPainel').hidden = false;
    $('kbVeu').hidden = false;
    document.body.style.overflow = 'hidden';
    try {
      const dados = await api(`/api/kanban/cards/${id}`);
      if (!cardAberto || cardAberto.id !== Number(id)) return;
      cardAberto.card = dados.card;
      cardAberto.eventos = dados.eventos;
      renderPainel();
    } catch (e) {
      $('kbPainelCorpo').innerHTML = `<p class="kb-vazio">${esc(e.message)}</p>`;
    }
  }

  function renderPainel() {
    const { card: c, eventos, modo } = cardAberto;
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

    $('kbPainelCorpo').innerHTML = `
      <span class="kb-fase-atual">${fase ? `${fase.id}. ${esc(fase.nome)}` : ''}</span>
      ${c.os_finalizada_em ? `<p class="kb-selo kb-selo-fin">OS finalizada no Onmotor em ${dataBR(c.os_finalizada_em)}</p>` : ''}
      ${acoes}
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
      </dl>
      <h3 class="kb-sec">Linha do tempo</h3>
      <ul class="kb-tempo-linha">
        ${eventos.map((e) => `<li><div class="kb-tempo-meta">${dataBR(e.criado_em)} · ${esc(e.operador_nome)}</div>${esc(e.texto || '')}</li>`).join('')}
      </ul>`;
  }

  $('kbPainelCorpo').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-acao]');
    if (!b || !cardAberto || !cardAberto.card) return;
    const c = cardAberto.card;
    switch (b.dataset.acao) {
      case 'mover': cardAberto.modo = 'mover'; renderPainel(); break;
      case 'arquivar': cardAberto.modo = 'arquivar'; renderPainel(); break;
      case 'voltar': cardAberto.modo = null; renderPainel(); break;
      case 'mover-para': {
        b.disabled = true;
        const r = await mover(c.id, Number(b.dataset.fase), c.fase_id);
        if (r && r.arquivado) fecharCard(); else abrirCard(c.id);
        break;
      }
      case 'confirmar-arquivar': b.disabled = true; await arquivar(c.id); break;
      case 'desarquivar': b.disabled = true; await desarquivar(c.id); break;
      default: break;
    }
  });
  $('kbPainelCorpo').addEventListener('change', (ev) => {
    const sel = ev.target.closest('select[data-acao="mecanico"]');
    if (sel && cardAberto) trocarMecanico(cardAberto.id, sel.value);
  });

  function fecharCard() {
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

  mostrarOperador();
  carregar();
})();
