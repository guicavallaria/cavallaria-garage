// Concordância entre a agenda e o painel de pátio.
//
// Escopo: SOMENTE agendamentos de hoje (America/Sao_Paulo). Match por placa
// extraída do texto livre do veículo; se o texto não tiver placa, pelo número
// da OS (campo numero_os) contra as OS ativas do veículo.
//
// Precedência: se o veículo está no pátio e na agenda de hoje, o mecânico da
// coluna da agenda PREVALECE (origem_atribuicao='agenda'). Quando o agendamento
// some (excluído/movido de dia), o veículo mantém o mecânico mas volta a
// 'manual' (editável). Dois agendamentos do mesmo veículo em colunas
// diferentes: vale o mais recente (atualizado_em, criado_em, id) + aviso.
const { hojeSP } = require('./tz');
const { extrairPlaca, normalizarPlaca } = require('./placa');

function placaDoAgendamento(a) {
  return extrairPlaca(a.veiculo);
}

function osDoAgendamento(a) {
  const n = String(a.numero_os || '').replace(/\D/g, '');
  return n || null;
}

// Veículos (ativos por padrão) com suas OS ainda em execução.
function veiculosComOrdens(db, { status = 'ativo', incluirFinalizadosDesde = null } = {}) {
  const sql = incluirFinalizadosDesde
    ? "SELECT * FROM patio_vehicles WHERE status = 'ativo' OR (status = 'finalizado' AND substr(finished_at, 1, 10) >= ?)"
    : 'SELECT * FROM patio_vehicles WHERE status = ?';
  const veiculos = db.prepare(sql).all(incluirFinalizadosDesde || status);
  const ordens = db.prepare('SELECT vehicle_id, os_number, finished_at FROM patio_vehicle_orders').all();
  const porVeiculo = new Map();
  for (const o of ordens) {
    if (!porVeiculo.has(o.vehicle_id)) porVeiculo.set(o.vehicle_id, []);
    porVeiculo.get(o.vehicle_id).push(o);
  }
  return veiculos.map((v) => ({ ...v, ordens: porVeiculo.get(v.id) || [] }));
}

// Encontra o veículo de um agendamento: placa primeiro, OS como reforço.
function casar(agendamento, veiculos) {
  const placa = placaDoAgendamento(agendamento);
  if (placa) return veiculos.find((v) => v.placa_normalizada === placa) || null;
  const os = osDoAgendamento(agendamento);
  if (os) return veiculos.find((v) => v.ordens.some((o) => String(o.os_number) === os)) || null;
  return null;
}

function maisRecentePrimeiro(a, b) {
  return (
    String(b.atualizado_em || '').localeCompare(String(a.atualizado_em || '')) ||
    String(b.criado_em || '').localeCompare(String(a.criado_em || '')) ||
    b.id - a.id
  );
}

// Vínculos veículo ativo → agendamento de hoje que o define (o mais recente).
function vinculosAgendaHoje(db, { hoje = hojeSP() } = {}) {
  const veiculos = veiculosComOrdens(db);
  const hojeAgs = db.prepare('SELECT * FROM agendamentos WHERE data = ?').all(hoje);
  const porVeiculo = new Map(); // vehicle_id → agendamentos[]
  for (const a of hojeAgs) {
    const v = casar(a, veiculos);
    if (!v) continue;
    if (!porVeiculo.has(v.id)) porVeiculo.set(v.id, []);
    porVeiculo.get(v.id).push(a);
  }
  const vinculos = new Map();
  const avisos = [];
  for (const [vid, lista] of porVeiculo) {
    lista.sort(maisRecentePrimeiro);
    const escolhido = lista[0];
    const colunas = new Set(lista.map((a) => a.mecanico_id));
    if (colunas.size > 1) {
      const v = veiculos.find((x) => x.id === vid);
      avisos.push(`veículo ${v.placa_exibicao}: ${lista.length} agendamentos hoje em colunas diferentes — usando o mais recente (#${escolhido.id})`);
    }
    vinculos.set(vid, escolhido);
  }
  return { vinculos, avisos, veiculos };
}

// Aplica a precedência da agenda sobre o pátio. Chamar após cada sync e após
// qualquer criação/edição/exclusão/movimentação de agendamento.
function reconciliarAgendaHoje(db, { hoje = hojeSP() } = {}) {
  const { vinculos, avisos, veiculos } = vinculosAgendaHoje(db, { hoje });
  const upd = db.prepare('UPDATE patio_vehicles SET mecanico_id = ?, origem_atribuicao = ? WHERE id = ?');
  let atualizados = 0;
  db.transaction(() => {
    for (const v of veiculos) {
      const ag = vinculos.get(v.id);
      if (ag) {
        if (v.mecanico_id !== ag.mecanico_id || v.origem_atribuicao !== 'agenda') {
          upd.run(ag.mecanico_id, 'agenda', v.id);
          atualizados++;
        }
      } else if (v.origem_atribuicao === 'agenda') {
        upd.run(v.mecanico_id, 'manual', v.id); // agendamento sumiu: mantém o mecânico, libera edição
        atualizados++;
      }
    }
  })();
  return { atualizados, avisos };
}

// Círculos dos agendamentos de HOJE:
//   verde    → o veículo está no pátio, OU esteve e foi finalizado hoje;
//   vermelho → nunca deu entrada hoje.
// Para outros dias devolve {} (sem indicador).
function indicadores(db, data, { hoje = hojeSP() } = {}) {
  if (data !== hoje) return {};
  const veiculos = veiculosComOrdens(db, { incluirFinalizadosDesde: hoje });
  const ags = db.prepare('SELECT * FROM agendamentos WHERE data = ?').all(data);
  const out = {};
  for (const a of ags) out[a.id] = casar(a, veiculos) ? 'verde' : 'vermelho';
  return out;
}

module.exports = { placaDoAgendamento, osDoAgendamento, casar, vinculosAgendaHoje, reconciliarAgendaHoje, indicadores, veiculosComOrdens, normalizarPlaca };
