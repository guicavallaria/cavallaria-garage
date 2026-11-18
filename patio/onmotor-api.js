// Cliente do Onmotor NOVO (desde 18/11/2026: https://cavallaria.onmotor.com, sem ".br").
//
// O sistema foi refeito em Next.js e tudo vem de uma API JSON em /api/v1. O navegador faz:
//   POST /api/v1/login {username, password, otp_code?} → authorization.token + device_code (12 h)
// e depois manda os dois como cookies ("token" e "device_code") em cada chamada. Aqui é igual:
// os dois ficam salvos em DATA_DIR/onmotor-api-session[-empresa].json; o device_code também vai no
// login seguinte, para o Onmotor reconhecer o "aparelho" e não pedir código de verificação de novo.
//
// Sessão vencida ou recusada (401/403) → loga de novo uma vez e repete a chamada.
// Nunca loga credenciais, token nem device_code.
//
// A AWDYNA continua no sistema antigo (patio/onmotor.js, HTML) até o Onmotor dela migrar.
const fs = require('fs');
const path = require('path');
const { linhaDoPatio, validarServicos, noPatio } = require('./patio-api');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..');
const UID = /^[0-9a-f]{20,80}$/i;
const SESSAO_HORAS = 11; // o Onmotor dá 12 h; renova um pouco antes
const TIMEOUT_MS = 60_000; // por chamada (o Onmotor novo chegou a levar 20 s para a Pátio em 18/11)
const ORCAMENTO_DETALHES_MS = 120_000; // tempo máximo por rodada lendo OS fora do cache

// Detalhes completos por OS (datas com ano), por processo. A Pátio traz as datas sem o ano
// ("18/11 08:59"); a OS inteira traz "2026-11-18 08:59". Só busca de novo quando updated_at muda.
const cacheDetalhes = new Map();

class OnmotorApiClient {
  constructor({ nome = 'cavallaria', baseUrl, user, pass, deviceCode, fetchImpl = globalThis.fetch, arquivoSessao, log = () => {}, agoraFn = () => new Date(), timeoutMs = TIMEOUT_MS, orcamentoDetalhesMs = ORCAMENTO_DETALHES_MS } = {}) {
    this.tipo = 'api';
    this.nome = nome;
    this.base = (baseUrl || 'https://cavallaria.onmotor.com').replace(/\/$/, '');
    this.user = user ?? process.env.ONMOTOR_USER;
    this.pass = pass ?? process.env.ONMOTOR_PASS;
    this.fetch = fetchImpl;
    this.log = log;
    this.agoraFn = agoraFn;
    this.timeoutMs = timeoutMs;
    this.orcamentoDetalhesMs = orcamentoDetalhesMs;
    this.arquivoSessao = arquivoSessao === undefined
      ? path.join(DATA_DIR, nome === 'cavallaria' ? 'onmotor-api-session.json' : `onmotor-api-session-${nome}.json`)
      : arquivoSessao;
    this.sessao = { token: null, device_code: deviceCode ?? process.env.ONMOTOR_DEVICE_CODE ?? null, expira_em: null };
    this.carregarSessao();
  }

  configurado() { return Boolean(this.user && this.pass); }

  // ---------- sessão ----------
  carregarSessao() {
    if (!this.arquivoSessao) return;
    try {
      const s = JSON.parse(fs.readFileSync(this.arquivoSessao, 'utf8'));
      if (s.base && s.base !== this.base) return; // sessão de outro endereço
      this.sessao = { token: s.token || null, device_code: s.device_code || this.sessao.device_code, expira_em: s.expira_em || null };
    } catch (_) { /* sem sessão salva */ }
  }

  salvarSessao() {
    if (!this.arquivoSessao) return;
    try {
      fs.writeFileSync(this.arquivoSessao, JSON.stringify({ ...this.sessao, base: this.base, salvo_em: this.agoraFn().toISOString() }));
    } catch (e) { this.log('onmotor api: não consegui salvar a sessão: ' + e.message); }
  }

  sessaoValida() {
    return Boolean(this.sessao.token && this.sessao.expira_em && Date.parse(this.sessao.expira_em) > this.agoraFn().getTime());
  }

  cookieHeader() {
    const c = [];
    if (this.sessao.token) c.push(`token=${this.sessao.token}`);
    if (this.sessao.device_code) c.push(`device_code=${this.sessao.device_code}`);
    return c.join('; ');
  }

