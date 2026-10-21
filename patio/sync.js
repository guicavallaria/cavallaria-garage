// Uma sincronização completa: cada fonte Onmotor (Cavallaria e AWDYNA, mesmo
// login) → parser → lista única → reconciliação → detalhes (ano/cor da página
// da OS, só para veículos novos, na empresa certa) → concordância com a agenda
// → log. Fonte que falha é registrada como aviso e seus veículos ficam intactos;
// só quando TODAS falham a rodada conta como erro. Nunca "zera" o pátio.
const { OnmotorClient } = require('./onmotor');
const { parseNovidades, texto } = require('./parser');
const { aplicarSync } = require('./reconciliar');
const { reconciliarAgendaHoje } = require('./agenda');
const { parseVeiculoOnmotor } = require('./veiculo');
const { agoraSP } = require('./tz');

const MAX_DETALHES_POR_SYNC = 15; // cada detalhe é um GET de ~350 KB na página da OS

// Fontes lidas. As duas usam as mesmas credenciais (ONMOTOR_USER/PASS).
function fontes(env = process.env) {
  const lista = [{ nome: 'cavallaria', baseUrl: env.ONMOTOR_BASE_URL || 'https://cavallaria.onmotor.com.br' }];
  if (env.PATIO_AWDYNA_ENABLED !== 'false') {
    lista.push({ nome: 'awdyna', baseUrl: env.ONMOTOR_AWDYNA_BASE_URL || 'https://awdyna.onmotor.com.br' });
  }
  return lista;
}

function clientesPadrao(log) {
  const map = new Map();
  for (const f of fontes()) map.set(f.nome, new OnmotorClient({ nome: f.nome, baseUrl: f.baseUrl, log }));
  return map;
}

// Texto do veículo no <select id="ipt_id_veiculo"> da página da OS.
function extrairVeiculoDaOS(html) {
  const sel = (String(html || '').match(/<select[^>]*id="ipt_id_veiculo"[\s\S]*?<\/select>/) || [])[0] || '';
  const opt = (sel.match(/<option[^>]*\bselected\b[^>]*>([\s\S]*?)<\/option>/) || sel.match(/<option[^>]*>([\s\S]*?)<\/option>/) || [])[1] || '';
  return parseVeiculoOnmotor(texto(opt));
}

// Completa ano/cor dos veículos ativos ainda sem detalhes, lendo a OS na empresa de origem.
async function enriquecerDetalhes(db, clientes, { limite = MAX_DETALHES_POR_SYNC } = {}) {
  const pendentes = db.prepare(`
    SELECT v.id, o.os_id_interno, o.empresa
    FROM patio_vehicles v JOIN patio_vehicle_orders o ON o.vehicle_id = v.id AND o.os_id_interno IS NOT NULL
    WHERE v.status = 'ativo' AND v.detalhes_ok = 0
    GROUP BY v.id ORDER BY v.id LIMIT ?`).all(limite);
  const upd = db.prepare(`UPDATE patio_vehicles
    SET ano = COALESCE(NULLIF(?, ''), ano), cor = COALESCE(NULLIF(?, ''), cor), modelo = COALESCE(modelo, NULLIF(?, '')), detalhes_ok = 1
    WHERE id = ?`);
  const resultado = { ok: 0, erros: [] };
  for (const p of pendentes) {
    const client = clientes.get(p.empresa || 'cavallaria');
    if (!client) { resultado.erros.push(`detalhes da OS ${p.os_id_interno}: fonte ${p.empresa} indisponível`); continue; }
    try {
      const v = extrairVeiculoDaOS(await client.osHtml(p.os_id_interno));
      upd.run(v.ano, v.cor, v.marcaModelo, p.id);
      resultado.ok++;
    } catch (e) {
      resultado.erros.push(`detalhes da OS ${p.os_id_interno} (${p.empresa}): ${e.message}`);
    }
  }
  return resultado;
}

// Lê a Novidades de cada fonte; devolve a lista unificada e quais fontes deram certo.
async function lerFontes(clientes) {
  const lista = [];
  const lidas = [];
  const falhas = [];
  for (const [nome, client] of clientes) {
    try {
      const lido = parseNovidades(await client.novidadesHtml());
      if (!lido.ok) throw new Error('página da Novidades inválida: ' + lido.problemas.join('; '));
      for (const os of lido.emExecucao) lista.push({ ...os, empresa: nome });
      lidas.push({ nome, os: lido.emExecucao.length });
    } catch (e) {
      falhas.push({ nome, erro: e.message });
    }
  }
  return { lista, lidas, falhas };
}

