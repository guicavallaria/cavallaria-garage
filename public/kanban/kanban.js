// Kanban de OS — Etapa 1: quadro somente leitura (cards vindos do Onmotor) + linha do tempo.
// Mover, arquivar, buscar e filtrar chegam na Etapa 2.
(() => {
  const $ = (id) => document.getElementById(id);
  const TZ = 'America/Sao_Paulo';
  const DIA_MS = 86_400_000;
  const VELHO_DIAS = 5;

  let estado = null;
  // Celular: a fase escolhida fica guardada na aba do navegador; sem escolha, abre na 1ª fase que tem card.
  let faseEscolhida = Number(sessionStorageGet('kb.fase')) || null;
  let faseAtiva = faseEscolhida || 1;

  function sessionStorageGet(k) { try { return sessionStorage.getItem(k); } catch (_) { return null; } }
  function sessionStorageSet(k, v) { try { sessionStorage.setItem(k, v); } catch (_) { /* sem storage */ } }

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const fmtData = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const fmtHora = new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dataBR = (iso) => (iso ? fmtData.format(new Date(iso)).replace(',', '') : '—');
  const horaBR = (iso) => (iso ? fmtHora.format(new Date(iso)) : '');

  function tempoNaFase(iso, agora) {
    const ms = Math.max(0, agora - Date.parse(iso));
    const dias = Math.floor(ms / DIA_MS);
    if (dias >= 1) return { texto: `${dias} d`, dias };
    const horas = Math.floor(ms / 3_600_000);
    return { texto: horas >= 1 ? `${horas} h` : 'agora', dias: 0 };
  }

  async function api(caminho, opts) {
    const r = await fetch(caminho, { credentials: 'same-origin', ...opts });
    if (r.status === 401) { location.href = '/login'; throw new Error('sessão expirada'); }
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(corpo.erro || `erro ${r.status}`), { corpo });
    return corpo;
  }

  // ---------- quadro ----------
  function cardHtml(c, agora) {
    const t = tempoNaFase(c.fase_desde, agora);
    const velho = t.dias > VELHO_DIAS;
    const veiculo = [c.marca, c.modelo].filter(Boolean).join(' ');
    return `<button type="button" class="kb-card${velho ? ' kb-velho' : ''}" data-id="${c.id}">
      <div class="kb-card-l1">
        <span class="kb-os">OS ${esc(c.os_numero)}</span>
        ${c.placa ? `<span class="kb-placa">${esc(c.placa)}</span>` : ''}
        <span class="kb-tempo" title="Tempo nesta fase">${t.texto}</span>
      </div>
      <div class="kb-card-l2">${esc(veiculo || 'Veículo sem modelo')}${c.ano ? ` · ${esc(c.ano)}` : ''}</div>
      <div class="kb-card-l3">
        <span>${esc(c.primeiro_nome || 'Cliente')}</span>
        ${c.mecanico_nome ? `<span>🔧 ${esc(c.mecanico_nome.split(' ')[0])}</span>` : ''}
      </div>
      ${c.os_finalizada_em ? '<span class="kb-selo kb-selo-fin">OS finalizada no Onmotor</span>' : ''}
      ${!c.os_finalizada_em && c.os_sumiu_em ? '<span class="kb-selo kb-selo-sumiu">Saiu da Novidades do Onmotor</span>' : ''}
    </button>`;
  }

  function render() {
    const agora = Date.now();
    const porFase = new Map(estado.fases.map((f) => [f.id, []]));
    for (const c of estado.cards) (porFase.get(c.fase_id) || []).push(c);

    $('kbAbas').innerHTML = estado.fases.map((f) =>
      `<button type="button" class="kb-aba" role="tab" data-fase="${f.id}" aria-selected="${f.id === faseAtiva}">
        ${f.id}. ${esc(f.nome)}<span class="kb-n">${porFase.get(f.id).length}</span></button>`).join('');

    $('kbQuadro').innerHTML = estado.fases.map((f) => {
      const lista = porFase.get(f.id);
      return `<section class="kb-coluna${f.id === faseAtiva ? ' kb-ativa' : ''}" data-fase="${f.id}" aria-label="${esc(f.nome)}">
        <div class="kb-coluna-topo"><span>${f.id}. ${esc(f.nome)}</span><span class="kb-n">${lista.length}</span></div>
        <div class="kb-lista">${lista.length ? lista.map((c) => cardHtml(c, agora)).join('') : '<p class="kb-vazio">Nenhum card nesta fase.</p>'}</div>
      </section>`;
    }).join('');

    const ativa = $('kbAbas').querySelector('[aria-selected="true"]');
    if (ativa) ativa.scrollIntoView({ block: 'nearest', inline: 'center' });

    renderSync();
  }

  function renderSync() {
    const s = estado.sync;
    $('kbFonte').hidden = estado.fonte !== 'mock';
    $('kbUltimaSync').textContent = s.ultima_ok_em ? `Onmotor lido às ${horaBR(s.ultima_ok_em)}` : '';
    const b = $('kbBanner');
    b.classList.remove('kb-banner-info');
    if (s.parada) {
      const desde = s.parada_desde ? horaBR(s.parada_desde) : '—';
      const dia = s.parada_desde && dataBR(s.parada_desde).slice(0, 10) !== dataBR(new Date().toISOString()).slice(0, 10)
        ? ` de ${dataBR(s.parada_desde).slice(0, 10)}` : '';
      b.innerHTML = `Sincronização com Onmotor parada desde ${desde}${dia}` +
        (s.ultimo_erro ? `<small>${esc(s.ultimo_erro)}</small>` : '');
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
      render();
    } catch (e) {
      $('kbQuadro').innerHTML = `<p class="kb-vazio">Não consegui carregar o kanban: ${esc(e.message)}</p>`;
    }
  }

  // ---------- painel do card ----------
  async function abrirCard(id) {
    $('kbPainelTitulo').textContent = 'Carregando…';
    $('kbPainelCorpo').innerHTML = '';
    $('kbPainel').hidden = false;
    $('kbVeu').hidden = false;
    document.body.style.overflow = 'hidden';
    try {
      const { card: c, eventos } = await api(`/api/kanban/cards/${id}`);
      const fase = estado.fases.find((f) => f.id === c.fase_id);
      const d = c.veiculo_detalhes || {};
      const linha = (rotulo, valor) => (valor ? `<dt>${rotulo}</dt><dd>${esc(valor)}</dd>` : '');
      $('kbPainelTitulo').textContent = `OS ${c.os_numero}${c.placa ? ' · ' + c.placa : ''}`;
      $('kbPainelCorpo').innerHTML = `
        <span class="kb-fase-atual">${fase ? `${fase.id}. ${esc(fase.nome)}` : ''}</span>
        ${c.os_finalizada_em ? `<p class="kb-selo kb-selo-fin">OS finalizada no Onmotor em ${dataBR(c.os_finalizada_em)}</p>` : ''}
        <h3 class="kb-sec">Veículo (Onmotor)</h3>
        <dl class="kb-dados">
          ${linha('Placa', c.placa)}${linha('Marca', c.marca)}${linha('Modelo', c.modelo)}${linha('Ano', c.ano_completo)}
          ${linha('Chassi', c.chassi || (c.tem_chassi ? '' : 'ainda não lido'))}${linha('KM', c.km)}
          ${linha('Motor', d.motor)}${linha('Combustível', d.combustivel)}${linha('Câmbio', d.cambio)}${linha('Cor', d.cor)}
        </dl>
        <h3 class="kb-sec">Cliente (Onmotor)</h3>
        <dl class="kb-dados">
          ${linha('Nome', c.cliente_nome)}${linha('Telefone', c.cliente_telefone)}
          ${linha('Entrada', c.os_entrada_em ? dataBR(c.os_entrada_em) : '')}
          ${linha('Mecânico', c.mecanico_nome)}
        </dl>
        <h3 class="kb-sec">Linha do tempo</h3>
        <ul class="kb-tempo-linha">
          ${eventos.map((e) => `<li><div class="kb-tempo-meta">${dataBR(e.criado_em)} · ${esc(e.operador_nome)}</div>${esc(e.texto || '')}</li>`).join('')}
        </ul>`;
    } catch (e) {
      $('kbPainelCorpo').innerHTML = `<p class="kb-vazio">${esc(e.message)}</p>`;
    }
  }

  function fecharCard() {
    $('kbPainel').hidden = true;
    $('kbVeu').hidden = true;
    document.body.style.overflow = '';
  }

  // ---------- eventos ----------
  $('kbAbas').addEventListener('click', (ev) => {
    const b = ev.target.closest('.kb-aba');
    if (!b) return;
    faseAtiva = Number(b.dataset.fase);
    faseEscolhida = faseAtiva;
    sessionStorageSet('kb.fase', faseAtiva);
    render();
  });
  $('kbQuadro').addEventListener('click', (ev) => {
    const card = ev.target.closest('.kb-card');
    if (card) abrirCard(card.dataset.id);
  });
  $('kbFechar').addEventListener('click', fecharCard);
  $('kbVeu').addEventListener('click', fecharCard);
  document.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && !$('kbPainel').hidden) fecharCard(); });

  $('kbSync').addEventListener('click', async () => {
    const btn = $('kbSync');
    btn.disabled = true;
    btn.textContent = '⟳ Lendo o Onmotor…';
    try {
      await api('/api/kanban/sync', { method: 'POST' });
    } catch (e) {
      // o banner mostra o motivo depois do recarregamento
    } finally {
      btn.disabled = false;
      btn.textContent = '⟳ Sincronizar agora';
      carregar();
    }
  });

  // Atualização em tempo real (mesmo canal SSE da agenda e do pátio)
  try {
    const es = new EventSource('/api/eventos');
    es.addEventListener('kanban', () => carregar());
  } catch (_) { /* sem SSE: recarrega a cada minuto */ }
  setInterval(carregar, 60_000);

  carregar();
})();
