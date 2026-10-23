// Administração — usuários (criar, senha provisória, desativar) e log de auditoria. Só Gerência.
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmt = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const dataBR = (iso) => (iso ? fmt.format(new Date(iso)).replace(',', '') : '—');

  async function api(caminho, opts = {}) {
    const init = { credentials: 'same-origin' };
    if (opts.json !== undefined) { init.method = 'POST'; init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(opts.json); }
    const r = await fetch(caminho, init);
    if (r.status === 401) { location.href = '/login'; throw new Error('sessão expirada'); }
    const corpo = await r.json().catch(() => ({}));
    if (r.status === 403 && corpo.trocar_senha) { location.href = '/conta.html?primeiro=1'; throw new Error(corpo.erro); }
    if (!r.ok) throw new Error(corpo.erro || `erro ${r.status}`);
    return corpo;
  }

  const main = document.querySelector('main.adm');
  const sec = document.createElement('div');
  sec.innerHTML = `
    <section class="adm-mec" id="usuarios" aria-labelledby="admUsuTitulo">
      <h2 id="admUsuTitulo" class="kb-sec">Usuários</h2>
      <p class="kb-dica">Cada pessoa ou setor entra com o próprio usuário. Senhas novas são provisórias: aparecem <strong>uma vez só</strong> aqui e a pessoa troca no primeiro acesso.
        Recepção e Gerência: acesso total · Compras e Pátio: tudo menos pós-vendas · Mecânicos: só o kanban · Administração: só Gerência.</p>
      <div id="admUsuSenhas"></div>
      <ul id="admUsuLista" class="adm-mec-lista"></ul>
      <form id="admUsuForm" class="adm-mec-form" style="flex-wrap:wrap">
        <input id="admUsuLogin" type="text" maxlength="30" placeholder="usuário (ex.: edson)" aria-label="Usuário" autocapitalize="none" autocomplete="off" style="flex:1 1 140px">
        <input id="admUsuNome" type="text" maxlength="60" placeholder="Nome" aria-label="Nome" style="flex:1 1 160px">
        <select id="admUsuPerfil" aria-label="Perfil" style="font-size:16px;padding:8px;border-radius:8px;border:1px solid #c9ced8"></select>
        <button type="submit" class="kb-botao">+ Criar usuário</button>
      </form>
      <p id="admUsuCombinadas" class="kb-dica" hidden></p>
    </section>
    <section class="adm-mec" id="auditoria" aria-labelledby="admAudTitulo">
      <h2 id="admAudTitulo" class="kb-sec">Auditoria</h2>
      <p class="kb-dica">Quem fez o quê e quando: login, mudança de fase, checklist, arquivamento, download de PDF, links do cliente, administração.</p>
      <form id="admAudForm" class="adm-mec-form" style="flex-wrap:wrap">
        <input id="admAudOs" type="search" placeholder="Nº da OS" inputmode="numeric" aria-label="Filtrar por OS" style="flex:0 1 120px">
        <input id="admAudLogin" type="search" placeholder="usuário" aria-label="Filtrar por usuário" autocapitalize="none" style="flex:0 1 140px">
        <button type="submit" class="kb-botao kb-botao-sec">Filtrar</button>
      </form>
      <div style="overflow-x:auto"><table class="adm-aud"><thead><tr><th>Quando</th><th>Usuário</th><th>Operador</th><th>Ação</th><th>OS</th><th>Detalhe</th></tr></thead><tbody id="admAudLista"></tbody></table></div>
    </section>`;
  main.prepend(...sec.children);
  const estilo = document.createElement('style');
  estilo.textContent = `.adm-aud { width: 100%; border-collapse: collapse; font-size: 13px; margin-top: 8px; }
    .adm-aud th, .adm-aud td { text-align: left; padding: 5px 8px; border-top: 1px solid var(--linha); vertical-align: top; }
    .adm-aud td:first-child { white-space: nowrap; }
    .adm-senhas { background: #fff8e1; border: 1px solid #f0d27a; border-radius: 8px; padding: 10px 12px; margin: 8px 0; font-size: 14px; }
    .adm-senhas code { font-size: 16px; font-weight: 700; letter-spacing: .5px; }
    .adm-inativo { opacity: .55; }`;
  document.head.appendChild(estilo);

  let perfis = [];

  // Senhas novas aparecem uma vez (para anotar e entregar); somem ao recarregar a página.
  function mostrarSenhas(lista, titulo) {
    if (!lista.length) return;
    $('admUsuSenhas').insertAdjacentHTML('afterbegin', `<div class="adm-senhas"><strong>${esc(titulo)}</strong> — anote e entregue a cada pessoa; não aparece de novo.
      <ul>${lista.map((s) => `<li>${esc(s.nome)} — usuário <code>${esc(s.login)}</code> · senha <code>${esc(s.senha)}</code></li>`).join('')}</ul></div>`);
  }

  async function carregarUsuarios() {
    if (window.KanbanSessao) await window.KanbanSessao.pronto;
    const r = await api('/api/acesso/usuarios');
    perfis = r.perfis;
    $('admUsuPerfil').innerHTML = perfis.map((p) => `<option value="${p.id}">${esc(p.nome)}</option>`).join('');
    const eu = (window.KanbanSessao && window.KanbanSessao.dados && window.KanbanSessao.dados.usuario) || {};
    $('admUsuLista').innerHTML = r.usuarios.length ? r.usuarios.map((u) => `<li class="${u.ativo ? '' : 'adm-inativo'}">
        <strong>${esc(u.nome)} <small>· ${esc(u.login)} · ${esc(u.perfil_nome)}${u.ativo ? '' : ' · desativado'}${u.trocar_senha && u.ativo ? ' · aguardando 1º acesso' : ''}</small></strong>
        <small>${u.ultimo_login_em ? `último acesso ${dataBR(u.ultimo_login_em)}` : 'nunca entrou'}</small>
        ${u.ativo ? `<button type="button" class="adm-mini" data-resetar="${u.id}">Senha provisória</button>` : ''}
        ${u.id === eu.id ? '' : `<button type="button" class="adm-mini" data-ativo="${u.ativo ? 0 : 1}" data-id="${u.id}">${u.ativo ? 'Desativar' : 'Reativar'}</button>`}
      </li>`).join('') : '<li>Nenhum usuário ainda.</li>';
    const faltam = r.combinadas.filter((c) => !r.usuarios.some((u) => u.login === c.login));
    $('admUsuCombinadas').hidden = !faltam.length;
    $('admUsuCombinadas').innerHTML = faltam.length ? `Contas combinadas ainda não criadas: ${faltam.map((c) => `<code>${esc(c.login)}</code>`).join(', ')}.
      <button type="button" class="kb-botao kb-botao-sec" id="admUsuCriarComb">Criar estas contas</button>` : '';
  }

  async function carregarAuditoria() {
    const q = new URLSearchParams();
    if ($('admAudOs').value.trim()) q.set('os', $('admAudOs').value.trim());
    if ($('admAudLogin').value.trim()) q.set('login', $('admAudLogin').value.trim());
    const lista = await api(`/api/kanban/admin/auditoria?${q}`);
    const detalhe = (d) => {
      if (!d) return '';
      const partes = [];
      if (d.fase_id) partes.push(`fase ${d.fase_id}`);
      if (d.codigo) partes.push(d.codigo);
      if (d.login) partes.push(d.login);
      if (d.perfil) partes.push(d.perfil);
      if (d.origem) partes.push(d.origem);
      if (d.finalidade) partes.push(d.finalidade);
      return esc(partes.join(' · '));
    };
    $('admAudLista').innerHTML = lista.length ? lista.map((a) => `<tr><td>${dataBR(a.quando)}</td><td>${esc(a.usuario_login || '—')}</td><td>${esc(a.operador || '')}</td>
      <td>${esc(a.acao.replace(/_/g, ' '))}</td><td>${esc(a.os_numero || '')}</td><td>${detalhe(a.detalhes)}</td></tr>`).join('')
      : '<tr><td colspan="6">Nada registrado com esse filtro.</td></tr>';
  }

  $('admUsuForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    try {
      const r = await api('/api/acesso/usuarios', { json: { login: $('admUsuLogin').value, nome: $('admUsuNome').value, perfil: $('admUsuPerfil').value } });
      mostrarSenhas([{ nome: r.usuario.nome, login: r.usuario.login, senha: r.senha_inicial }], 'Usuário criado');
      $('admUsuLogin').value = ''; $('admUsuNome').value = '';
      await carregarUsuarios();
    } catch (e) { alert(e.message); }
  });

  main.addEventListener('click', async (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    try {
      if (b.id === 'admUsuCriarComb') {
        b.disabled = true;
        const r = await api('/api/acesso/usuarios/combinadas', { json: {} });
        mostrarSenhas(r.criadas.map((c) => ({ nome: c.usuario.nome, login: c.usuario.login, senha: c.senha_inicial })), 'Contas criadas');
        await carregarUsuarios();
      } else if (b.dataset.resetar) {
        if (!confirm('Gerar uma senha provisória nova? A senha atual deixa de funcionar.')) return;
        const r = await api(`/api/acesso/usuarios/${b.dataset.resetar}/resetar-senha`, { json: {} });
        mostrarSenhas([{ nome: r.usuario.nome, login: r.usuario.login, senha: r.senha_provisoria }], 'Senha provisória');
        await carregarUsuarios();
      } else if (b.dataset.ativo !== undefined && b.dataset.id) {
        const ativo = b.dataset.ativo === '1';
        if (!ativo && !confirm('Desativar este usuário? Ele sai na hora de todos os aparelhos.')) return;
        await api(`/api/acesso/usuarios/${b.dataset.id}/ativo`, { json: { ativo } });
        await carregarUsuarios();
      }
    } catch (e) { alert(e.message); b.disabled = false; }
  });

  $('admAudForm').addEventListener('submit', (ev) => { ev.preventDefault(); carregarAuditoria().catch((e) => alert(e.message)); });

  carregarUsuarios().catch((e) => { $('admUsuLista').innerHTML = `<li>${esc(e.message)}</li>`; });
  carregarAuditoria().catch(() => null);
})();
