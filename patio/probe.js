// Fase 0 — sonda de acesso ao Onmotor por HTTP puro (sem navegador).
//
// Testa: (1) login em /validate-login com token+rand da página /login,
//        (2) descoberta do link da aba "Novidades" na home logada,
//        (3) leitura da Novidades e sinais de que é server-rendered.
//
// Uso (PowerShell):  $env:ONMOTOR_USER='...'; $env:ONMOTOR_PASS='...'; node patio/probe.js
// Uso (bash):        ONMOTOR_USER=... ONMOTOR_PASS=... node patio/probe.js
//
// Nunca imprime credenciais nem cookies. O HTML lido é salvo na pasta temporária
// do sistema (caminho impresso no fim) para servir de fixture dos testes.
const fs = require('fs');
const os = require('os');
const path = require('path');

const BASE = (process.env.ONMOTOR_BASE_URL || 'https://cavallaria.onmotor.com.br').replace(/\/$/, '');
const USER = process.env.ONMOTOR_USER;
const PASS = process.env.ONMOTOR_PASS;
const PATH_SUGERIDO = process.env.ONMOTOR_NOVIDADES_PATH || '';

if (!USER || !PASS) {
  console.error('Defina ONMOTOR_USER e ONMOTOR_PASS no ambiente antes de rodar.');
  process.exit(2);
}

// ---------- cookie jar mínimo ----------
const jar = new Map();
function cookieHeader() {
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}
function absorverCookies(res) {
  const lista = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
  for (const c of lista) {
    const [kv] = c.split(';');
    const i = kv.indexOf('=');
    if (i > 0) jar.set(kv.slice(0, i).trim(), kv.slice(i + 1).trim());
  }
}

async function req(caminho, opts = {}, hops = 0) {
  const url = caminho.startsWith('http') ? caminho : BASE + caminho;
  let res;
  try {
    res = await fetch(url, {
      ...opts,
      redirect: 'manual',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; painel-patio-probe)',
        Accept: 'text/html,application/xhtml+xml',
        Cookie: cookieHeader(),
        ...(opts.headers || {}),
      },
    });
  } catch (e) {
    const causa = e.cause ? ` | causa: ${e.cause.code || ''} ${e.cause.message || ''}`.trim() : '';
    throw new Error(`${opts.method || 'GET'} ${url} → ${e.message}${causa}`);
  }
  absorverCookies(res);
  if ([301, 302, 303, 307, 308].includes(res.status) && hops < 6) {
    const loc = res.headers.get('location');
    console.log(`  ↪ ${res.status} ${url} → ${loc}`);
    return req(new URL(loc, url).toString(), { method: 'GET' }, hops + 1);
  }
  return { status: res.status, url, html: await res.text() };
}


function contar(html, rx) {
  return (html.match(rx) || []).length;
}
function titulo(html) {
  return ((html.match(/<title>([^<]*)<\/title>/i) || [])[1] || '').trim();
}

(async () => {
  const resumo = { base: BASE, etapas: [] };

  // 1) página de login → token + rand
  const login = await req('/login');
  const token = (login.html.match(/name="token"\s+value="([^"]+)"/) || [])[1];
  const rand = (login.html.match(/name="rand"\s+value="([^"]+)"/) || [])[1];
  resumo.etapas.push({ etapa: 'GET /login', status: login.status, temToken: !!token, temRand: !!rand, cookies: [...jar.keys()] });
  if (!token || !rand) {
    console.log(JSON.stringify(resumo, null, 2));
    console.error('Não achei token/rand na página de login — layout mudou?');
    process.exit(1);
  }

  // 2) POST /validate-login
  const body = new URLSearchParams({ token, rand, login: USER, senha: PASS });
  const pos = await req('/validate-login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Referer: BASE + '/login', Origin: BASE },
    body,
  });
  const aindaNoLogin = /\/login(\b|$)/.test(pos.url) || /name="senha"/.test(pos.html);
  resumo.etapas.push({ etapa: 'POST /validate-login', status: pos.status, urlFinal: pos.url, logado: !aindaNoLogin, titulo: titulo(pos.html) });
  if (aindaNoLogin) {
    console.log(JSON.stringify(resumo, null, 2));
    console.error('Login não aceito (ainda na tela de login). Confira usuário/senha ou se há bloqueio.');
    process.exit(1);
  }

  // 3) descobrir links de "Novidades" na home
  const home = /\/home/.test(pos.url) ? pos : await req('/home');
  const hrefs = new Set();
  for (const m of home.html.matchAll(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = m[1];
    const texto = m[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (/novidade/i.test(href) || /novidade/i.test(texto)) hrefs.add(href);
  }
  if (PATH_SUGERIDO) hrefs.add(PATH_SUGERIDO);
  for (const p of ['/servicos/novidades', '/servicos/novidade', '/novidades']) hrefs.add(p);
  resumo.etapas.push({ etapa: 'GET /home', status: home.status, candidatosNovidades: [...hrefs] });

  // 4) ler cada candidato e medir sinais de server-rendering
  const outDir = path.join(os.tmpdir(), 'painel-patio-probe');
  fs.mkdirSync(outDir, { recursive: true });
  const leituras = [];
  let n = 0;
  for (const href of hrefs) {
    const r = await req(href);
    const linksOS = new Set([...r.html.matchAll(/\/servicos\/visualizar\/(\d+)/g)].map((m) => m[1]));
    const info = {
      href,
      status: r.status,
      urlFinal: r.url,
      bytes: r.html.length,
      titulo: titulo(r.html),
      voltouParaLogin: /name="senha"/.test(r.html),
      osDistintas: linksOS.size,
      linhasTabela: contar(r.html, /<tr\b/gi),
      usaExecuteAjaxJson: /executeAjaxJson/.test(r.html),
      temPaginacao: /pagination|goToPage/.test(r.html),
      cabecalhos: [...r.html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/gi)].map((m) => m[1].replace(/<[^>]+>/g, '').trim()).filter(Boolean).slice(0, 20),
    };
    if (r.status === 200 && !info.voltouParaLogin) {
      const arq = path.join(outDir, `novidades_${++n}.html`);
      fs.writeFileSync(arq, r.html);
      info.salvoEm = arq;
    }
    leituras.push(info);
  }
  resumo.etapas.push({ etapa: 'leitura da Novidades', leituras });

  console.log(JSON.stringify(resumo, null, 2));
  const ok = leituras.find((l) => l.status === 200 && !l.voltouParaLogin && l.osDistintas > 0);
  console.log(ok
    ? `\n✅ Opção A viável: "${ok.href}" é server-rendered (${ok.osDistintas} OS encontradas sem JS). Fixture em ${ok.salvoEm}`
    : '\n⚠️ Nenhum candidato trouxe OS no HTML puro — provavelmente a aba carrega por AJAX (cair para a opção B) ou a URL é outra (me passe a URL da aba Novidades).');
})().catch((e) => {
  console.error('Falha na sonda:', e.message);
  process.exit(1);
});
