const { test } = require('node:test');
const assert = require('node:assert/strict');
const { bancoDeTeste, osLida } = require('./helpers/db');
const { aplicarSync } = require('../patio/reconciliar');
const { reconciliarAgendaHoje, indicadores, casar, veiculosComOrdens } = require('../patio/agenda');

const HOJE = '2026-10-21';
const ONTEM = '2026-10-20';
const AMANHA = '2026-10-22';

function agendar(db, { mecanico_id, veiculo, numero_os = null, data = HOJE, criado_em = '2026-10-21 08:00:00', atualizado_em = null }) {
  return db.prepare(`INSERT INTO agendamentos (mecanico_id, veiculo, numero_os, data, criado_em, atualizado_em) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(mecanico_id, veiculo, numero_os, data, criado_em, atualizado_em).lastInsertRowid;
}
const veiculo = (db, placa) => db.prepare("SELECT * FROM patio_vehicles WHERE placa_normalizada = ? AND status = 'ativo'").get(placa);

test('agenda de HOJE prevalece sobre a atribuição manual (match por placa no texto livre)', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [osLida({ osNumber: 7001, placa: 'ABC1234' })], { agora: `${HOJE} 08:00:00` });
  db.prepare("UPDATE patio_vehicles SET mecanico_id = 2, origem_atribuicao = 'manual'").run(); // Iago, manual
  agendar(db, { mecanico_id: 1, veiculo: 'ABC-1234 Gol 2019 prata' });                       // coluna do Luiz
  const r = reconciliarAgendaHoje(db, { hoje: HOJE });
  assert.equal(r.atualizados, 1);
  const v = veiculo(db, 'ABC1234');
  assert.equal(v.mecanico_id, 1);
  assert.equal(v.origem_atribuicao, 'agenda');
});

test('agendamentos de ontem/amanhã NÃO entram na lógica', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [osLida({ osNumber: 7001, placa: 'ABC1234' })], { agora: `${HOJE} 08:00:00` });
  db.prepare("UPDATE patio_vehicles SET mecanico_id = 2, origem_atribuicao = 'manual'").run();
  agendar(db, { mecanico_id: 1, veiculo: 'ABC1234', data: ONTEM });
  agendar(db, { mecanico_id: 3, veiculo: 'ABC1234', data: AMANHA });
  const r = reconciliarAgendaHoje(db, { hoje: HOJE });
  assert.equal(r.atualizados, 0);
  const v = veiculo(db, 'ABC1234');
  assert.equal(v.mecanico_id, 2);
  assert.equal(v.origem_atribuicao, 'manual');
});

test('mover o agendamento de coluna move o veículo no painel', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [osLida({ osNumber: 7001, placa: 'ABC1234' })], { agora: `${HOJE} 08:00:00` });
  const id = agendar(db, { mecanico_id: 1, veiculo: 'ABC1234 Civic' });
  reconciliarAgendaHoje(db, { hoje: HOJE });
  assert.equal(veiculo(db, 'ABC1234').mecanico_id, 1);
  db.prepare("UPDATE agendamentos SET mecanico_id = 3, atualizado_em = '2026-10-21 09:00:00' WHERE id = ?").run(id); // arrastou pro Edson
  reconciliarAgendaHoje(db, { hoje: HOJE });
  assert.equal(veiculo(db, 'ABC1234').mecanico_id, 3);
});

test('dois agendamentos hoje em colunas diferentes: vale o mais recente + aviso', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [osLida({ osNumber: 7001, placa: 'ABC1234' })], { agora: `${HOJE} 08:00:00` });
  agendar(db, { mecanico_id: 1, veiculo: 'ABC1234', criado_em: '2026-10-21 07:00:00' });
  agendar(db, { mecanico_id: 3, veiculo: 'ABC1234', criado_em: '2026-10-21 07:30:00' });
  const r = reconciliarAgendaHoje(db, { hoje: HOJE });
  assert.equal(veiculo(db, 'ABC1234').mecanico_id, 3);
  assert.equal(r.avisos.length, 1);
  assert.match(r.avisos[0], /colunas diferentes/);
});

test('sem placa no texto, casa pelo número da OS', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [osLida({ osNumber: 7001, placa: 'ABC1234' })], { agora: `${HOJE} 08:00:00` });
  agendar(db, { mecanico_id: 2, veiculo: 'Gol prata do João', numero_os: '7001' });
  reconciliarAgendaHoje(db, { hoje: HOJE });
  const v = veiculo(db, 'ABC1234');
  assert.equal(v.mecanico_id, 2);
  assert.equal(v.origem_atribuicao, 'agenda');
});

test('agendamento excluído: veículo mantém o mecânico e volta a ser editável (manual)', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [osLida({ osNumber: 7001, placa: 'ABC1234' })], { agora: `${HOJE} 08:00:00` });
  const id = agendar(db, { mecanico_id: 1, veiculo: 'ABC1234' });
  reconciliarAgendaHoje(db, { hoje: HOJE });
  db.prepare('DELETE FROM agendamentos WHERE id = ?').run(id);
  const r = reconciliarAgendaHoje(db, { hoje: HOJE });
  assert.equal(r.atualizados, 1);
  const v = veiculo(db, 'ABC1234');
  assert.equal(v.mecanico_id, 1);
  assert.equal(v.origem_atribuicao, 'manual');
});

test('círculos: agendado e não entrou → vermelho; entrou → verde; entrou e finalizou hoje → verde; outro dia → nada', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [osLida({ osNumber: 7001, placa: 'ABC1234' }), osLida({ osNumber: 7002, placa: 'XYZ9A87' })], { agora: `${HOJE} 08:00:00` });
  const aEntrou = agendar(db, { mecanico_id: 1, veiculo: 'ABC1234 Gol' });
  const aNaoEntrou = agendar(db, { mecanico_id: 1, veiculo: 'QQQ1Q11 Uno' });
  const aFinalizada = agendar(db, { mecanico_id: 2, veiculo: 'XYZ9A87 Civic' });
  const aAmanha = agendar(db, { mecanico_id: 2, veiculo: 'ABC1234 Gol', data: AMANHA });

  let ind = indicadores(db, HOJE, { hoje: HOJE });
  assert.equal(ind[aEntrou], 'verde');
  assert.equal(ind[aNaoEntrou], 'vermelho');
  assert.equal(ind[aFinalizada], 'verde');
  assert.equal(ind[aAmanha], undefined);

  // XYZ9A87 finaliza hoje às 14h → continua verde até o fim do dia
  aplicarSync(db, [osLida({ osNumber: 7001, placa: 'ABC1234' })], { agora: `${HOJE} 14:00:00` });
  ind = indicadores(db, HOJE, { hoje: HOJE });
  assert.equal(ind[aFinalizada], 'verde');

  // outro dia nunca recebe círculo
  assert.deepEqual(indicadores(db, AMANHA, { hoje: HOJE }), {});
});

test('círculos: veículo finalizado ONTEM não vale como entrada de hoje', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [osLida({ osNumber: 7001, placa: 'ABC1234' })], { agora: `${ONTEM} 08:00:00` });
  aplicarSync(db, [], { agora: `${ONTEM} 17:00:00` }); // finalizou ontem
  const a = agendar(db, { mecanico_id: 1, veiculo: 'ABC1234' });
  assert.equal(indicadores(db, HOJE, { hoje: HOJE })[a], 'vermelho');
});

test('casar: placa tem prioridade sobre a OS', () => {
  const db = bancoDeTeste();
  aplicarSync(db, [osLida({ osNumber: 7001, placa: 'ABC1234' }), osLida({ osNumber: 7002, placa: 'XYZ9A87' })], { agora: `${HOJE} 08:00:00` });
  const vs = veiculosComOrdens(db);
  assert.equal(casar({ veiculo: 'XYZ9A87', numero_os: '7001' }, vs).placa_normalizada, 'XYZ9A87');
  assert.equal(casar({ veiculo: 'sem placa', numero_os: '7001' }, vs).placa_normalizada, 'ABC1234');
  assert.equal(casar({ veiculo: 'sem placa', numero_os: null }, vs), null);
});
