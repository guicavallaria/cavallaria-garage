// Reconciliação do pátio com a lista de OS em execução lida do Onmotor.
//
// Unidade do painel = VEÍCULO (placa normalizada), nunca a OS:
//   - várias OS da mesma placa → um veículo, várias linhas em patio_vehicle_orders;
//   - o veículo só sai quando TODAS as suas OS saírem da lista;
//   - veículo que sai vira status='finalizado' com finished_at (histórico, nunca DELETE);
//   - veículo já conhecido mantém mecanico_id/origem e só atualiza dados descritivos.
// A unicidade de placa ativa é garantida também pelo índice único parcial do banco.
const { agoraSP } = require('./tz');
const { formatarPlaca } = require('./placa');

// OS sem placa válida não pode ficar invisível no pátio: usa chave sintética.
function chaveVeiculo(os) {
  return os.placa || `OS${os.osNumber}`;
}

// Agrupa as OS lidas por veículo. Dados descritivos vêm da OS mais recente (maior número).
function agruparPorVeiculo(lista) {
  const grupos = new Map();
  const ordenada = [...lista].sort((a, b) => Number(b.osNumber) - Number(a.osNumber));
  for (const os of ordenada) {
    const chave = chaveVeiculo(os);
    if (!grupos.has(chave)) {
      grupos.set(chave, {
        chave,
        placa: os.placa,
        placaExibicao: os.placa ? formatarPlaca(os.placa) : (os.placaTexto || 'SEM PLACA'),
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

// Aplica uma leitura completa da Novidades no banco, numa única transação.
// Retorna contagens para o log. `agora` é injetável para os testes.
function aplicarSync(db, listaEmExecucao, { agora = agoraSP() } = {}) {
  const grupos = agruparPorVeiculo(listaEmExecucao);
  const resultado = { novos: 0, mantidos: 0, finalizados: 0, os_lidas: listaEmExecucao.length, avisos: [] };

  const selAtivos = db.prepare("SELECT * FROM patio_vehicles WHERE status = 'ativo'");
  const insVeiculo = db.prepare(`
    INSERT INTO patio_vehicles (placa_normalizada, placa_exibicao, modelo, proprietario, telefone, first_seen_at, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const updVeiculo = db.prepare(`
    UPDATE patio_vehicles SET last_seen_at = ?, placa_exibicao = ?,
      modelo = COALESCE(?, modelo), proprietario = COALESCE(?, proprietario), telefone = COALESCE(?, telefone)
    WHERE id = ?`);
  const finVeiculo = db.prepare("UPDATE patio_vehicles SET status = 'finalizado', finished_at = ? WHERE id = ?");
  const insOrder = db.prepare(`INSERT OR IGNORE INTO patio_vehicle_orders (vehicle_id, os_number, os_id_interno, entrada, last_seen_at) VALUES (?, ?, ?, ?, ?)`);
  const updOrder = db.prepare(`UPDATE patio_vehicle_orders SET last_seen_at = ?, os_id_interno = COALESCE(?, os_id_interno), entrada = COALESCE(?, entrada), finished_at = NULL WHERE vehicle_id = ? AND os_number = ?`);
  const finOrdersAusentes = db.prepare(`UPDATE patio_vehicle_orders SET finished_at = ? WHERE vehicle_id = ? AND finished_at IS NULL AND last_seen_at < ?`);
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
        insOrder.run(veiculo.id, os.osNumber, os.osId || null, os.entrada || null, agora);
        updOrder.run(agora, os.osId || null, os.entrada || null, veiculo.id, os.osNumber);
      }
      // OS deste veículo que não vieram nesta leitura → finalizadas (o veículo fica)
      finOrdersAusentes.run(agora, veiculo.id, agora);
      if (!g.placa) resultado.avisos.push(`OS ${g.os.map((o) => o.osNumber).join(',')} sem placa válida ("${g.placaExibicao}")`);
    }

    // Veículos ativos cuja(s) OS sumiram TODAS da lista → finalizados (histórico preservado)
    for (const [chave, v] of ativos) {
      if (grupos.has(chave)) continue;
      finVeiculo.run(agora, v.id);
      finOrdersTodas.run(agora, v.id);
      resultado.finalizados++;
    }
  })();

  return resultado;
}

module.exports = { aplicarSync, agruparPorVeiculo, chaveVeiculo };
