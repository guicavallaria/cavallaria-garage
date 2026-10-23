// Testa o bucket real (R2/S3) antes do deploy: privado, envio e leitura por URL assinada,
// CORS para o navegador (app no Railway e localhost:3457) e gravação/leitura pelo servidor.
// Uso:  node tools/testar-bucket.js
// Pede endpoint, bucket e chaves no terminal (a chave secreta não aparece na tela).
// Nada é gravado em disco; os objetos de teste são apagados no final. Não imprime chaves nem URLs assinadas.
const readline = require('readline');
const { S3Client, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const { criarStorage, lerConfig } = require('../kanban/storage');

const ORIGENS = ['https://cavallaria-garage-production.up.railway.app', 'http://localhost:3457'];

function perguntar(texto, { secreto = false, padrao = '' } = {}) {
  return new Promise((res) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (secreto) rl._writeToOutput = (s) => { if (s.includes(texto)) process.stdout.write(s); else process.stdout.write('*'); };
    rl.question(`${texto}${padrao ? ` [${padrao}]` : ''}: `, (r) => { rl.close(); if (secreto) process.stdout.write('\n'); res(r.trim() || padrao); });
  });
}

let falhas = 0;
const ok = (m) => console.log(`  ✔ ${m}`);
const erro = (m) => { falhas++; console.log(`  ✖ ${m}`); };

(async () => {
  const env = { ...process.env };
  if (!env.STORAGE_ENDPOINT) env.STORAGE_ENDPOINT = await perguntar('STORAGE_ENDPOINT (https://….r2.cloudflarestorage.com)');
  if (!env.STORAGE_BUCKET) env.STORAGE_BUCKET = await perguntar('STORAGE_BUCKET', { padrao: 'cavallaria-kanban' });
  if (!env.STORAGE_ACCESS_KEY) env.STORAGE_ACCESS_KEY = await perguntar('STORAGE_ACCESS_KEY (Access Key ID)', { secreto: true });
  if (!env.STORAGE_SECRET_KEY) env.STORAGE_SECRET_KEY = await perguntar('STORAGE_SECRET_KEY (Secret Access Key)', { secreto: true });
  if (!env.STORAGE_REGION) env.STORAGE_REGION = 'auto';

  const cfg = lerConfig(env);
  console.log(`\nTestando o bucket "${cfg.bucket}" em ${new URL(cfg.endpoint).host.replace(/^[^.]{6}/, '******')}\n`);
  if (/\/[^/]+$/.test(new URL(cfg.endpoint).pathname)) erro('O endpoint tem um caminho no final (ex.: /cavallaria-kanban): apague, deixe só até .r2.cloudflarestorage.com');
  const st = criarStorage(env);
  const s3 = new S3Client({ endpoint: cfg.endpoint, region: cfg.region, credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey } });
  const chave = `teste-instalacao/${Date.now()}.txt`;
  const chaveServidor = `teste-instalacao/${Date.now()}-servidor.txt`;
  const conteudo = `teste do kanban ${new Date().toISOString()}`;

  try {
    // 1. CORS: o navegador pergunta antes de enviar (preflight)
    console.log('1. CORS (o navegador do celular/PC pode enviar direto ao bucket?)');
    const urlPut = await st.urlUpload(chave, 'text/plain');
    for (const origem of ORIGENS) {
      const r = await fetch(urlPut, { method: 'OPTIONS', headers: { Origin: origem, 'Access-Control-Request-Method': 'PUT', 'Access-Control-Request-Headers': 'content-type' } });
      const permitido = r.headers.get('access-control-allow-origin');
      if (r.ok && (permitido === origem || permitido === '*')) ok(`envio liberado para ${origem}`);
      else erro(`envio BLOQUEADO para ${origem} (HTTP ${r.status}) — confira a política de CORS do bucket`);
    }

    // 2. Envio pela URL assinada (como o navegador faz)
    console.log('2. Envio por URL assinada');
    const put = await fetch(urlPut, { method: 'PUT', headers: { 'Content-Type': 'text/plain', Origin: ORIGENS[0] }, body: conteudo });
    if (put.ok) ok(`arquivo enviado (HTTP ${put.status})`);
    else { erro(`envio recusado (HTTP ${put.status}): ${(await put.text()).slice(0, 200)}`); throw new Error('sem envio, o resto não dá para testar'); }
    if (put.headers.get('access-control-expose-headers') && /etag/i.test(put.headers.get('access-control-expose-headers'))) ok('ETag exposto ao navegador');

    // 3. Servidor confere o arquivo
    console.log('3. Servidor confere o arquivo (HEAD)');
    const inf = await st.info(chave);
    if (inf.existe && inf.tamanho === Buffer.byteLength(conteudo)) ok(`existe, ${inf.tamanho} bytes, tipo ${inf.contentType}`);
    else erro(`conferência falhou: ${JSON.stringify(inf)}`);

    // 4. Leitura por URL assinada de 15 min (como a linha do tempo faz)
    console.log('4. Leitura por URL assinada');
    const get = await fetch(await st.urlVer(chave, { nomeArquivo: 'teste.txt', contentType: 'text/plain' }), { headers: { Origin: ORIGENS[0] } });
    const corpo = await get.text();
    if (get.ok && corpo === conteudo) ok('conteúdo lido igual ao enviado');
    else erro(`leitura falhou (HTTP ${get.status})`);

    // 5. Bucket privado: sem assinatura não abre
    console.log('5. Bucket privado');
    const semAssinatura = await fetch(`${cfg.endpoint}/${cfg.bucket}/${chave}`);
    if (semAssinatura.status === 400 || semAssinatura.status === 401 || semAssinatura.status === 403) ok(`sem assinatura é recusado (HTTP ${semAssinatura.status})`);
    else erro(`ATENÇÃO: abriu sem assinatura (HTTP ${semAssinatura.status}) — o bucket não pode ser público`);

    // 6. Servidor grava e lê (PDFs gerados no servidor)
    console.log('6. Servidor grava e lê (PDFs)');
    await st.enviar(chaveServidor, Buffer.from(conteudo), 'text/plain');
    if ((await st.ler(chaveServidor)).toString() === conteudo) ok('gravação e leitura pelo servidor');
    else erro('leitura pelo servidor diferente do gravado');
  } catch (e) {
    erro(`erro: ${e.name || ''} ${e.message}`);
  } finally {
    for (const k of [chave, chaveServidor]) {
      try { await s3.send(new DeleteObjectCommand({ Bucket: cfg.bucket, Key: k })); } catch (_) { /* pode não existir */ }
    }
  }

  console.log(falhas ? `\n${falhas} problema(s). Copie esta saída para o Claude (não tem chave nem senha nela).` : '\nTudo certo: o bucket está pronto para o kanban.');
  process.exit(falhas ? 1 : 0);
})();
