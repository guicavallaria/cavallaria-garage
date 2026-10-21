// Uma sincronização completa: Onmotor → parser → reconciliação → detalhes
// (ano/cor da página da OS, só para veículos novos) → concordância com a
// agenda → log. Qualquer falha de leitura é registrada e o pátio fica como
// estava — nunca "zera" por erro.
const { OnmotorClient } = require('./onmotor');
const { parseNovidades, texto } = require('./parser');
const { aplicarSync } = require('./reconciliar');
const { reconciliarAgendaHoje } = require('./agenda');
const { parseVeiculoOnmotor } = require('./veiculo');
const { agoraSP } = require('./tz');

const MAX_DETALHES_POR_SYNC = 15; // cada detalhe é um GET de ~350 KB na página da OS

// Texto do veículo no <select id="ipt_id_veiculo"> da página da OS.
function extrairVeiculoDaOS(html) {
  const sel = (String(html || '').match(/<select[^>]*id="ipt_id_veiculo"[\s\S]*?<\/select>/) || [])[0] || '';
  const opt = (sel.match(/<option[^>]*\bselected\b[^>]*>([\s\S]*?)<\/option>/) || sel.match(/<option[^>]*>([\s\S]*?)<\/option>/) || [])[1] || '';
  return parseVeiculoOnmotor(texto(opt));
}

// Completa ano/cor dos veículos ativos ainda sem detalhes (um GET por veículo, limitado por rodada).
async function enriquecerDetalhes(db, client, { limite = MAX_DETALHES_POR_SYNC } = {}) {
  const pendentes = db.prepare(`
    SELECT v.id, MAX(o.os_id_interno) AS os_id_interno
    FROM patio_vehicles v JOIN patio_vehicle_orders o ON o.vehicle_id = v.id AND o.os_id_interno IS NOT NULL
    WHERE v.status = 'ativo' AND v.detalhes_ok = 0
    GROUP BY v.id ORDER BY v.id LIMIT ?`).all(limite);
  const upd = db.prepare(`UPDATE patio_vehicles
    SET ano = COALESCE(NULLIF(?, ''), ano), cor = COALESCE(NULLIF(?, ''), cor), modelo = COALESCE(modelo, NULLIF(?, '')), detalhes_ok = 1
    WHERE id = ?`);
  const resultado = { ok: 0, erros: [] };
  for (const p of pendentes) {
    try {
      const v = extrairVeiculoDaOS(await client.osHtml(p.os_id_interno));
      upd.run(v.ano, v.cor, v.marcaModelo, p.id);
      resultado.ok++;
    } catch (e) {
      resultado.erros.push(`detalhes da OS ${p.os_id_interno}: ${e.message}`);
    }
  }
  return resultado;
}

async function sincronizar(db, { client, origem = 'auto', agoraFn = agoraSP, broadcast = () => {}, log = console.log } = {}) {
  const logId = db.prepare('INSERT INTO patio_sync_log (origem, iniciado_em) VALUES (?, ?)').run(origem, agoraFn()).lastInsertRowid;
  const fechar = db.prepare(`UPDATE patio_sync_log SET terminado_em = ?, sucesso = ?, os_lidas = ?, veiculos_novos = ?,
    veiculos_finalizados = ?, veiculos_mantidos = ?, avisos = ?, erro = ? WHERE id = ?`);
  try {
    client = client || new OnmotorClient({ log });
    const lido = parseNovidades(await client.novidadesHtml());
    if (!lido.ok) throw new Error('página da Novidades inválida: ' + lido.problemas.join('; '));

    const r = aplicarSync(db, lido.emExecucao, { agora: agoraFn() });
    const det = await enriquecerDetalhes(db, client);
    const ag = reconciliarAgendaHoje(db);
    const avisos = [...r.avisos, ...ag.avisos, ...det.erros];

    fechar.run(agoraFn(), 1, r.os_lidas, r.novos, r.finalizados, r.mantidos, avisos.join('\n') || null, null, logId);
    log(`patio sync (${origem}): ${r.os_lidas} OS, ${r.novos} novos, ${r.mantidos} mantidos, ${r.finalizados} finalizados${avisos.length ? `, ${avisos.length} aviso(s)` : ''}`);
    broadcast('patio');
    return { ok: true, os_lidas: r.os_lidas, novos: r.novos, mantidos: r.mantidos, finalizados: r.finalizados, avisos, detalhes: det.ok };
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
  return {
    ultima_ok_em: ultimaOk ? ultimaOk.terminado_em : null,
    minutos_desde_ok: minutos,
    desatualizado: minutos === null || minutos > 60,
    ultima_tentativa_em: ultima ? ultima.terminado_em || ultima.iniciado_em : null,
    ultima_falhou: ultima ? !ultima.sucesso : false,
    ultimo_erro: ultima && !ultima.sucesso ? ultima.erro : null,
    em_andamento: Boolean(ultima && !ultima.terminado_em),
  };
}

module.exports = { sincronizar, enriquecerDetalhes, extrairVeiculoDaOS, estadoSync, minutosEntre };
