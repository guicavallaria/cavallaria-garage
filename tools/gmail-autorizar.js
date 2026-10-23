// Gera o GMAIL_REFRESH_TOKEN (uma vez só) para o kanban ler a caixa do Launch.
//
// Quem roda: o Guilherme, no PC, logado no Google com launchcavallaria@gmail.com.
// Pré-requisito: projeto no Google Cloud com a Gmail API ativada e um "ID do cliente OAuth"
// do tipo "App para computador" (passo a passo em docs/kanban-os/04-launch-gmail.md).
//
// Uso (na pasta do agendamento):  node tools/gmail-autorizar.js
//   Pede o ID do cliente e a chave secreta (a chave não aparece na tela; também aceita
//   GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET no ambiente).
//
// O script abre o navegador na tela de consentimento do Google (permissão só de LEITURA do
// Gmail), recebe a resposta em http://127.0.0.1:53682, testa o token lendo a caixa e oferece
// gravar as 3 variáveis direto no Railway (CLI logada, valor pelo stdin, sem aparecer na tela).
// Nada é gravado em arquivo.
const http = require('http');
const crypto = require('crypto');
const readline = require('readline');
const { exec, spawn } = require('child_process');
const { BUSCA_PADRAO } = require('../kanban/gmail');

const PORTA = 53682;
const REDIRECT = `http://127.0.0.1:${PORTA}`;
const ESCOPO = 'https://www.googleapis.com/auth/gmail.readonly';
const CONTA = 'launchcavallaria@gmail.com';
// Serviço do agendamento no Railway (projeto celebrated-mindfulness, ambiente production)
const RAILWAY = ['-p', '41e9a30f-0c33-44ee-95f5-42fc6b7b1e8f', '-e', 'production', '-s', 'cavallaria-garage'];

function perguntar(texto, { secreto = false } = {}) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (secreto) rl._writeToOutput = (s) => { if (s.includes(texto)) process.stdout.write(s); else process.stdout.write('*'); };
    rl.question(`${texto}: `, (r) => { rl.close(); if (secreto) process.stdout.write('\n'); res(r.trim()); });
  });
}

// Grava uma variável no Railway pela CLI, com o valor no stdin (não vai para a linha de comando).
function gravarNoRailway(chave, valor, { deploy }) {
  return new Promise((res) => {
    const args = ['-y', '@railway/cli@latest', 'variable', 'set', chave, '--stdin', ...RAILWAY, ...(deploy ? [] : ['--skip-deploys'])];
    const p = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', args, { shell: process.platform === 'win32', stdio: ['pipe', 'ignore', 'pipe'] });
    let erro = '';
    p.stderr.on('data', (d) => { erro += d; });
    p.on('close', (code) => res(code === 0 ? null : (erro.split('\n').filter((l) => /error|erro|unauthor/i.test(l)).join(' ') || `saída ${code}`)));
    p.stdin.end(valor);
  });
}

