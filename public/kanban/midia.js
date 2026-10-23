// Mídia no navegador (Etapa 3): preparar o arquivo e enviar com tolerância a rede ruim.
//
//  - Foto: comprimida no aparelho (lado maior até 1920 px, JPEG ~80%) + miniatura de 400 px.
//  - Vídeo: no máximo 2 min (lido do próprio arquivo), aviso de tamanho, miniatura do 1º quadro.
//  - Áudio: gravado na página (MediaRecorder) ou escolhido de arquivo.
//  - Fila: cada envio fica guardado no aparelho (IndexedDB) até o servidor confirmar.
//    Cai a rede, fecha a aba, reinicia o celular: ao voltar, o envio continua de onde parou,
//    com tentativas espaçadas. O mesmo `cliente_id` impede registro duplicado.
(() => {
  const MAX_LADO = 1920;
  const QUALIDADE = 0.8;
  const MINI_LADO = 400;
  const VIDEO_MAX_S = 120;
  const VIDEO_AVISO_MB = 80;
  const ESPERAS_S = [3, 8, 20, 45, 90, 180, 300];

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    }));
  const mimeBase = (m) => String(m || '').split(';')[0].trim().toLowerCase();
  // "0,4 MB" / "85 KB": abaixo de 1 MB mostra em KB (áudio curto daria "0 MB").
  const tamanhoTexto = (bytes) => (bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} MB`);
  const mb = (bytes) => (bytes / 1024 / 1024).toLocaleString('pt-BR', { maximumFractionDigits: 1 });

  // ---------- foto ----------
  async function carregarImagem(arquivo) {
    if (window.createImageBitmap) {
      try { return await createImageBitmap(arquivo, { imageOrientation: 'from-image' }); } catch (_) { /* tenta pelo <img> */ }
    }
    const url = URL.createObjectURL(arquivo);
    try {
      const img = new Image();
      img.decoding = 'async';
      img.src = url;
      await img.decode();
      return img;
    } finally {
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
  }

  function desenhar(fonte, larguraOrig, alturaOrig, maxLado, qualidade) {
    const escala = Math.min(1, maxLado / Math.max(larguraOrig, alturaOrig));
    const w = Math.max(1, Math.round(larguraOrig * escala));
    const h = Math.max(1, Math.round(alturaOrig * escala));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff'; // PNG com transparência vira fundo branco no JPEG
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(fonte, 0, 0, w, h);
    return new Promise((res, rej) => canvas.toBlob((b) => (b ? res({ blob: b, largura: w, altura: h }) : rej(new Error('não consegui comprimir a foto'))), 'image/jpeg', qualidade));
  }

  async function prepararFoto(arquivo) {
    try {
      const img = await carregarImagem(arquivo);
      const w = img.width || img.naturalWidth;
      const h = img.height || img.naturalHeight;
      const principal = await desenhar(img, w, h, MAX_LADO, QUALIDADE);
      const mini = await desenhar(img, w, h, MINI_LADO, 0.7);
      if (img.close) img.close();
      return { tipo: 'foto', blob: principal.blob, mime: 'image/jpeg', largura: principal.largura, altura: principal.altura, miniatura: mini.blob, original: arquivo.size };
    } catch (e) {
      // Navegador que não abre o formato (ex.: HEIC no PC): manda o original, sem miniatura.
      return { tipo: 'foto', blob: arquivo, mime: mimeBase(arquivo.type) || 'image/jpeg', miniatura: null, original: arquivo.size, aviso: 'Foto enviada sem compressão (formato não suportado neste navegador)' };
    }
  }

  // ---------- vídeo ----------
  function lerVideo(arquivo) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(arquivo);
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.muted = true;
      v.playsInline = true;
      let feito = false;
      const fim = (fn) => (x) => { if (feito) return; feito = true; clearTimeout(t); fn(x); };
      const t = setTimeout(fim(() => { URL.revokeObjectURL(url); reject(new Error('não consegui ler o vídeo')); }), 15000);
      v.onerror = fim(() => { URL.revokeObjectURL(url); reject(new Error('formato de vídeo não suportado neste navegador')); });
      v.onloadedmetadata = async () => {
        let dur = v.duration;
        // Alguns WebM gravados no navegador chegam com duração "Infinity" até serem percorridos.
        if (!Number.isFinite(dur)) {
          await new Promise((r) => { v.ontimeupdate = () => { v.ontimeupdate = null; r(); }; v.currentTime = 1e9; });
          dur = v.duration;
        }
        let miniatura = null;
        try {
          await new Promise((r, j) => { v.onseeked = r; v.onerror = j; v.currentTime = Math.min(0.5, (dur || 1) / 2); });
          const quadro = await desenhar(v, v.videoWidth, v.videoHeight, MINI_LADO, 0.7);
          miniatura = quadro.blob;
        } catch (_) { /* sem miniatura: a tela mostra só o player */ }
        fim(() => {
          URL.revokeObjectURL(url);
          resolve({ duracao: dur, largura: v.videoWidth || null, altura: v.videoHeight || null, miniatura });
        })();
      };
      v.src = url;
    });
  }

  async function prepararVideo(arquivo) {
    const info = await lerVideo(arquivo);
    if (!(info.duracao > 0)) throw new Error('Não consegui ler a duração do vídeo');
    if (info.duracao > VIDEO_MAX_S + 1) {
      const min = Math.floor(info.duracao / 60);
      const s = Math.round(info.duracao % 60);
      throw new Error(`Vídeo com ${min} min ${s} s: o limite é 2 minutos por registro. Grave um trecho menor.`);
    }
    const aviso = arquivo.size > VIDEO_AVISO_MB * 1024 * 1024
      ? `Vídeo de ${mb(arquivo.size)} MB: no 4G pode demorar alguns minutos para enviar.` : null;
    return { tipo: 'video', blob: arquivo, mime: mimeBase(arquivo.type) || 'video/mp4', duracao: info.duracao, largura: info.largura, altura: info.altura, miniatura: info.miniatura, aviso };
  }

  // ---------- áudio ----------
  function lerDuracaoAudio(blob) {
    return new Promise((resolve) => {
      const url = URL.createObjectURL(blob);
      const a = document.createElement('audio');
      a.preload = 'metadata';
      const fim = (d) => { URL.revokeObjectURL(url); resolve(Number.isFinite(d) ? d : null); };
      a.onloadedmetadata = () => fim(a.duration);
      a.onerror = () => fim(null);
      setTimeout(() => fim(null), 5000);
      a.src = url;
    });
  }

  async function prepararAudio(arquivo, duracaoConhecida = null) {
    const duracao = duracaoConhecida || (await lerDuracaoAudio(arquivo));
    return { tipo: 'audio', blob: arquivo, mime: mimeBase(arquivo.type) || 'audio/webm', duracao, miniatura: null };
  }

  const podeGravarAudio = () => Boolean(window.isSecureContext && navigator.mediaDevices && navigator.mediaDevices.getUserMedia && window.MediaRecorder);

  async function iniciarGravacao() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const tipos = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg'];
    const mimeType = tipos.find((t) => MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(t));
    const rec = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    const pedacos = [];
    const inicio = Date.now();
    rec.ondataavailable = (e) => { if (e.data && e.data.size) pedacos.push(e.data); };
    rec.start(1000);
    return {
      inicio,
      parar: () => new Promise((resolve) => {
        rec.onstop = () => {
          stream.getTracks().forEach((t) => t.stop());
          const tipo = mimeBase(rec.mimeType || mimeType || 'audio/webm');
          resolve({ blob: new Blob(pedacos, { type: tipo }), duracao: (Date.now() - inicio) / 1000 });
        };
        rec.stop();
      }),
      cancelar: () => { try { rec.stop(); } catch (_) { /* já parado */ } stream.getTracks().forEach((t) => t.stop()); },
    };
  }

  // ---------- fila de envio (IndexedDB) ----------
  const BANCO = 'kanban-envios';
  let dbPromessa = null;
  const memoria = new Map(); // se o IndexedDB não existir (aba anônima antiga), a fila vive só na página

  function abrirBanco() {
    if (!dbPromessa) {
      dbPromessa = new Promise((resolve) => {
        try {
          const req = indexedDB.open(BANCO, 1);
          req.onupgradeneeded = () => req.result.createObjectStore('fila', { keyPath: 'cliente_id' });
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => resolve(null);
        } catch (_) { resolve(null); }
      });
    }
    return dbPromessa;
  }
  async function tx(modo, fn) {
    const db = await abrirBanco();
    if (!db) return fn(null);
    return new Promise((resolve, reject) => {
      const t = db.transaction('fila', modo);
      const store = t.objectStore('fila');
      let out;
      Promise.resolve(fn(store)).then((v) => { out = v; });
      t.oncomplete = () => resolve(out);
      t.onerror = () => reject(t.error);
    });
  }
  const pedido = (req) => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

  async function salvarItem(item) {
    memoria.set(item.cliente_id, item);
    try { await tx('readwrite', (s) => s && s.put(item)); } catch (_) { /* fica só em memória */ }
  }
  async function apagarItem(id) {
    memoria.delete(id);
    try { await tx('readwrite', (s) => s && s.delete(id)); } catch (_) { /* ok */ }
  }
  async function listarItens() {
    try {
      const doBanco = await tx('readonly', (s) => (s ? pedido(s.getAll()) : []));
      for (const i of doBanco || []) if (!memoria.has(i.cliente_id)) memoria.set(i.cliente_id, i);
    } catch (_) { /* usa a memória */ }
    return [...memoria.values()].sort((a, b) => a.criado_em.localeCompare(b.criado_em));
  }

  const ouvintes = new Set();
  const concluintes = new Set(); // chamados quando um envio termina (a tela recarrega o card)
  const progresso = new Map(); // cliente_id → 0..1 (só em memória)
  const avisar = () => listarItens().then((itens) => ouvintes.forEach((fn) => fn(itens, progresso)));

  async function enfileirar({ cardId, preparado, legenda, operador }) {
    const item = {
      cliente_id: uuid(),
      card_id: Number(cardId),
      tipo: preparado.tipo,
      mime: preparado.mime,
      blob: preparado.blob,
      miniatura: preparado.miniatura || null,
      meta: { tamanho: preparado.blob.size, duracao: preparado.duracao || null, largura: preparado.largura || null, altura: preparado.altura || null },
      legenda: legenda || '',
      operador,
      criado_em: new Date().toISOString(),
      tentativas: 0,
      estado: 'aguardando',
      erro: null,
      proxima_em: 0,
    };
    await salvarItem(item);
    avisar();
    processar();
    return item;
  }

  function putXhr(url, blob, mime, aoProgresso) {
    return new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open('PUT', url);
      x.setRequestHeader('Content-Type', mime);
      x.upload.onprogress = (e) => { if (e.lengthComputable) aoProgresso(e.loaded / e.total); };
      x.onload = () => (x.status >= 200 && x.status < 300 ? resolve() : reject(Object.assign(new Error(`armazenamento respondeu ${x.status}`), { status: x.status, rede: x.status === 0 })));
      x.onerror = () => reject(Object.assign(new Error('sem conexão com o armazenamento'), { rede: true }));
      x.ontimeout = () => reject(Object.assign(new Error('tempo esgotado no envio'), { rede: true }));
      x.send(new Blob([blob], { type: mime }));
    });
  }

  async function postJson(url, corpo) {
    let r;
    try {
      r = await fetch(url, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo) });
    } catch (_) {
      throw Object.assign(new Error('sem conexão com o servidor'), { rede: true });
    }
    const json = await r.json().catch(() => ({}));
    if (r.status === 401) throw Object.assign(new Error('sessão expirada: entre de novo'), { status: 401 });
    if (!r.ok) throw Object.assign(new Error(json.erro || `erro ${r.status}`), { status: r.status });
    return json;
  }

  // Erros que valem nova tentativa: rede, servidor fora (5xx), arquivo ainda não chegou (409), sessão.
  const temporario = (e) => e.rede || !e.status || e.status >= 500 || e.status === 409 || e.status === 408 || e.status === 429 || e.status === 401 || e.status === 403;

  let rodando = false;
  let timer = null;

  async function enviarItem(item) {
    const p = await postJson(`/api/kanban/cards/${item.card_id}/midias`, {
      cliente_id: item.cliente_id, tipo: item.tipo, mime: item.mime, tamanho: item.meta.tamanho, duracao: item.meta.duracao,
      largura: item.meta.largura, altura: item.meta.altura, miniatura: Boolean(item.miniatura), operador: item.operador,
    });
    if (!p.ja_enviado) {
      const total = item.meta.tamanho + (item.miniatura ? item.miniatura.size : 0);
      await putXhr(p.upload_url, item.blob, p.mime || item.mime, (f) => { progresso.set(item.cliente_id, (f * item.meta.tamanho) / total); avisar(); });
      if (item.miniatura && p.miniatura_url) {
        try { await putXhr(p.miniatura_url, item.miniatura, 'image/jpeg', () => {}); } catch (_) { /* sem miniatura, segue */ }
      }
      progresso.set(item.cliente_id, 1);
      await postJson(`/api/kanban/midias/${p.midia_id}/confirmar`, { legenda: item.legenda, operador: item.operador });
    }
  }

  async function processar() {
    if (rodando) return;
    rodando = true;
    clearTimeout(timer);
    try {
      for (;;) {
        if (!navigator.onLine) break;
        const itens = await listarItens();
        const agora = Date.now();
        const proximo = itens.find((i) => i.estado !== 'falhou' && i.proxima_em <= agora);
        if (!proximo) {
          const espera = itens.filter((i) => i.estado !== 'falhou').map((i) => i.proxima_em - agora);
          if (espera.length) timer = setTimeout(processar, Math.max(1000, Math.min(...espera)));
          break;
        }
        proximo.estado = 'enviando';
        proximo.erro = null;
        await salvarItem(proximo);
        avisar();
        try {
          await enviarItem(proximo);
          await apagarItem(proximo.cliente_id);
          progresso.delete(proximo.cliente_id);
          concluintes.forEach((fn) => fn(proximo));
        } catch (e) {
          proximo.tentativas += 1;
          proximo.erro = e.message;
          progresso.delete(proximo.cliente_id);
          if (temporario(e) && proximo.tentativas <= ESPERAS_S.length) {
            proximo.estado = 'aguardando';
            proximo.proxima_em = Date.now() + ESPERAS_S[proximo.tentativas - 1] * 1000;
          } else {
            proximo.estado = 'falhou'; // espera o operador tocar em "Tentar de novo" ou "Descartar"
          }
          await salvarItem(proximo);
        }
        avisar();
      }
    } finally {
      rodando = false;
    }
  }

  async function tentarDeNovo(id) {
    const item = (await listarItens()).find((i) => i.cliente_id === id);
    if (!item) return;
    Object.assign(item, { estado: 'aguardando', proxima_em: 0, tentativas: 0, erro: null });
    await salvarItem(item);
    avisar();
    processar();
  }
  async function descartar(id) {
    await apagarItem(id);
    progresso.delete(id);
    avisar();
  }

  window.addEventListener('online', () => processar());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) processar(); });

  window.KanbanMidia = {
    prepararFoto, prepararVideo, prepararAudio, podeGravarAudio, iniciarGravacao,
    enfileirar, processar, listarItens, tentarDeNovo, descartar,
    aoMudar: (fn) => { ouvintes.add(fn); avisar(); return () => ouvintes.delete(fn); },
    aoConcluir: (fn) => { concluintes.add(fn); return () => concluintes.delete(fn); },
    mb, tamanhoTexto, VIDEO_MAX_S,
  };
  processar();
})();
