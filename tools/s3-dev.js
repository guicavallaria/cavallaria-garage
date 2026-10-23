// Emulador mínimo de S3 SÓ PARA DESENVOLVIMENTO E TESTES (nunca usar em produção).
//
// Substitui o MinIO na máquina de desenvolvimento, que não tem Docker. Roda num processo
// separado do app e guarda os arquivos numa pasta local. Implementa só o que o kanban usa:
// PUT, GET e HEAD de objeto, com endereço /bucket/chave, CORS para o navegador e
// verificação da assinatura AWS SigV4 (URL assinada e cabeçalho Authorization) e da validade.
// Assim um link vencido ou adulterado é recusado aqui do mesmo jeito que no bucket real.
//
// Uso: node tools/s3-dev.js   (variáveis: S3DEV_PORTA, S3DEV_DIR, S3DEV_BUCKET, S3DEV_ACCESS_KEY, S3DEV_SECRET_KEY)
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const hmac = (k, s) => crypto.createHmac('sha256', k).update(s).digest();
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const enc = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());

// "20261023T120000Z" → Date
function dataAmz(s) {
  const m = String(s || '').match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

function assinatura(secret, { metodo, caminho, query, headers, assinados, payload, amzDate, escopo }) {
  const canonQuery = Object.keys(query).filter((k) => k !== 'X-Amz-Signature').sort()
    .map((k) => `${enc(k)}=${enc(query[k])}`).join('&');
  const canonHeaders = assinados.map((h) => `${h}:${String(headers[h] ?? '').trim().replace(/\s+/g, ' ')}\n`).join('');
  const canon = [metodo, caminho, canonQuery, canonHeaders, assinados.join(';'), payload].join('\n');
  const [data, regiao, servico] = escopo.split('/');
  const aAssinar = ['AWS4-HMAC-SHA256', amzDate, escopo, sha256(canon)].join('\n');
  const chave = hmac(hmac(hmac(hmac('AWS4' + secret, data), regiao), servico), 'aws4_request');
  return crypto.createHmac('sha256', chave).update(aAssinar).digest('hex');
}

// Devolve null se a requisição está assinada e válida, senão o motivo da recusa.
function conferir(req, url, { accessKey, secret, agora = new Date() }) {
  const query = Object.fromEntries(url.searchParams);
  const headers = req.headers;
  const caminho = url.pathname; // chaves do kanban só usam [a-z0-9/._-]: não precisam de re-encode
  let credencial, assinados, recebida, amzDate, payload, validadeS = null;

  if (query['X-Amz-Signature']) {
    credencial = query['X-Amz-Credential'];
    assinados = String(query['X-Amz-SignedHeaders'] || '').split(';').filter(Boolean);
    recebida = query['X-Amz-Signature'];
    amzDate = query['X-Amz-Date'];
    payload = query['X-Amz-Content-Sha256'] || 'UNSIGNED-PAYLOAD';
    validadeS = Number(query['X-Amz-Expires']);
  } else if (/^AWS4-HMAC-SHA256 /.test(headers.authorization || '')) {
    const a = headers.authorization;
    credencial = (a.match(/Credential=([^,\s]+)/) || [])[1];
    assinados = ((a.match(/SignedHeaders=([^,\s]+)/) || [])[1] || '').split(';');
    recebida = (a.match(/Signature=([0-9a-f]+)/) || [])[1];
    amzDate = headers['x-amz-date'];
    payload = headers['x-amz-content-sha256'] || 'UNSIGNED-PAYLOAD';
  } else {
    return 'requisição sem assinatura';
  }

  const [chaveAcesso, ...resto] = String(credencial || '').split('/');
  if (chaveAcesso !== accessKey) return 'chave de acesso inválida';
  const quando = dataAmz(amzDate);
  if (!quando) return 'data da assinatura inválida';
  if (validadeS !== null) {
    if (!(validadeS > 0 && validadeS <= 7 * 86400)) return 'validade inválida';
    if (agora.getTime() > quando.getTime() + validadeS * 1000) return 'URL assinada vencida';
  } else if (Math.abs(agora.getTime() - quando.getTime()) > 15 * 60_000) {
    return 'relógio da assinatura fora do prazo';
  }
  const esperada = assinatura(secret, {
    metodo: req.method, caminho, query, headers, assinados, payload, amzDate, escopo: resto.join('/'),
  });
  const ok = recebida && esperada.length === recebida.length &&
    crypto.timingSafeEqual(Buffer.from(esperada), Buffer.from(recebida));
  return ok ? null : 'assinatura não confere';
}

function erroXml(res, status, codigo, msg) {
  res.writeHead(status, { 'Content-Type': 'application/xml', 'Access-Control-Allow-Origin': '*' });
  res.end(`<?xml version="1.0" encoding="UTF-8"?><Error><Code>${codigo}</Code><Message>${msg}</Message></Error>`);
}

function iniciarS3Dev({ porta = 9000, dir, bucket = 'kanban-dev', accessKey = 'devkey', secret = 'devsecret', log = console.log } = {}) {
  const raiz = path.resolve(dir || path.join(process.cwd(), '.s3-dev'));
  fs.mkdirSync(path.join(raiz, bucket), { recursive: true });

  const servidor = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, PUT, HEAD',
      'Access-Control-Allow-Headers': '*',
      'Access-Control-Expose-Headers': 'ETag, Content-Length',
      'Access-Control-Max-Age': '600',
    };
    if (req.method === 'OPTIONS') { res.writeHead(204, cors); return res.end(); }

    const [, b, ...partes] = url.pathname.split('/');
    const chave = partes.join('/');
    if (b !== bucket || !chave || !/^[a-z0-9][a-z0-9/._-]*$/i.test(chave) || chave.includes('..')) {
      return erroXml(res, 404, 'NoSuchBucket', 'bucket ou chave inválidos');
    }
    const motivo = conferir(req, url, { accessKey, secret });
    if (motivo) return erroXml(res, 403, 'AccessDenied', motivo);

    const arquivo = path.join(raiz, bucket, ...chave.split('/'));
    const meta = arquivo + '.meta.json';

    if (req.method === 'PUT') {
      fs.mkdirSync(path.dirname(arquivo), { recursive: true });
      const tmp = arquivo + '.parcial';
      const out = fs.createWriteStream(tmp);
      req.pipe(out);
      out.on('finish', () => {
        fs.renameSync(tmp, arquivo);
        fs.writeFileSync(meta, JSON.stringify({ contentType: req.headers['content-type'] || 'application/octet-stream' }));
        const etag = '"' + crypto.createHash('md5').update(fs.readFileSync(arquivo)).digest('hex') + '"';
        res.writeHead(200, { ...cors, ETag: etag });
        res.end();
      });
      out.on('error', (e) => erroXml(res, 500, 'InternalError', e.message));
      return undefined;
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      if (!fs.existsSync(arquivo)) return erroXml(res, 404, 'NoSuchKey', 'objeto não existe');
      const st = fs.statSync(arquivo);
      let tipo = 'application/octet-stream';
      try { tipo = JSON.parse(fs.readFileSync(meta, 'utf8')).contentType; } catch (_) { /* sem meta */ }
      if (url.searchParams.get('response-content-type')) tipo = url.searchParams.get('response-content-type');
      const cab = { ...cors, 'Content-Type': tipo, 'Accept-Ranges': 'bytes', 'Last-Modified': st.mtime.toUTCString() };
      const disp = url.searchParams.get('response-content-disposition');
      if (disp) cab['Content-Disposition'] = disp;

      // Range: os players de vídeo/áudio (Safari principalmente) pedem pedaços.
      const range = (req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
      if (range && req.method === 'GET') {
        const ini = range[1] ? Number(range[1]) : Math.max(0, st.size - Number(range[2]));
        const fim = range[1] && range[2] ? Math.min(Number(range[2]), st.size - 1) : st.size - 1;
        res.writeHead(206, { ...cab, 'Content-Range': `bytes ${ini}-${fim}/${st.size}`, 'Content-Length': fim - ini + 1 });
        return fs.createReadStream(arquivo, { start: ini, end: fim }).pipe(res);
      }
      res.writeHead(200, { ...cab, 'Content-Length': st.size });
      if (req.method === 'HEAD') return res.end();
      return fs.createReadStream(arquivo).pipe(res);
    }
    return erroXml(res, 405, 'MethodNotAllowed', 'método não suportado');
  });

  return new Promise((resolve) => {
    servidor.listen(porta, '0.0.0.0', () => {
      const p = servidor.address().port;
      log(`s3-dev: http://localhost:${p}/${bucket} (pasta ${raiz}) — SÓ DESENVOLVIMENTO`);
      resolve({ servidor, porta: p, fechar: () => new Promise((r) => servidor.close(r)) });
    });
  });
}

if (require.main === module) {
  iniciarS3Dev({
    porta: Number(process.env.S3DEV_PORTA) || 9000,
    dir: process.env.S3DEV_DIR,
    bucket: process.env.S3DEV_BUCKET || 'kanban-dev',
    accessKey: process.env.S3DEV_ACCESS_KEY || 'devkey',
    secret: process.env.S3DEV_SECRET_KEY || 'devsecret',
  });
}

module.exports = { iniciarS3Dev, conferir };
