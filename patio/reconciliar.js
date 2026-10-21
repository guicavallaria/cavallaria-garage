// Reconciliação do pátio com a lista de OS em execução lida do Onmotor
// (Cavallaria + AWDYNA, mesma lista; cada OS carrega `empresa`).
//
// Unidade do painel = VEÍCULO (placa normalizada), nunca a OS:
//   - várias OS da mesma placa (de qualquer empresa) → um veículo, várias linhas em patio_vehicle_orders;
//   - o veículo só sai quando TODAS as suas OS saírem da lista;
//   - veículo que sai vira status='finalizado' com finished_at (histórico, nunca DELETE);
//   - veículo já conhecido mantém mecanico_id/origem e só atualiza dados descritivos.
// `empresasLidas` = fontes lidas com sucesso nesta rodada. OS de uma empresa que
// NÃO foi lida ficam intocadas, e um veículo só é finalizado se todas as suas OS
// ativas forem de empresas lidas — site fora do ar nunca "zera" o pátio.
// A unicidade de placa ativa é garantida também pelo índice único parcial do banco.
const { agoraSP } = require('./tz');
const { formatarPlaca, normalizarPlaca } = require('./placa');

// OS sem placa válida não pode ficar invisível no pátio: usa chave sintética.
// Normaliza de novo por segurança: a chave do painel nunca pode depender de como a fonte escreveu a placa.
function chaveVeiculo(os) {
  return normalizarPlaca(os.placa) || `OS${os.osNumber}`;
}

// Agrupa as OS lidas por veículo. Dados descritivos vêm da OS mais recente (maior número).
function agruparPorVeiculo(lista) {
  const grupos = new Map();
  const ordenada = [...lista].sort((a, b) => Number(b.osNumber) - Number(a.osNumber));
  for (const os of ordenada) {
    const chave = chaveVeiculo(os);
    if (!grupos.has(chave)) {
      const placa = normalizarPlaca(os.placa);
      grupos.set(chave, {
        chave,
        placa,
        placaExibicao: placa ? formatarPlaca(placa) : (os.placaTexto || 'SEM PLACA'),
        modelo: os.modelo || null,
        proprietario: os.proprietario || null,
        telefone: os.telefone || null,
        os: [],
      });
    }
    grupos.get(chave).os.push(os);
  }
  return grupos;
}

function aplicarSync(db, listaEmExecucao, { agora = agoraSP(), empresasLidas } = {}) {
  const lidas = new Set(empresasLidas || [...new Set(listaEmExecucao.map((o) => o.empresa || 'cavallaria'))]);
  if (!lidas.size) lidas.add('cavallaria');
  const marcadores = [...lidas].map(() => '?').join(',');

  const grupos = agruparPorVeiculo(listaEmExecucao);
  const resultado = { novos: 0, mantidos: 0, finalizados: 0, os_lidas: listaEmExecucao.length, avisos: [] };

  const selAtivos = db.prepare("SELECT * FROM patio_vehicles WHERE status = 'ativo'");
  const selOrdensAtivas = db.prepare('SELECT os_number, empresa FROM patio_vehicle_orders WHERE vehicle_id = ? AND finished_at IS NULL');
  const insVeiculo = db.prepare(`
    INSERT INTO patio_vehicles (placa_normalizada, placa_exibicao, modelo, proprietario, telefone, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const updVeiculo = db.prepare(`
    UPDATE patio_vehicles SET last_seen_at = ?, placa_exibicao = ?,
      modelo = COALESCE(?, modelo), proprietario = COALESCE(?, proprietario), telefone = COALESCE(?, telefone)
    WHERE id = ?`);
  const finVeiculo = db.prepare("UPDATE patio_vehicles SET status = 'finalizado', finished_at = ? WHERE id = ?");
  const insOrder = db.prepare(`INSERT OR IGNORE INTO patio_vehicle_orders (vehicle_id, os_number, os_id_interno, entrada, last_seen_at, empresa) VALUES (?, ?, ?, ?, ?, ?)`);
  const updOrder = db.prepare(`UPDATE patio_vehicle_orders SET last_seen_at = ?, os_id_interno = COALESCE(?, os_id_interno), entrada = COALESCE(?, entrada), empresa = ?, finished_at = NULL WHERE vehicle_id = ? AND os_number = ?`);
  const finOrdersAusentes = db.prepare(`UPDATE patio_vehicle_orders SET finished_at = ? WHERE vehicle_id = ? AND finished_at IS NULL AND last_seen_at < ? AND empresa IN (${marcadores})`);
  const finOrdersTodas = db.prepare(`UPDATE patio_vehicle_orders SET finished_at = ? WHERE vehicle_id = ? AND finished_at IS NULL`);

  db.transaction(() => {
    const ativos = new Map(selAtivos.all().map((v) => [v.placa_normalizada, v]));

    for (const g of grupos.values()) {
      let veiculo = ativos.get(g.chave);
      if (veiculo) {
        updVeiculo.run(agora, g.placaExibicao, g.modelo, g.proprietario, g.telefone, veiculo.id);
        resultado.mantidos++;
      } else {
        const info = insVeiculo.run(g.chave, g.placaExibicao, g.modelo, g.proprietario, g.telefone, agora, agora);
        veiculo = { id: info.lastInsertRowid };
        resultado.novos++;
      }
      for (const os of g.os) {
        const empresa = os.empresa || 'cavallaria';
        insOrder.run(veiculo.id, os.osNumber, os.osId || null, os.entrada || null, agora, empresa);
        updOrder.run(agora, os.osId || null, os.entrada || null, empresa, veiculo.id, os.osNumber);
      }
      // OS deste veículo (das empresas lidas) que não vieram nesta leitura → finalizadas; o veículo fica
      finOrdersAusentes.run(agora, veiculo.id, agora, ...lidas);
      if (!g.placa) resultado.avisos.push(`OS ${g.os.map((o) => o.osNumber).join(',')} sem placa válida ("${g.placaExibicao}")`);
    }

    // Veículos ativos que não vieram em nenhuma lista: finalizam só se todas as suas OS
    // ativas forem de empresas lidas nesta rodada (senão, podem estar vivas no site que falhou).
    for (const [chave, v] of ativos) {
      if (grupos.has(chave)) continue;
      const ativasDeOutras = selOrdensAtivas.all(v.id).filter((o) => !lidas.has(o.empresa || 'cavallaria'));
      if (ativasDeOutras.length) {
        // as OS das fontes lidas sumiram de lá → fecham; o veículo fica pelas OS da fonte não lida
        finOrdersAusentes.run(agora, v.id, agora, ...lidas);
        resultado.avisos.push(`veículo ${v.placa_exibicao} mantido: OS ${ativasDeOutras.map((o) => o.os_number).join(',')} em fonte não lida nesta rodada`);
        continue;
      }
      finVeiculo.run(agora, v.id);
      finOrdersTodas.run(agora, v.id);
      resultado.finalizados++;
    }
  })();

  return resultado;
}

module.exports = { aplicarSync, agruparPorVeiculo, chaveVeiculo };
