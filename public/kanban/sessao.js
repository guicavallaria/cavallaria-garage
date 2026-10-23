// Quem está logado (Etapa 7): esconde o que o perfil não pode usar, mostra a conta no topo
// e registra o service worker do PWA. O servidor confere tudo de novo; isto é só a tela.
(() => {
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const pronto = fetch('/api/acesso/me', { credentials: 'same-origin' })
    .then((r) => {
      if (r.status === 401) { location.href = '/login'; return null; }
      return r.ok ? r.json() : null;
    })
    .catch(() => null);

  window.KanbanSessao = { pronto, dados: null };

  pronto.then((s) => {
    if (!s || !s.usuario) return;
    window.KanbanSessao.dados = s;
    const p = s.permissoes || {};
    const b = document.body.classList;
    b.toggle('kb-sem-gestor', !p.gestor);
    b.toggle('kb-sem-admin', !p.admin);
    b.toggle('kb-sem-agenda', !p.agenda);
    b.toggle('kb-perfil-mecanico', s.usuario.perfil === 'mecanico');
    for (const el of document.querySelectorAll('[data-conta]')) {
      el.innerHTML = `<a class="kb-conta-nome" href="/conta.html" title="Minha conta · trocar senha">🔑 ${esc(s.usuario.nome)}</a>
        <button type="button" class="kb-btn kb-conta-sair" title="Sair deste aparelho">Sair</button>`;
      el.querySelector('.kb-conta-sair').addEventListener('click', async () => {
        try { await fetch('/logout', { method: 'POST', credentials: 'same-origin' }); } catch (_) { /* sai mesmo assim */ }
        location.href = '/login';
      });
    }
  });

  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/kanban/sw.js', { scope: '/kanban/' }).catch(() => null));
  }
})();