async function sincronizar(db, { client, clientes, origem = 'auto', agoraFn = agoraSP, broadcast = () => {}, log = console.log } = {}) {
  const logId = db.prepare('INSERT INTO patio_sync_log (origem, iniciado_em) VALUES (?, ?)').run(origem, agoraFn()).lastInsertRowid;
  const fechar = db.prepare(`UPDATE patio_sync_log SET terminado_em = ?, sucesso = ?, os_lidas = ?, veiculos_novos = ?,
    veiculos_finalizados = ?, veiculos_mantidos = ?, avisos = ?, erro = ? WHERE id = ?`);
  try {
    // compatibilidade: `client` único = só Cavallaria
    if (!clientes) clientes = client ? new Map([['cavallaria', client]]) : clientesPadrao(log);

    const { lista, lidas, falhas } = await lerFontes(clientes);
    if (!lidas.length) throw new Error(falhas.map((f) => `${f.nome}: ${f.erro}`).join(' | '));

    const r = aplicarSync(db, lista, { agora: agoraFn(), empresasLidas: lidas.map((l) => l.nome) });
    const det = await enriquecerDetalhes(db, clientes);
    const ag = reconciliarAgendaHoje(db);
    const avisos = [
      ...lidas.map((l) => `${l.nome}: ${l.os} OS em execução`),
      ...falhas.map((f) => `${f.nome}: FALHOU — ${f.erro}`),
      ...r.avisos, ...ag.avisos, ...det.erros,
    ];

    fechar.run(agoraFn(), 1, r.os_lidas, r.novos, r.finalizados, r.mantidos, avisos.join('\n') || null, null, logId);
    log(`patio sync (${origem}): ${r.os_lidas} OS [${lidas.map((l) => `${l.nome}=${l.os}`).join(', ')}], ${r.novos} novos, ${r.mantidos} mantidos, ${r.finalizados} finalizados${falhas.length ? `, FALHOU: ${falhas.map((f) => f.nome).join(',')}` : ''}`);
    broadcast('patio');
    return { ok: true, os_lidas: r.os_lidas, novos: r.novos, mantidos: r.mantidos, finalizados: r.finalizados, avisos, fontes_lidas: lidas, fontes_falhas: falhas, detalhes: det.ok };
  } catch (e) {
    fechar.run(agoraFn(), 0, 0, 0, 0, 0, null, e.message, logId);
    log(`patio sync (${origem}) FALHOU: ${e.message}`);
    broadcast('patio');
    return { ok: false, erro: e.message };
  }
}

// Diferença em minutos entre dois timestamps "YYYY-MM-DD HH:MM:SS" (mesmo fuso).
function minutosEntre(a, b) {
  const t = (s) => Date.parse(String(s).replace(' ', 'T') + 'Z');
  return Math.round((t(b) - t(a)) / 60000);
}

// Resumo para o cabeçalho do painel.
function estadoSync(db, { agoraFn = agoraSP } = {}) {
  const ultimaOk = db.prepare('SELECT * FROM patio_sync_log WHERE sucesso = 1 ORDER BY id DESC LIMIT 1').get();
  const ultima = db.prepare('SELECT * FROM patio_sync_log ORDER BY id DESC LIMIT 1').get();
  const minutos = ultimaOk ? minutosEntre(ultimaOk.terminado_em, agoraFn()) : null;
  const fontesComFalha = ultima && ultima.sucesso && ultima.avisos
    ? ultima.avisos.split('\n').filter((l) => /: FALHOU/.test(l)).map((l) => l.split(':')[0])
    : [];
  return {
    ultima_ok_em: ultimaOk ? ultimaOk.terminado_em : null,
    minutos_desde_ok: minutos,
    desatualizado: minutos === null || minutos > 60,
    ultima_tentativa_em: ultima ? ultima.terminado_em || ultima.iniciado_em : null,
    ultima_falhou: ultima ? !ultima.sucesso : false,
    ultimo_erro: ultima && !ultima.sucesso ? ultima.erro : null,
    fontes_com_falha: fontesComFalha,
    em_andamento: Boolean(ultima && !ultima.terminado_em),
  };
}

module.exports = { sincronizar, enriquecerDetalhes, extrairVeiculoDaOS, estadoSync, minutosEntre, fontes, lerFontes };
