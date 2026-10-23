// Service worker do kanban (PWA): deixa o app instalável e abre a "casca" (HTML, CSS, JS,
// ícones) mesmo com o sinal ruim do pátio. Dados (/api) e mídias NUNCA passam pelo cache:
// sempre vão à rede, e o envio de fotos/vídeos continua na fila do IndexedDB (midia.js).
const VERSAO = 'kanban-v1';
const CASCA = [
  '/kanban/', '/kanban/kanban.css', '/kanban/kanban.js', '/kanban/midia.js', '/kanban/checklist.js', '/kanban/sessao.js',
  '/kanban/img/logo-cavallaria-garage.webp', '/kanban/icons/icon-192.png',
];

self.addEventListener('install', (ev) => {
  // a casca pode falhar (sessão expirada redireciona para o login): instala mesmo assim
  ev.waitUntil(caches.open(VERSAO).then((c) => Promise.all(CASCA.map((u) => c.add(u).catch(() => null)))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (ev) => {
  ev.waitUntil(caches.keys()
    .then((ks) => Promise.all(ks.filter((k) => k !== VERSAO).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

// Rede primeiro; o cache só responde quando a rede falha. Só guarda respostas 200 do próprio
// kanban que não vieram de redirecionamento (para nunca guardar a tela de login no lugar do app).
self.addEventListener('fetch', (ev) => {
  const req = ev.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (!url.pathname.startsWith('/kanban/') || url.pathname.startsWith('/api/')) return;
  ev.respondWith(fetch(req).then((resp) => {
    if (resp.ok && !resp.redirected && resp.type === 'basic') {
      const copia = resp.clone();
      caches.open(VERSAO).then((c) => c.put(req, copia)).catch(() => null);
    }
    return resp;
  }).catch(() => caches.match(req, { ignoreSearch: true }).then((r) => r || (req.mode === 'navigate'
    ? caches.match('/kanban/')
    : Response.error()))));
});
