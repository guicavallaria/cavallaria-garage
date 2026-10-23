// Gera o GMAIL_REFRESH_TOKEN (uma vez só) para o kanban ler a caixa do Launch.
//
// Quem roda: o Guilherme, no PC, logado no Google com launchcavallaria@gmail.com.
// Pré-requisito: projeto no Google Cloud com a Gmail API ativada e um "ID do cliente OAuth"
// do tipo "App para computador" (passo a passo em docs/kanban-os/04-launch-gmail.md).
//
// Uso (PowerShell, na pasta do agendamento):
//   $env:GMAIL_CLIENT_ID="…"; $env:GMAIL_CLIENT_SECRET="…"; node tools/gmail-autorizar.js
//
// O script abre o navegador na tela de consentimento do Google (permissão só de LEITURA do
// Gmail), recebe a resposta em http://127.0.0.1:53682 e mostra o refresh token na tela.
// Copie esse valor para a variável GMAIL_REFRESH_TOKEN no Railway. Ele não é gravado em arquivo.
const http = require('http');
const crypto = require('crypto');
const { exec } = require('child_process');

const PORTA = 53682;
const REDIRECT = `http://127.0.0.1:${PORTA}`;
const ESCOPO = 'https://www.googleapis.com/auth/gmail.readonly';
const { GMAIL_CLIENT_ID: ID, GMAIL_CLIENT_SECRET: SEGREDO } = process.env;

if (!ID || !SEGREDO) {
  console.error('Defina GMAIL_CLIENT_ID e GMAIL_CLIENT_SECRET antes de rodar (veja docs/kanban-os/04-launch-gmail.md).');
  process.exit(1);
}

// PKCE + state: a resposta só é aceita se vier desta execução.
const verificador = crypto.randomBytes(32).toString('base64url');
const desafio = crypto.createHash('sha256').update(verificador).digest('base64url');
const state = crypto.randomBytes(16).toString('hex');
const url = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
  client_id: ID, redirect_uri: REDIRECT, response_type: 'code', scope: ESCOPO,
  access_type: 'offline', prompt: 'consent', state, code_challenge: desafio, code_challenge_method: 'S256',
  login_hint: 'launchcavallaria@gmail.com',
});

const servidor = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== '/') { res.writeHead(404).end(); return; }
  const fim = (status, msg) => { res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' }).end(`<p style="font-family:Arial;padding:24px">${msg}</p>`); };
  if (u.searchParams.get('state') !== state) return fim(400, 'Resposta inválida. Rode o script de novo.');
  if (u.searchParams.get('error')) { fim(400, `Autorização recusada: ${u.searchParams.get('error')}`); servidor.close(); return undefined; }
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
    console.log('\nGMAIL_REFRESH_TOKEN (copie para as variáveis do Railway e não compartilhe):\n');
    console.log(j.refresh_token);
    console.log('');
  } catch (e) {
    fim(500, `Não deu certo: ${e.message}`);
    console.error('Erro:', e.message);
  }
  servidor.close();
  return undefined;
});

servidor.listen(PORTA, '127.0.0.1', () => {
  console.log('Abrindo o navegador para autorizar a leitura do Gmail (somente leitura)…');
  console.log('Se não abrir sozinho, cole este endereço no navegador:\n' + url + '\n');
  const abrir = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(abrir);
});
