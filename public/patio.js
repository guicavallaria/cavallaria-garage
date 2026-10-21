// Painel de Pátio — renderizado abaixo da agenda, na mesma página.
// Lê /api/patio/estado, atualiza por SSE (evento "patio", vindo do app.js) e,
// por garantia, a cada 60 s. Não mexe em nada da agenda.
(function () {
  const sec = document.getElementById('patio');
  if (!sec) return;

  let estado = null;
  let sincronizando = false;
  let timerPoll = null;

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const nome1 = (s) => (typeof primeiroNome === 'function' ? primeiroNome(String(s || '')) : String(s || '').split(' ')[0]);
  const hhmm = (ts) => (ts ? String(ts).slice(11, 16) : '—');
  const anoCurto = (ano) => { const m = String(ano || '').match(/(\d{4})(?:\/(\d{4}))?/); return m ? (m[2] || m[1]) : ''; };

  async function carregar() {
    try {
      estado = await fetch('/api/patio/estado').then((r) => { if (!r.ok) throw new Error(r.status); return r.json(); });
      render();
    } catch (e) {
      sec.innerHTML = `<div class="patio-erro">Não foi possível carregar o painel de pátio (${esc(e.message)}).</div>`;
    }
  }

  function densidade() {
    const maior = Math.max(estado.pendentes.length, ...estado.mecanicos.map((m) => m.veiculos.length), 0);
    return maior <= 4 ? 'baixa' : maior <= 8 ? 'media' : 'alta';
  }

  function selectMecanico(v) {
    if (v.definido_pela_agenda) {
      return `<span class="patio-agenda-tag" title="O responsável vem da coluna da agenda de hoje. Para trocar, mova o agendamento.">📅 definido pela agenda</span>`;
    }
    const opts = ['<option value="">— sem responsável —</option>']
      .concat(estado.mecanicos.map((m) => `<option value="${m.id}" ${m.id === v.mecanico_id ? 'selected' : ''}>${esc(nome1(m.nome))}</option>`));
    return `<select class="patio-select" data-id="${v.id}" title="Atribuir responsável">${opts.join('')}</select>`;
  }

  function card(v) {
    const linha2 = [v.modelo, anoCurto(v.ano), v.cor].filter(Boolean).map(esc).join(' · ');
    return `
      <article class="patio-card ${v.mecanico_id == null ? 'sem-resp' : ''}" data-id="${v.id}">
        <div class="patio-placa ${v.sem_placa ? 'sem-placa' : ''}">${esc(v.placa)}</div>
        <div class="patio-modelo">${linha2 || '&nbsp;'}</div>
        <div class="patio-dono">${esc(v.primeiro_nome) || '&nbsp;'}</div>
        <div class="patio-rodape">
          <span class="patio-os" title="OS em execução">${v.os.map((o) => 'OS ' + esc(o)).join(' · ')}</span>
          ${selectMecanico(v)}
        </div>
      </article>`;
  }

  function render() {
    if (!estado) return;
    const s = estado.sync;
    const fontesFalha = s.fontes_com_falha || [];
    const alertaSync = s.ultima_falhou
      ? `<span class="patio-sync-aviso falha" title="${esc(s.ultimo_erro || '')}">⚠️ Última sincronização falhou</span>`
      : s.desatualizado
        ? `<span class="patio-sync-aviso velho">⚠️ Sem sincronização há ${s.minutos_desde_ok == null ? 'muito tempo' : Math.round(s.minutos_desde_ok / 60) + ' h'}</span>`
        : fontesFalha.length
          ? `<span class="patio-sync-aviso velho" title="Os veículos dessa fonte foram mantidos como estavam">⚠️ ${esc(fontesFalha.map((f) => f.toUpperCase()).join(', '))} não lida na última sincronização</span>`
          : '';

    // Só profissionais com veículo viram coluna (coluna com 0 não aparece — pedido do usuário).
    const comVeiculo = estado.mecanicos.filter((m) => m.veiculos.length > 0);
    sec.dataset.densidade = densidade();
    sec.style.setProperty('--patio-cols', comVeiculo.length || 1);

    sec.innerHTML = `
      <header class="patio-topo">
        <div class="patio-titulo">🚗 Pátio</div>
        <div class="patio-kpi"><div class="patio-kpi-num">${estado.total}</div><div class="patio-kpi-rot">veículo${estado.total === 1 ? '' : 's'} em serviço</div></div>
        <div class="patio-kpi ${estado.sem_responsavel > 0 ? 'alerta' : ''}"><div class="patio-kpi-num">${estado.sem_responsavel}</div><div class="patio-kpi-rot">sem responsável</div></div>
        <div class="patio-sync">
          <div class="patio-sync-hora">Última sincronização: <b>${hhmm(s.ultima_ok_em)}</b> ${alertaSync}</div>
          <button type="button" id="btnPatioSync" class="btn-ghost" ${sincronizando ? 'disabled' : ''}>${sincronizando ? '⏳ Sincronizando…' : '🔄 Sincronizar agora'}</button>
          <button type="button" id="btnPatioTela" class="btn-ghost" title="Só o pátio em tela cheia (TV)">⛶</button>
        </div>
      </header>
      ${estado.pendentes.length ? `
        <section class="patio-pendentes">
          <h3>⚠️ Pendentes de atribuição (${estado.pendentes.length})</h3>
          <div class="patio-pendentes-lista">${estado.pendentes.map(card).join('')}</div>
        </section>` : ''}
      <div class="patio-colunas">
        ${comVeiculo.length ? comVeiculo.map((m) => `
          <section class="patio-col" style="--cor:${esc(m.cor)}">
            <h3 class="patio-col-cab" title="${esc(m.nome)}"><span>${esc(nome1(m.nome))}</span><span class="patio-col-n">${m.veiculos.length}</span></h3>
            <div class="patio-col-cards">${m.veiculos.map(card).join('')}</div>
          </section>`).join('') : '<div class="patio-vazio">Nenhum veículo atribuído a um profissional.</div>'}
      </div>`;

    sec.querySelectorAll('.patio-select').forEach((sel) => sel.addEventListener('change', () => atribuir(sel)));
    const btn = document.getElementById('btnPatioSync');
    if (btn) btn.addEventListener('click', sincronizarAgora);
    const tela = document.getElementById('btnPatioTela');
    if (tela) tela.addEventListener('click', () => (document.fullscreenElement ? document.exitFullscreen() : sec.requestFullscreen && sec.requestFullscreen()));
  }

  async function atribuir(sel) {
    const id = Number(sel.dataset.id);
    const mecanico_id = sel.value === '' ? null : Number(sel.value);
    sel.disabled = true;
    const resp = await fetch(`/api/patio/veiculos/${id}/mecanico`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mecanico_id }),
    });
    if (!resp.ok) {
      const { erro } = await resp.json().catch(() => ({ erro: 'erro' }));
      alert(erro || 'Não foi possível atribuir');
    }
    await carregar();
  }

  async function sincronizarAgora() {
    if (sincronizando) return;
    sincronizando = true;
    render();
    try {
      await fetch('/api/patio/sync', { method: 'POST' });
    } finally {
      sincronizando = false;
      await carregar();
    }
  }

  function agendarPoll() {
    clearInterval(timerPoll);
    timerPoll = setInterval(carregar, 60000);
  }

  window.Patio = { atualizar: carregar };
  carregar();
  agendarPoll();
})();
