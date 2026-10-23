// "Relatórios Launch não vinculados" (seção 11): ver o PDF e vincular a um card à mão.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dataBR = (iso) => (iso ? fmt.format(new Date(iso)).replace(',', '') : '—');
  const operador = () => { try { return localStorage.getItem('kb.operador') || ''; } catch (_) { return ''; } };
  const MODO = { gmail: 'Gmail (launchcavallaria@gmail.com)', mock: 'caixa SIMULADA (pasta de teste)', desligado: 'leitura do Gmail desligada' };

  async function api(caminho, opts = {}) {
    const init = { credentials: 'same-origin', ...opts };
    if (opts.json !== undefined) { init.method = 'POST'; init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(opts.json); }
    const r = await fetch(caminho, init);
    if (r.status === 401) { location.href = '/login'; throw new Error('sessão expirada'); }
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.erro || `erro ${r.status}`);
    return j;
  }
  function avisar(t, erro) {
    const el = $('kbAviso');
    el.textContent = t;
    el.classList.toggle('kb-aviso-erro', Boolean(erro));
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, erro ? 6000 : 3500);
  }

  let busca = {}; // relatório → resultados da busca de card
  let verAntigos = false; // relatórios antigos sem card ativo (escondidos por padrão)

  async function carregar() {
    const { estado, relatorios } = await api(`/api/kanban/launch/nao-vinculados${verAntigos ? '?antigos=1' : ''}`);
    $('lnEstado').innerHTML = `Fonte: <strong>${esc(MODO[estado.modo] || estado.modo)}</strong>
      · última leitura ${estado.ultima_ok_em ? dataBR(estado.ultima_ok_em) : '—'}
      ${estado.ultimo_erro ? `<br><span class="kb-erro-inline" style="display:inline-block">${esc(estado.ultimo_erro)}</span>` : ''}`;
    $('lnSync').hidden = estado.modo === 'desligado';
    $('lnLista').innerHTML = relatorios.map((r) => `<li class="ln-item" data-id="${r.id}">
        <h3>${esc(r.marca || 'Marca ?')} · ${esc(r.chassi || 'chassi não encontrado no nome do arquivo')}</h3>
        <div class="ln-meta">${esc(r.nome_arquivo)} · recebido em ${dataBR(r.relatorio_em)} · ${r.origem === 'email' ? 'do e-mail' : 'envio manual'}
          · <a href="${esc(r.url)}" target="_blank" rel="noopener">📄 abrir PDF</a></div>
        ${r.sugestoes.length ? `<div><span class="ln-meta">Mesmo chassi (fora do período da OS ou card arquivado):</span>
          <div class="ln-cards">${r.sugestoes.map((c) => `<button type="button" class="sug" data-vincular="${c.id}">OS ${esc(c.os_numero)} · ${esc(c.placa || '')} · ${esc(c.modelo || '')}${c.arquivado ? ' (arquivado)' : ''}</button>`).join('')}</div></div>` : ''}
        <form class="ln-busca" data-buscar="${r.id}">
          <input type="search" placeholder="Buscar card: OS, placa, modelo ou cliente" aria-label="Buscar card">
          <button type="submit" class="kb-botao kb-botao-sec">Buscar</button>
        </form>
        <div class="ln-cards">${(busca[r.id] || []).map((c) => `<button type="button" data-vincular="${c.id}">OS ${esc(c.os_numero)} · ${esc(c.placa || '')} · ${esc(c.modelo || '')} · ${esc(c.fase_nome || '')}</button>`).join('')}</div>
      </li>`).join('') || `<li class="kb-dica">${verAntigos ? 'Nenhum relatório antigo.' : 'Nenhum relatório recente sem card. 👍'}</li>`;
    const n = estado.nao_vinculados_antigos || 0;
    $('lnAntigos').hidden = !n && !verAntigos;
    $('lnAntigos').textContent = verAntigos ? '← Voltar aos relatórios recentes' : `Mostrar ${n} relatório(s) antigo(s) sem card ativo`;
    $('lnTitulo').textContent = verAntigos ? 'Antigos: mais de 7 dias e sem card ativo do mesmo chassi (OS já fechadas)' : '';
  }

  $('lnAntigos').addEventListener('click', () => { verAntigos = !verAntigos; busca = {}; carregar().catch((e) => avisar(e.message, true)); window.scrollTo(0, 0); });

  $('lnLista').addEventListener('submit', async (ev) => {
    const f = ev.target.closest('form[data-buscar]');
    if (!f) return;
    ev.preventDefault();
    const q = f.querySelector('input').value.trim();
    if (!q) return;
    try {
      busca[f.dataset.buscar] = (await api(`/api/kanban/busca?q=${encodeURIComponent(q)}`)).cards.slice(0, 8);
      if (!busca[f.dataset.buscar].length) avisar('Nenhum card ativo encontrado', true);
      carregar();
    } catch (e) { avisar(e.message, true); }
  });

  $('lnLista').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-vincular]');
    if (!b) return;
    const relId = b.closest('[data-id]').dataset.id;
    if (!b.dataset.confirmar) {
      b.dataset.confirmar = '1';
      b.dataset.texto = b.textContent;
      b.textContent = `Vincular a ${b.dataset.texto.split(' · ')[0]}? Toque de novo para confirmar`;
      setTimeout(() => { if (b.isConnected) { delete b.dataset.confirmar; b.textContent = b.dataset.texto; } }, 5000);
      return;
    }
    if (!operador()) { avisar('Abra o kanban e informe quem está usando o aparelho', true); return; }
    try {
      await api(`/api/kanban/launch/${relId}/vincular`, { json: { card_id: Number(b.dataset.vincular), operador: operador() } });
      delete busca[relId];
      avisar('Relatório vinculado ao card');
      carregar();
    } catch (e) { avisar(e.message, true); }
  });

  $('lnSync').addEventListener('click', async () => {
    $('lnSync').disabled = true;
    try {
      const r = await api('/api/kanban/launch/sync', { json: {} });
      avisar(r.novos ? `${r.novos} relatório(s) novo(s), ${r.vinculados} vinculado(s)` : 'Nenhum e-mail novo do Launch');
    } catch (e) { avisar(e.message, true); }
    $('lnSync').disabled = false;
    carregar();
  });

  carregar().catch((e) => { $('lnLista').innerHTML = `<li class="kb-erro-inline">${esc(e.message)}</li>`; });
})();
