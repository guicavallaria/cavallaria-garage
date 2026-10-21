// Cliente HTTP do Onmotor (opção A — sem navegador).
// Login por formulário (/login → token+rand → POST /validate-login), cookie de
// sessão persistido em DATA_DIR e re-login automático quando a sessão expira.
// Nunca loga credenciais nem cookies.
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const REDIRECTS = new Set([301, 302, 303, 307, 308]);

function extrairTokenRand(html) {
  const token = (html.match(/name="token"\s+value="([^"]+)"/) || [])[1];
  const rand = (html.match(/name="rand"\s+value="([^"]+)"/) || [])[1];
  return token && rand ? { token, rand } : null;
}

function ehPaginaLogin(html) {
  return /name="senha"/.test(html) && /validate-login/.test(html);
}

class OnmotorClient {
  constructor({ baseUrl, user, pass, fetchImpl = globalThis.fetch, arquivoSessao, log = () => {} } = {}) {
    this.base = (baseUrl || process.env.ONMOTOR_BASE_URL || 'https://cavallaria.onmotor.com.br').replace(/\/$/, '');
    this.user = user ?? process.env.ONMOTOR_USER;
    this.pass = pass ?? process.env.ONMOTOR_PASS;
    this.fetch = fetchImpl;
    this.arquivoSessao = arquivoSessao === undefined ? path.join(DATA_DIR, 'onmotor-session.json') : arquivoSessao;
    this.log = log;
    this.jar = new Map();
    this.carregarSessao();
  }

  configurado() {
    return Boolean(this.user && this.pass);
  }

  // ---------- cookies ----------
  carregarSessao() {
    if (!this.arquivoSessao) return;
    try {
      const salvo = JSON.parse(fs.readFileSync(this.arquivoSessao, 'utf8'));
      for (const [k, v] of Object.entries(salvo.cookies || {})) this.jar.set(k, v);
    } catch (_) { /* sem sessão salva */ }
  }

  salvarSessao() {
    if (!this.arquivoSessao) return;
    try {
      fs.writeFileSync(this.arquivoSessao, JSON.stringify({ cookies: Object.fromEntries(this.jar), salvo_em: new Date().toISOString() }));
    } catch (e) { this.log('onmotor: não consegui salvar a sessão: ' + e.message); }
  }

  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  absorverCookies(res) {
    const lista = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of lista) {
      const [kv] = c.split(';');
      const i = kv.indexOf('=');
      if (i > 0) this.jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
    }
  }

  // ---------- HTTP ----------
  async req(caminho, opts = {}, hops = 0) {
    const url = caminho.startsWith('http') ? caminho : this.base + caminho;
    const res = await this.fetch(url, {
      ...opts,
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; painel-patio/1.0)',
        Accept: 'text/html,application/xhtml+xml',
        Cookie: this.cookieHeader(),
        ...(opts.headers || {}),
      },
    });
    this.absorverCookies(res);
    if (REDIRECTS.has(res.status) && hops < 6) {
      const loc = res.headers.get('location');
      return this.req(new URL(loc, url).toString(), { method: 'GET' }, hops + 1);
    }
    return { status: res.status, url, html: await res.text() };
  }

  async login() {
    if (!this.configurado()) throw new Error('ONMOTOR_USER/ONMOTOR_PASS não configurados');
    const pagina = await this.req('/login');
    const tr = extrairTokenRand(pagina.html);
    if (!tr) throw new Error('página de login sem token/rand (layout mudou?)');
    const body = new URLSearchParams({ ...tr, login: this.user, senha: this.pass });
    const pos = await this.req('/validate-login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: this.base + '/login', Origin: this.base },
      body,
    });
    if (ehPaginaLogin(pos.html) || /\/login(\b|$)/.test(pos.url)) throw new Error('login no Onmotor recusado');
    this.salvarSessao();
    this.log('onmotor: login ok');
  }

  // GET autenticado: se cair na tela de login, loga e tenta mais uma vez.
  async getAutenticado(caminho) {
    let r = await this.req(caminho);
    if (r.status !== 200 || ehPaginaLogin(r.html)) {
      await this.login();
      r = await this.req(caminho);
      if (r.status !== 200 || ehPaginaLogin(r.html)) throw new Error(`Onmotor respondeu ${r.status} para ${caminho} mesmo após login`);
    }
    return r;
  }

  async novidadesHtml() {
    return (await this.getAutenticado('/servicos/novidades')).html;
  }

  async osHtml(idInterno) {
    if (!/^\d+$/.test(String(idInterno))) throw new Error('id interno inválido');
    return (await this.getAutenticado(`/servicos/visualizar/${idInterno}`)).html;
  }
}

module.exports = { OnmotorClient, extrairTokenRand, ehPaginaLogin };
