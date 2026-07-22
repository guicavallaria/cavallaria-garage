const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');
const fs = require('fs');
const DATA_DIR = process.env.DATA_DIR || __dirname;

function limparLocks() {
  const LOCKS = new Set(['SingletonLock', 'SingletonCookie', 'SingletonSocket']);
  function varrer(dir) {
    try {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, e.name);
        if (e.isDirectory()) varrer(full);
        else if (LOCKS.has(e.name)) try { fs.unlinkSync(full); } catch (_) {}
      }
    } catch (_) {}
  }
  varrer(path.join(DATA_DIR, 'whatsapp-session'));
}

let client = null;
let status = 'disconnected'; // 'disconnected' | 'qr' | 'connecting' | 'ready'
let qrDataUrl = null;
let inicializado = false;
let ultimoErro = null; // mensagem do último erro de inicialização/autenticação (pra mostrar na tela)

function inicializar() {
  if (inicializado) return;
  inicializado = true;

  limparLocks();

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, 'whatsapp-session') }),
    puppeteer: {
      headless: true,
      executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      // NÃO usar --single-process / --no-zygote: com o Chrome for Testing neste
      // runtime elas causam SIGTRAP (exit 133) — comprovado via /api/whatsapp/diag
      // (v1/v2/v5 sem elas = OK; v3/v4/v6 com elas = 133). Conjunto que funciona:
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas', '--disable-gpu',
        '--no-first-run', '--disable-extensions',
      ],
    },
  });

  status = 'connecting';
  ultimoErro = null;

  client.on('qr', async (qr) => {
    status = 'qr';
    ultimoErro = null;
    qrDataUrl = await qrcode.toDataURL(qr);
    console.log('WhatsApp: QR Code gerado. Acesse /api/whatsapp/status para escanear.');
  });

  client.on('ready', () => {
    status = 'ready';
    ultimoErro = null;
    qrDataUrl = null;
    console.log('WhatsApp: Conectado!');
  });

  client.on('authenticated', () => {
    status = 'connecting';
    qrDataUrl = null;
  });

  client.on('auth_failure', (msg) => {
    status = 'disconnected';
    qrDataUrl = null;
    inicializado = false;
    ultimoErro = `Falha na autenticação: ${msg || 'desconhecida'}`;
    console.log('WhatsApp: Falha na autenticação.', msg || '');
  });

  client.on('disconnected', () => {
    status = 'disconnected';
    qrDataUrl = null;
    inicializado = false;
    console.log('WhatsApp: Desconectado.');
  });

  client.initialize().catch((err) => {
    status = 'disconnected';
    inicializado = false;
    ultimoErro = err.message;
    console.error('WhatsApp: Erro ao inicializar:', err.message);
  });
}

function getStatus() {
  return { status, qrDataUrl, erro: ultimoErro };
}

// A página do WhatsApp Web recarrega sozinha de vez em quando e deixa as
// referências do Puppeteer órfãs. Quando isso acontece, TODO envio passa a
// falhar até o cliente ser reinicializado — daí a auto-recuperação abaixo.
function sessaoOrfa(msg) {
  const m = String(msg || '');
  // Além da frame órfã, a lib às vezes perde as estruturas que injeta na página
  // do WhatsApp Web e falha com "Cannot read properties of undefined (getChat/
  // sendMessage/...)" — bug aberto na 1.34.x. Tratamos igual: reconectar.
  // Erros muito curtos ("r") são exceções minificadas vindas de dentro da página.
  return (
    /detached Frame|Execution context was destroyed|Target closed|Session closed|Protocol error|Evaluation failed|Cannot read propert|undefined \(reading/i.test(m) ||
    m.length <= 3
  );
}

async function enviarMensagem(telefone, mensagem) {
  if (status !== 'ready') throw new Error('WhatsApp não está conectado');

  const digitos = telefone.replace(/\D/g, '');
  // Só considera que já tem código do país se sobrar mais que o número nacional
  // (11 dígitos). Sem isso, um DDD 55 (ex: 55 9xxxx-xxxx) ficaria sem o +55.
  const numero = digitos.length > 11 && digitos.startsWith('55') ? digitos : `55${digitos}`;

  try {
    const chatId = await client.getNumberId(numero);
    if (!chatId) throw new Error(`Número ${numero} não encontrado no WhatsApp`);
    await client.sendMessage(chatId._serialized, mensagem);
  } catch (err) {
    if (sessaoOrfa(err.message)) {
      console.log('WhatsApp: sessão órfã detectada, reconectando...', err.message);
      reconectar(); // LocalAuth guarda a sessão: reconecta sem pedir QR de novo
      throw new Error('A sessão do WhatsApp perdeu o vínculo com a página. Reconectando — aguarde ~30s e tente de novo. Se insistir, use o botão "Abrir no WhatsApp" (envio manual, não depende disso).');
    }
    throw err;
  }
}

function reconectar() {
  // Encerra o cliente anterior ANTES de subir outro: além de evitar um processo
  // do Chrome órfão comendo memória, os dois disputariam o mesmo diretório de
  // sessão (LocalAuth) se subissem juntos.
  const anterior = client;
  client = null;
  inicializado = false;
  status = 'connecting';
  qrDataUrl = null;

  const encerrar = anterior
    ? Promise.resolve()
        .then(() => anterior.destroy())
        .catch((err) => console.log('WhatsApp: erro ao encerrar cliente anterior (ignorado):', err.message))
    : Promise.resolve();

  encerrar.then(() => inicializar());
}

module.exports = { inicializar, getStatus, enviarMensagem, reconectar };
