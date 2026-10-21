const { test } = require('node:test');
const assert = require('node:assert/strict');
const { OnmotorClient, extrairTokenRand, ehPaginaLogin } = require('../patio/onmotor');

const LOGIN_HTML = `<html><title>Onmotor | Login</title><form action="https://x/validate-login" method="post">
<input type="hidden" name="token" value="TOK123"><input type="hidden" name="rand" value="RAND9">
<input name="login" type="login"><input name="senha" type="password"></form></html>`;
const HOME_HTML = '<html><title>Onmotor</title><a href="/logout">Sair</a></html>';
const NOVIDADES_HTML = '<html><table class="table-novidades"><tbody><tr><td data-th="Código">7001</td></tr></tbody></table></html>';

// fetch falso: responde conforme o caminho e registra as chamadas
function fakeFetch(cenario) {
  const chamadas = [];
  const f = async (url, opts = {}) => {
    const u = new URL(url);
    chamadas.push({
      path: u.pathname,
      method: opts.method || 'GET',
      cookie: (opts.headers && opts.headers.Cookie) || '',
      body: opts.body ? Object.fromEntries(new URLSearchParams(opts.body)) : null,
    });
    const r = cenario(u.pathname, opts, chamadas);
    const headers = new Headers(r.headers || {});
    headers.getSetCookie = () => r.setCookie || [];
    return { status: r.status || 200, headers, text: async () => r.html || '' };
  };
  f.chamadas = chamadas;
  return f;
}

test('extrairTokenRand/ehPaginaLogin reconhecem a página de login real', () => {
  assert.deepEqual(extrairTokenRand(LOGIN_HTML), { token: 'TOK123', rand: 'RAND9' });
  assert.equal(extrairTokenRand(HOME_HTML), null);
  assert.equal(ehPaginaLogin(LOGIN_HTML), true);
  assert.equal(ehPaginaLogin(HOME_HTML), false);
});

test('getAutenticado: sem sessão → login com token/rand/credenciais e repete o GET com o cookie', async () => {
  let logado = false;
  const fetchImpl = fakeFetch((p, opts) => {
    if (p === '/login') return { html: LOGIN_HTML, setCookie: ['OnmotorSessId=S1; path=/; HttpOnly'] };
    if (p === '/validate-login') { logado = true; return { status: 302, headers: { location: 'https://x/home' } }; }
    if (p === '/home') return { html: HOME_HTML };
    if (p === '/servicos/novidades') {
      return logado && /S1/.test(opts.headers.Cookie) ? { html: NOVIDADES_HTML } : { status: 302, headers: { location: 'https://x/login' } };
    }
    return { status: 404 };
  });
  const c = new OnmotorClient({ baseUrl: 'https://x', user: 'u', pass: 'p', fetchImpl, arquivoSessao: null });
  const html = await c.novidadesHtml();
  assert.match(html, /table-novidades/);
  const post = fetchImpl.chamadas.find((x) => x.path === '/validate-login');
  assert.deepEqual(post.body, { token: 'TOK123', rand: 'RAND9', login: 'u', senha: 'p' });
  assert.match(post.cookie, /OnmotorSessId=S1/);
  const ultimo = fetchImpl.chamadas.at(-1);
  assert.equal(ultimo.path, '/servicos/novidades');
  assert.match(ultimo.cookie, /OnmotorSessId=S1/);
});

test('getAutenticado: com sessão válida não faz login', async () => {
  const fetchImpl = fakeFetch((p) => (p === '/servicos/novidades' ? { html: NOVIDADES_HTML } : { status: 404 }));
  const c = new OnmotorClient({ baseUrl: 'https://x', user: 'u', pass: 'p', fetchImpl, arquivoSessao: null });
  c.jar.set('OnmotorSessId', 'VALIDA');
  await c.novidadesHtml();
  assert.deepEqual(fetchImpl.chamadas.map((x) => x.path), ['/servicos/novidades']);
});

test('login recusado vira erro claro (sem vazar credenciais)', async () => {
  const fetchImpl = fakeFetch((p) => {
    if (p === '/login') return { html: LOGIN_HTML };
    if (p === '/validate-login') return { html: LOGIN_HTML + '<p>Senha incorreta</p>' };
    return { status: 302, headers: { location: 'https://x/login' } };
  });
  const c = new OnmotorClient({ baseUrl: 'https://x', user: 'u', pass: 'segredo', fetchImpl, arquivoSessao: null });
  await assert.rejects(() => c.novidadesHtml(), (e) => /recusado/.test(e.message) && !/segredo/.test(e.message));
});

test('sem credenciais configuradas → erro explícito', async () => {
  const fetchImpl = fakeFetch(() => ({ status: 302, headers: { location: 'https://x/login' } }));
  const c = new OnmotorClient({ baseUrl: 'https://x', user: '', pass: '', fetchImpl, arquivoSessao: null });
  assert.equal(c.configurado(), false);
  await assert.rejects(() => c.novidadesHtml(), /ONMOTOR_USER/);
});
