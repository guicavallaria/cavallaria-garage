// Object storage compatível com S3 (Railway Buckets, Cloudflare R2, MinIO…).
//
// Regra do projeto: foto, vídeo, áudio e PDF NUNCA vão para o disco do serviço nem para
// o volume do Railway. O navegador envia direto para o bucket por URL assinada (PUT);
// o backend só gera a URL e grava os metadados. Ver também por URL assinada, com
// validade curta. Nada no bucket é público.
//
// Variáveis de ambiente:
//   STORAGE_ENDPOINT     ex.: https://<conta>.r2.cloudflarestorage.com  (ou http://localhost:9000 no dev)
//   STORAGE_BUCKET       nome do bucket
//   STORAGE_ACCESS_KEY   chave de acesso
//   STORAGE_SECRET_KEY   segredo
//   STORAGE_PUBLIC_URL   (opcional) endereço do bucket visto pelo NAVEGADOR, quando for diferente
//                        do endpoint que o servidor usa (rede interna). As URLs continuam assinadas.
//   STORAGE_REGION       (opcional) padrão "auto" (R2); MinIO/AWS usam ex.: "us-east-1"
//   STORAGE_PATH_STYLE   (opcional) "true" para endereços /bucket/chave (MinIO, emulador local)
const { S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const VALIDADE_UPLOAD_S = 60 * 60;     // 1 h: vídeo grande no 4G do pátio pode demorar
const VALIDADE_VER_S = 15 * 60;        // 15 min para ver (prompt, seção 12)

function lerConfig(env = process.env) {
  const cfg = {
    endpoint: (env.STORAGE_ENDPOINT || '').replace(/\/$/, ''),
    bucket: env.STORAGE_BUCKET || '',
    accessKeyId: env.STORAGE_ACCESS_KEY || '',
    secretAccessKey: env.STORAGE_SECRET_KEY || '',
    publicUrl: (env.STORAGE_PUBLIC_URL || '').replace(/\/$/, ''),
    region: env.STORAGE_REGION || 'auto',
    pathStyle: env.STORAGE_PATH_STYLE === 'true',
  };
  cfg.configurado = Boolean(cfg.endpoint && cfg.bucket && cfg.accessKeyId && cfg.secretAccessKey);
  return cfg;
}

function criarCliente(cfg, endpoint) {
  return new S3Client({
    endpoint,
    region: cfg.region,
    forcePathStyle: cfg.pathStyle,
    credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    // Sem isto as versões novas do SDK põem um checksum CRC32 do corpo VAZIO na URL
    // assinada, e o PUT do navegador (com o arquivo) é recusado.
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  });
}

function criarStorage(env = process.env) {
  const cfg = lerConfig(env);
  if (!cfg.configurado) {
    return {
      configurado: false,
      motivo: 'STORAGE_ENDPOINT, STORAGE_BUCKET, STORAGE_ACCESS_KEY e STORAGE_SECRET_KEY não configurados',
    };
  }
  const interno = criarCliente(cfg, cfg.endpoint);
  // URLs para o navegador são assinadas já com o endereço público (a assinatura inclui o host).
  const publico = cfg.publicUrl ? criarCliente(cfg, cfg.publicUrl) : interno;

  return {
    configurado: true,
    bucket: cfg.bucket,

    // URL para o navegador enviar o arquivo. O Content-Type entra na assinatura:
    // o PUT tem que mandar exatamente o mesmo.
    async urlUpload(chave, contentType, { validade = VALIDADE_UPLOAD_S } = {}) {
      const cmd = new PutObjectCommand({ Bucket: cfg.bucket, Key: chave, ContentType: contentType });
      return getSignedUrl(publico, cmd, { expiresIn: validade, signableHeaders: new Set(['content-type']) });
    },

    // URL para ver/baixar. `nomeArquivo` vira o nome sugerido no download.
    async urlVer(chave, { validade = VALIDADE_VER_S, nomeArquivo = null, contentType = null } = {}) {
      const cmd = new GetObjectCommand({
        Bucket: cfg.bucket,
        Key: chave,
        ...(nomeArquivo ? { ResponseContentDisposition: `inline; filename="${String(nomeArquivo).replace(/[^\w.\-]/g, '_')}"` } : {}),
        ...(contentType ? { ResponseContentType: contentType } : {}),
      });
      return getSignedUrl(publico, cmd, { expiresIn: validade });
    },

    // Confere se o objeto chegou (tamanho e tipo) antes de publicar na linha do tempo.
    async info(chave) {
      try {
        const r = await interno.send(new HeadObjectCommand({ Bucket: cfg.bucket, Key: chave }));
        return { existe: true, tamanho: Number(r.ContentLength), contentType: r.ContentType || null };
      } catch (e) {
        const status = e && e.$metadata && e.$metadata.httpStatusCode;
        if (status === 404 || e.name === 'NotFound' || e.name === 'NoSuchKey') return { existe: false };
        throw e;
      }
    },

    // Para PDFs gerados no servidor (Etapas 4 e 5).
    async enviar(chave, corpo, contentType) {
      await interno.send(new PutObjectCommand({ Bucket: cfg.bucket, Key: chave, Body: corpo, ContentType: contentType }));
    },
  };
}

module.exports = { criarStorage, lerConfig, VALIDADE_UPLOAD_S, VALIDADE_VER_S };
