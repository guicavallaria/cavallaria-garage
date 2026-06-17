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

function inicializar() {
  if (inicializado) return;
  inicializado = true;

  limparLocks();

  client = new Client({
    authStrategy: new LocalAuth({ dataPath: path.join(DATA_DIR, 'whatsapp-session') }),
    puppeteer: {
      headless: true,
      executablePath: process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      args: [
        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas', '--disable-gpu',
        '--no-first-run', '--no-zygote', '--single-process',
      ],
    },
  });

  status = 'connecting';

  client.on('qr', async (qr) => {
    status = 'qr';
    qrDataUrl = await qrcode.toDataURL(qr);
    console.log('WhatsApp: QR Code gerado. Acesse /api/whatsapp/status para escanear.');
  });

  client.on('ready', () => {
    status = 'ready';
    qrDataUrl = null;
    console.log('WhatsApp: Conectado!');
  });

  client.on('authenticated', () => {
    status = 'connecting';
    qrDataUrl = null;
  });

  client.on('auth_failure', () => {
    status = 'disconnected';
    qrDataUrl = null;
    inicializado = false;
    console.log('WhatsApp: Falha na autenticação.');
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
    console.error('WhatsApp: Erro ao inicializar:', err.message);
  });
}

function getStatus() {
  return { status, qrDataUrl };
}

async function enviarMensagem(telefone, mensagem) {
  if (status !== 'ready') throw new Error('WhatsApp não está conectado');

  const digitos = telefone.replace(/\D/g, '');
  const numero = digitos.startsWith('55') ? digitos : `55${digitos}`;

  const chatId = await client.getNumberId(numero);
  if (!chatId) throw new Error(`Número ${numero} não encontrado no WhatsApp`);

  await client.sendMessage(chatId._serialized, mensagem);
}

function reconectar() {
  inicializado = false;
  status = 'disconnected';
  qrDataUrl = null;
  inicializar();
}

module.exports = { inicializar, getStatus, enviarMensagem, reconectar };