async function testarToken(id, segredo, refresh) {
  const t = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: id, client_secret: segredo, refresh_token: refresh, grant_type: 'refresh_token' }).toString(),
  }).then((r) => r.json());
  if (!t.access_token) throw new Error(t.error_description || t.error || 'sem access token');
  const h = { Authorization: `Bearer ${t.access_token}` };
  const perfil = await fetch('https://gmail.googleapis.com/gmail/v1/users/me/profile', { headers: h }).then((r) => r.json());
  const busca = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=50&q=${encodeURIComponent(BUSCA_PADRAO)}`, { headers: h }).then((r) => r.json());
  return { conta: perfil.emailAddress, emails: (busca.messages || []).length };
}

(async () => {
  const ID = process.env.GMAIL_CLIENT_ID || await perguntar('ID do cliente OAuth (termina em .apps.googleusercontent.com)');
  const SEGREDO = process.env.GMAIL_CLIENT_SECRET || await perguntar('Chave secreta do cliente', { secreto: true });
  if (!ID || !SEGREDO) { console.error('ID e chave secreta são obrigatórios.'); process.exit(1); }

  // PKCE + state: a resposta só é aceita se vier desta execução.
  const verificador = crypto.randomBytes(32).toString('base64url');
  const desafio = crypto.createHash('sha256').update(verificador).digest('base64url');
  const state = crypto.randomBytes(16).toString('hex');
  const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id: ID, redirect_uri: REDIRECT, response_type: 'code', scope: ESCOPO,
    access_type: 'offline', prompt: 'consent', state, code_challenge: desafio, code_challenge_method: 'S256',
    login_hint: CONTA,
  });

  const refresh = await new Promise((resolver) => {
    const servidor = http.createServer(async (req, res) => {
      const u = new URL(req.url, REDIRECT);
      if (u.pathname !== '/') { res.writeHead(404).end(); return; }
      const fim = (status, msg) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<p style="font-family:Arial;padding:24px">${msg}</p>`); };
      if (u.searchParams.get('state') !== state) { fim(400, 'Resposta inválida. Rode o script de novo.'); return; }
      if (u.searchParams.get('error')) { fim(400, `Autorização recusada: ${u.searchParams.get('error')}`); servidor.close(); resolver(null); return; }
      try {
        const r = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({
            code: u.searchParams.get('code'), client_id: ID, client_secret: SEGREDO, redirect_uri: REDIRECT,
            grant_type: 'authorization_code', code_verifier: verificador,
          }).toString(),
        });
        const j = await r.json();
        if (!r.ok || !j.refresh_token) throw new Error(j.error_description || j.error || 'o Google não devolveu refresh token');
        fim(200, 'Pronto! Pode fechar esta aba e voltar ao terminal.');
        resolver(j.refresh_token);
      } catch (e) {
        fim(500, `Não deu certo: ${e.message}`);
        console.error('Erro:', e.message);
        resolver(null);
      }
      servidor.close();
    });
    servidor.listen(PORTA, '127.0.0.1', () => {
      console.log(`\nAbrindo o navegador para autorizar a leitura do Gmail (somente leitura). Entre com ${CONTA}.`);
      console.log('Se não abrir sozinho, cole este endereço no navegador:\n' + url + '\n');
      exec(process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`);
    });
  });
  if (!refresh) process.exit(1);

  console.log('Autorizado. Testando a leitura da caixa…');
  try {
    const t = await testarToken(ID, SEGREDO, refresh);
    console.log(`  ✔ conta: ${t.conta}`);
    if (t.conta !== CONTA) console.log(`  ⚠ esperado ${CONTA} — confira se entrou na conta certa`);
    console.log(`  ✔ e-mails do Launch com PDF nos últimos 30 dias: ${t.emails}${t.emails === 50 ? '+' : ''}`);
  } catch (e) {
    console.log(`  ✖ teste falhou: ${e.message}`);
  }

  const resp = (await perguntar('\nGravar GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET e GMAIL_REFRESH_TOKEN direto no Railway? (s/n)')).toLowerCase();
  if (resp.startsWith('s')) {
    const itens = [['GMAIL_CLIENT_ID', ID], ['GMAIL_CLIENT_SECRET', SEGREDO], ['GMAIL_REFRESH_TOKEN', refresh]];
    let falhou = false;
    for (let i = 0; i < itens.length; i++) {
      const [k, v] = itens[i];
      const erro = await gravarNoRailway(k, v, { deploy: i === itens.length - 1 }); // o último dispara o redeploy
      console.log(erro ? `  ✖ ${k}: ${erro}` : `  ✔ ${k} gravada no Railway`);
      falhou = falhou || Boolean(erro);
    }
    if (!falhou) { console.log('\nPronto: o Railway vai reiniciar o app e a leitura do Launch liga sozinha.'); process.exit(0); }
    console.log('\nNão consegui gravar tudo. Copie o token abaixo para o Railway à mão:');
  }
  console.log('\nGMAIL_REFRESH_TOKEN (copie para as variáveis do Railway e não compartilhe):\n');
  console.log(refresh + '\n');
  process.exit(0);
})();