  // ---------- HTTP ----------
  async chamar(metodo, caminho, corpo) {
    const res = await this.fetch(this.base + '/api' + caminho, {
      method: metodo,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; painel-patio/2.0)',
        Accept: 'application/json',
        ...(corpo !== undefined ? { 'Content-Type': 'application/json' } : {}),
        Cookie: this.cookieHeader(),
      },
      body: corpo !== undefined ? JSON.stringify(corpo) : undefined,
      signal: AbortSignal.timeout(this.timeoutMs),
    }).catch((e) => {
      if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) throw new Error(`Onmotor não respondeu em ${Math.round(this.timeoutMs / 1000)} s (${caminho})`);
      throw e;
    });
    const texto = await res.text();
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch (_) { /* não é JSON */ }
    return { status: res.status, json, texto };
  }

  async login() {
    if (!this.configurado()) throw new Error('ONMOTOR_USER/ONMOTOR_PASS não configurados');
    const r = await this.chamar('POST', '/v1/login', { username: this.user, password: this.pass });
    const auth = r.json && r.json.authorization;
    if (r.status >= 200 && r.status < 300 && auth && auth.token) {
      const expira = new Date(this.agoraFn().getTime() + SESSAO_HORAS * 3600_000).toISOString();
      this.sessao = { token: auth.token, device_code: auth.device_code || this.sessao.device_code, expira_em: expira };
      this.salvarSessao();
      this.log(`onmotor api (${this.nome}): login ok`);
      return;
    }
    if (r.json && r.json.otp) {
      throw new Error('o Onmotor pediu código de verificação (OTP) para o login automático — libere o login sem código para o usuário do sistema ou informe ONMOTOR_DEVICE_CODE');
    }
    const msg = r.json && typeof r.json.message === 'string' ? r.json.message : `HTTP ${r.status}`;
    throw new Error(`login no Onmotor recusado (${msg})`);
  }

  // Chamada autenticada: sem sessão válida, loga antes; 401/403 → loga de novo e repete uma vez.
  async api(metodo, caminho, corpo) {
    if (!this.sessaoValida()) await this.login();
    let r = await this.chamar(metodo, caminho, corpo);
    if (r.status === 401 || r.status === 403) {
      await this.login();
      r = await this.chamar(metodo, caminho, corpo);
    }
    if (r.status < 200 || r.status >= 300) {
      const msg = r.json && typeof r.json.message === 'string' ? r.json.message : '';
      throw new Error(`Onmotor respondeu ${r.status} para ${caminho}${msg ? ` (${msg})` : ''}`);
    }
    if (!r.json || typeof r.json !== 'object') throw new Error(`Onmotor devolveu algo que não é JSON para ${caminho}`);
    return r.json;
  }

  // ---------- dados ----------
  // Serviços → Pátio (antiga Novidades): as OS abertas e as finalizadas recentes.
  async servicosPatio() {
    const j = await this.api('POST', '/v1/service/core/services-news', {});
    return j.data && j.data.services;
  }

  // OS inteira (datas com ano, veículo, cliente, totais).
  async os(uid) {
    if (!UID.test(String(uid || ''))) {
      throw new Error(/^\d+$/.test(String(uid || ''))
        ? 'id da OS é do Onmotor antigo — ela precisa aparecer no Pátio para ganhar o id novo'
        : 'id da OS inválido');
    }
    const j = await this.api('GET', `/v1/service/core/${uid}`);
    if (!j.data || typeof j.data !== 'object') throw new Error('OS veio sem dados');
    return j.data;
  }

  // Datas completas da OS, do cache enquanto o updated_at da Pátio não mudar.
  async detalhesComCache(servico, prazo = Infinity) {
    const chave = `${this.base}|${servico.uid}`;
    const c = cacheDetalhes.get(chave);
    if (c && c.updated_at === servico.updated_at) return c.os;
    if (Date.now() > prazo) throw new Error('fica para a próxima rodada (Onmotor lento)');
    const os = await this.os(servico.uid);
    cacheDetalhes.set(chave, { updated_at: servico.updated_at, os });
    return os;
  }

  // Mesmo formato do parseNovidades (patio/parser.js): { ok, problemas, linhas, emExecucao, totalLido }.
  async lerNovidades() {
    const servicos = await this.servicosPatio();
    const problemas = validarServicos(servicos);
    if (problemas.length) return { ok: false, problemas, linhas: [], emExecucao: [], totalLido: 0 };
    const linhas = [];
    const avisos = [];
    const prazo = Date.now() + this.orcamentoDetalhesMs;
    for (const s of servicos) {
      if (s.deleted_at || s.cancellation_date) continue; // cancelada/excluída = fora da Pátio
      let os = null;
      try { os = await this.detalhesComCache(s, prazo); } catch (e) { avisos.push(`OS ${s.code}: sem as datas completas (${e.message})`); }
      linhas.push(linhaDoPatio(s, os));
    }
    return { ok: true, problemas: [], avisos, linhas, emExecucao: linhas.filter(noPatio), totalLido: linhas.length };
  }

  // Situação da OS para quem saiu da Pátio: finalizada? (mesmo formato do extrairDadosOS antigo)
  async situacaoOS(uid) {
    const os = await this.os(uid);
    return {
      etapas: { entrada: Boolean(os.entry_date), finalizado: Boolean(os.end_date), retirado: Boolean(os.pickup_date) },
      finalizadaEm: os.end_date || null,
      cancelada: Boolean(os.cancellation_date),
    };
  }

  // Cadastro do veículo da OS (mesmo formato do parseModalVeiculo antigo).
  async veiculoDaOS(uid) {
    const os = await this.os(uid);
    const v = os.vehicle || {};
    const t = (x) => (x === null || x === undefined ? '' : String(typeof x === 'object' && 'value' in x ? x.value ?? '' : x).trim());
    return {
      placa: t(v.plate), fabricante: t(v.manufacturer), modelo: t(v.model), chassiInformado: t(v.chassis),
      anoFabricacao: t(v.manufacture_year), anoModelo: t(v.model_year), motor: t(v.engine), combustivel: t(v.fuel),
      cambio: t(v.transmission), direcao: t(v.steering), ar: t(v.air_conditioning), cor: t(v.color), portas: t(v.doors),
      km: t(os.odometer) || t(v.odometer),
    };
  }
}

const limparCacheDetalhes = () => cacheDetalhes.clear();

module.exports = { OnmotorApiClient, limparCacheDetalhes, UID };
