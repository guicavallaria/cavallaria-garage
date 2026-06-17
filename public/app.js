const PX_POR_MINUTO = 1.3;
const DURACAO_PADRAO = { 'Diagnóstico': 1, 'Revisão': 2, 'Serviço Específico': 1.5 };
const CATEGORIA_CLASSE = { 'Diagnóstico': 'diag', 'Revisão': 'revisao', 'Serviço Específico': 'especifico' };

let mecanicos = [];
let config = {
  hora_abertura: '08:00',
  hora_fechamento: '18:00',
  limite_horas_dia: '8',
  pausa_almoco_inicio: '12:00',
  pausa_almoco_fim: '13:30',
};
let agendamentos = [];
let indisponibilidadesDia = [];
let todasIndisponibilidades = [];
let dataAtual = hojeISO();
let avisosConfirmados = false;

function hojeISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function primeiroNome(nomeCompleto) {
  return nomeCompleto.split(' ')[0];
}

function toMinutos(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}
function paraHHMM(minutos) {
  const h = Math.floor(minutos / 60);
  const m = minutos % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

function minutoParaPosicao(minuto) {
  return (minuto - toMinutos(config.hora_abertura)) * PX_POR_MINUTO;
}

function posicaoParaMinuto(px) {
  return toMinutos(config.hora_abertura) + px / PX_POR_MINUTO;
}

function alturaTotalAgenda() {
  return (toMinutos(config.hora_fechamento) - toMinutos(config.hora_abertura)) * PX_POR_MINUTO;
}

// Espelha a lógica do servidor: intervalos [inicioMin, fimMin) realmente ocupados,
// pulando a pausa de almoço quando a duração ultrapassa o período antes dela.
function segmentosOcupados(horaInicioStr, duracaoHoras) {
  const almocoInicio = toMinutos(config.pausa_almoco_inicio);
  const almocoFim = toMinutos(config.pausa_almoco_fim);
  const inicio = toMinutos(horaInicioStr);
  const duracaoMin = duracaoHoras * 60;
  if (inicio >= almocoFim || inicio + duracaoMin <= almocoInicio) {
    return [[inicio, inicio + duracaoMin]];
  }
  const restante = duracaoMin - (almocoInicio - inicio);
  return [
    [inicio, almocoInicio],
    [almocoFim, almocoFim + restante],
  ];
}

function fimEfetivo(horaInicioStr, duracaoHoras) {
  const segs = segmentosOcupados(horaInicioStr, duracaoHoras);
  return segs[segs.length - 1][1];
}

// Horário em que um agendamento (concluído ou não) deixa de ocupar o profissional.
function fimOcupado(a) {
  return a.concluido ? toMinutos(a.hora_conclusao) : fimEfetivo(a.hora_inicio, a.duracao_horas);
}

// Um profissional está "em atraso" se algum agendamento de hoje terminou atrasado
// ou se algum agendamento ainda pendente já começa depois do que foi planejado originalmente.
function profissionalEmAtraso(mecanicoId) {
  return agendamentos.some((a) => {
    if (a.mecanico_id !== mecanicoId) return false;
    if (a.concluido) return toMinutos(a.hora_conclusao) > fimEfetivo(a.hora_inicio, a.duracao_horas);
    return toMinutos(a.hora_inicio) > toMinutos(a.hora_inicio_planejada || a.hora_inicio);
  });
}

async function carregarBase() {
  mecanicos = await fetch('/api/mecanicos').then((r) => r.json());
  config = await fetch('/api/config').then((r) => r.json());
  preencherSelectMecanicos();
}

function preencherSelectMecanicos(id = 'campoMecanico') {
  const sel = document.getElementById(id);
  sel.innerHTML = mecanicos.map((m) => `<option value="${m.id}" title="${m.nome}">${primeiroNome(m.nome)}</option>`).join('');
}

async function carregarAgenda() {
  [agendamentos, indisponibilidadesDia] = await Promise.all([
    fetch(`/api/agendamentos?data=${dataAtual}`).then((r) => r.json()),
    fetch(`/api/indisponibilidades?data=${dataAtual}`).then((r) => r.json()),
  ]);
  renderAgenda();
  renderCapacidade();
  verificarDataAviso();
}

async function verificarDataAviso() {
  const chip = document.getElementById('dataAvisoChip');
  const { especial } = await fetch(`/api/data-info?data=${dataAtual}`).then((r) => r.json());
  if (!especial) { chip.className = 'data-aviso-chip hidden'; return; }

  const cfg = {
    DOMINGO:     { emoji: '🚫', classe: 'aviso-feriado'     },
    SABADO:      { emoji: '⚠️', classe: 'aviso-sabado'      },
    FERIADO:     { emoji: '🚫', classe: 'aviso-feriado'      },
    FACULTATIVO: { emoji: '📅', classe: 'aviso-facultativo'  },
  }[especial.tipo] || { emoji: '⚠️', classe: 'aviso-sabado' };

  chip.textContent = `${cfg.emoji} ${especial.nome}`;
  chip.title = especial.mensagem;
  chip.className = `data-aviso-chip ${cfg.classe}`;
}

function renderCapacidade() {
  fetch(`/api/capacidade?data=${dataAtual}`)
    .then((r) => r.json())
    .then((lista) => {
      const cont = document.getElementById('capacidade');
      cont.innerHTML = lista
        .map((m) => {
          const pct = Math.min(m.percentual, 100);
          let classeFill = '';
          if (m.sobrecarregado) classeFill = 'sobrecarga';
          else if (m.percentual >= 80) classeFill = 'aviso';
          const atrasado = profissionalEmAtraso(m.mecanico_id);
          return `
          <div class="cap-card ${m.sobrecarregado ? 'sobrecarga' : ''}">
            <div class="cap-nome ${atrasado ? 'atrasado' : ''}" title="${m.nome}"><span class="cap-dot" style="background:${m.cor}"></span>${primeiroNome(m.nome)}</div>
            <div class="cap-horas">${m.horas_agendadas}h / ${m.limite_horas}h ${m.sobrecarregado ? '⚠️ sobrecarregado' : ''}</div>
            <div class="cap-bar-track"><div class="cap-bar-fill ${classeFill}" style="width:${pct}%"></div></div>
          </div>`;
        })
        .join('');
    });
}

function renderAgenda() {
  const aberturaMin = toMinutos(config.hora_abertura);
  const fechamentoMin = toMinutos(config.hora_fechamento);
  const almocoInicioMin = toMinutos(config.pausa_almoco_inicio);
  const almocoFimMin = toMinutos(config.pausa_almoco_fim);
  const alturaTotal = alturaTotalAgenda();

  const agenda = document.getElementById('agenda');
  agenda.innerHTML = '';

  const colHorarios = document.createElement('div');
  colHorarios.className = 'coluna-horarios';
  colHorarios.style.height = alturaTotal + 30 + 'px';
  for (let m = aberturaMin; m <= fechamentoMin; m += 60) {
    const label = document.createElement('div');
    label.className = 'slot-label';
    label.style.top = minutoParaPosicao(m) + 30 + 'px';
    label.textContent = paraHHMM(m);
    colHorarios.appendChild(label);
  }
  agenda.appendChild(colHorarios);

  mecanicos.forEach((mec) => {
    const col = document.createElement('div');
    col.className = 'coluna-mecanico';

    const indisp = indisponibilidadesDia.find((i) => i.mecanico_id === mec.id);

    const cab = document.createElement('div');
    cab.className = 'cabecalho' + (profissionalEmAtraso(mec.id) ? ' atrasado' : '');
    cab.style.borderBottomColor = mec.cor;
    cab.title = mec.nome;
    cab.textContent = primeiroNome(mec.nome) + (indisp ? ' 🌴' : '');
    col.appendChild(cab);

    const trilho = document.createElement('div');
    trilho.className = 'trilho';
    trilho.style.height = alturaTotal + 'px';
    trilho.addEventListener('click', (ev) => {
      if (ev.target !== trilho) return;
      let minutos = Math.round(posicaoParaMinuto(ev.offsetY) / 15) * 15;
      minutos = Math.max(aberturaMin, Math.min(minutos, fechamentoMin - 30));
      abrirModalNovo(mec.id, paraHHMM(minutos));
    });

    const almocoOverlay = document.createElement('div');
    almocoOverlay.className = 'trilho-almoco';
    almocoOverlay.style.top = minutoParaPosicao(almocoInicioMin) + 'px';
    almocoOverlay.style.height = (almocoFimMin - almocoInicioMin) * PX_POR_MINUTO + 'px';
    almocoOverlay.textContent = `🍽 Almoço ${paraHHMM(almocoInicioMin)}–${paraHHMM(almocoFimMin)}`;
    trilho.appendChild(almocoOverlay);

    if (indisp) {
      const overlay = document.createElement('div');
      overlay.className = 'trilho-indisponivel';
      const label = document.createElement('div');
      label.className = 'trilho-indisponivel-label';
      label.textContent = indisp.motivo ? `Indisponível · ${indisp.motivo}` : 'Indisponível';
      trilho.appendChild(overlay);
      trilho.appendChild(label);
    }

    const doMecanico = agendamentos.filter((a) => a.mecanico_id === mec.id);
    const grupos = {};
    doMecanico.forEach((a) => {
      (grupos[a.hora_inicio] = grupos[a.hora_inicio] || []).push(a);
    });

    Object.values(grupos).forEach((grupo) => {
      grupo.forEach((a, idx) => {
        const segmentos = a.concluido
          ? [[toMinutos(a.hora_inicio), Math.max(toMinutos(a.hora_conclusao), toMinutos(a.hora_inicio) + 5)]]
          : segmentosOcupados(a.hora_inicio, a.duracao_horas);

        segmentos.forEach((seg, segIdx) => {
          const top = minutoParaPosicao(seg[0]);
          const altura = Math.max((seg[1] - seg[0]) * PX_POR_MINUTO - 2, 18);
          const bloco = document.createElement('div');
          bloco.className = 'bloco-agendamento' + (a.concluido ? ' concluido' : '') + (segIdx > 0 ? ' continuacao' : '');
          bloco.style.top = top + 'px';
          bloco.style.height = altura + 'px';
          bloco.style.background = hexComAlpha(mec.cor, 0.12);
          bloco.style.borderLeftColor = mec.cor;
          if (grupo.length > 1) {
            bloco.style.left = `calc(${idx} * (100% / ${grupo.length}) + 4px)`;
            bloco.style.width = `calc(100% / ${grupo.length} - 8px)`;
            bloco.style.right = 'auto';
          }

          if (segIdx > 0) {
            bloco.innerHTML = `<div class="b-continuacao">↳ continua até ${paraHHMM(seg[1])}</div>`;
          } else {
            const horaFimEstimada = paraHHMM(fimEfetivo(a.hora_inicio, a.duracao_horas));

            let extra = '';
            if (a.concluido) {
              const fimPrevisto = fimEfetivo(a.hora_inicio, a.duracao_horas);
              const diff = fimPrevisto - toMinutos(a.hora_conclusao); // positivo = terminou antes (adiantamento)
              let situacao;
              if (diff > 0) situacao = `${diff} min de antecipação`;
              else if (diff < 0) situacao = `${Math.abs(diff)} min de atraso`;
              else situacao = 'no horário previsto';
              extra = `
                <div class="b-concluido ${diff < 0 ? 'atrasado' : 'no-prazo'}">✔ Concluído ${a.hora_conclusao} · ${situacao}</div>
                <button type="button" class="btn-desfazer">✕ Desfazer conclusão</button>
              `;
            } else {
              const diffPlano = toMinutos(a.hora_inicio_planejada || a.hora_inicio) - toMinutos(a.hora_inicio);
              if (diffPlano !== 0) {
                const cls = diffPlano > 0 ? 'antecipado' : 'atraso-plano';
                const txt = diffPlano > 0 ? `▲ Antecipado ${diffPlano}min` : `▼ Atrasado ${Math.abs(diffPlano)}min`;
                extra += `<div class="b-desvio-plano ${cls}">${txt}</div>`;
              }
              extra += `<button type="button" class="btn-concluir">✓ Concluir</button>`;
            }

            let lembreteTag = '';
            if (a.lembrete_enviado_em) {
              const [dp, tp] = a.lembrete_enviado_em.split(' ');
              const [ey, em, ed] = dp.split('-');
              lembreteTag = `<div class="b-lembrete">📲 Lembrete ${ed}/${em} ${tp.slice(0,5)}</div>`;
            }

            bloco.innerHTML = `
              <button type="button" class="btn-info" title="Ver informações">ℹ</button>
              <span class="b-categoria ${CATEGORIA_CLASSE[a.categoria] || ''}">${a.categoria}</span>
              <div class="b-os">${[a.numero_os ? 'OS ' + a.numero_os : '', a.nome_cliente || ''].filter(Boolean).join(' · ')}</div>
              <div class="b-veiculo">${a.veiculo}</div>
              <div class="b-servico">${a.servico}</div>
              <div class="b-hora">${a.hora_inicio} – ${horaFimEstimada} (${a.duracao_horas}h${segmentos.length > 1 ? ', com pausa' : ''})</div>
              ${lembreteTag}
              ${extra}
            `;
          }

          bloco.addEventListener('click', (ev) => {
            ev.stopPropagation();
            abrirModalEdicao(a);
          });
          const btnInfo = bloco.querySelector('.btn-info');
          if (btnInfo) {
            btnInfo.addEventListener('click', (ev) => {
              ev.stopPropagation();
              abrirModalInfo(a, mec);
            });
          }
          const btnConcluir = bloco.querySelector('.btn-concluir');
          if (btnConcluir) {
            btnConcluir.addEventListener('click', (ev) => {
              ev.stopPropagation();
              marcarConcluido(a);
            });
          }
          const btnDesfazer = bloco.querySelector('.btn-desfazer');
          if (btnDesfazer) {
            btnDesfazer.addEventListener('click', (ev) => {
              ev.stopPropagation();
              desfazerConclusao(a);
            });
          }
          trilho.appendChild(bloco);
        });
      });
    });

    col.appendChild(trilho);
    agenda.appendChild(col);
  });
}

function hexComAlpha(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function somarDias(dataISO, n) {
  const d = new Date(dataISO + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ---------- Concluir agendamento / desfazer / adiantar próximos ----------
let agendamentoConcluidoContexto = null;

async function marcarConcluido(a) {
  const agora = new Date();
  const horaConclusao = `${String(agora.getHours()).padStart(2, '0')}:${String(agora.getMinutes()).padStart(2, '0')}`;

  const resp = await fetch(`/api/agendamentos/${a.id}/concluir`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hora_conclusao: horaConclusao }),
  });
  const result = await resp.json();
  if (!resp.ok) {
    alert(result.erro || 'Erro ao concluir agendamento');
    return;
  }

  await carregarAgenda();

  if (result.diferenca_minutos > 0) {
    abrirModalAdiantar(a, result.diferenca_minutos);
  }
}

async function desfazerConclusao(a) {
  await fetch(`/api/agendamentos/${a.id}/reabrir`, { method: 'PUT' });
  carregarAgenda();
}

function abrirModalAdiantar(a, minutos) {
  agendamentoConcluidoContexto = a.id;
  document.getElementById('msgAdiantar').textContent =
    `Serviço concluído ${minutos} min antes do previsto. Deseja adiantar os próximos agendamentos?`;
  document.getElementById('chkAdiantarHoje').checked = true;
  document.getElementById('chkAdiantarAmanha').checked = false;
  document.getElementById('modalAdiantar').classList.remove('hidden');
}

document.getElementById('btnAdiantarPular').addEventListener('click', () => {
  document.getElementById('modalAdiantar').classList.add('hidden');
  agendamentoConcluidoContexto = null;
});

document.getElementById('btnAdiantarAplicar').addEventListener('click', async () => {
  if (!agendamentoConcluidoContexto) return;
  const comprimir_hoje = document.getElementById('chkAdiantarHoje').checked;
  const adiantar_amanha = document.getElementById('chkAdiantarAmanha').checked;

  await fetch(`/api/agendamentos/${agendamentoConcluidoContexto}/adiantar-apos-conclusao`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ comprimir_hoje, adiantar_amanha }),
  });

  document.getElementById('modalAdiantar').classList.add('hidden');
  agendamentoConcluidoContexto = null;
  carregarAgenda();
});

// ---------- Modal de agendamento ----------
const modalAgendamento = document.getElementById('modalAgendamento');
const formAgendamento = document.getElementById('formAgendamento');

function resetBtnExcluir() {
  confirmandoExclusao = false;
  const btn = document.getElementById('btnExcluir');
  btn.textContent = 'Excluir';
  btn.classList.remove('btn-confirmando');
}

function resetAvisoPreSalvar() {
  avisosConfirmados = false;
  dataEspecialConfirmada = false;
  document.getElementById('avisoPreSalvar').classList.add('hidden');
}

function abrirModalNovo(mecanicoId, hora) {
  formAgendamento.reset();
  document.getElementById('agendamentoId').value = '';
  document.getElementById('modalTitulo').textContent = 'Novo agendamento';
  document.getElementById('btnExcluir').classList.add('hidden');
  resetBtnExcluir();
  resetAvisoPreSalvar();
  document.getElementById('avisoConflito').classList.add('hidden');
  if (mecanicoId) document.getElementById('campoMecanico').value = mecanicoId;
  document.getElementById('campoData').value = dataAtual;
  document.getElementById('campoHora').value = hora || config.hora_abertura;
  document.getElementById('campoCategoria').value = 'Diagnóstico';
  document.getElementById('campoDuracao').value = DURACAO_PADRAO['Diagnóstico'];
  document.getElementById('campoRepetir').value = 0;
  document.getElementById('campoRepetirWrapper').classList.remove('hidden');
  document.getElementById('btnPuxarUltimo').classList.add('hidden');
  modalAgendamento.classList.remove('hidden');
}

function abrirModalEdicao(a) {
  formAgendamento.reset();
  document.getElementById('agendamentoId').value = a.id;
  document.getElementById('modalTitulo').textContent = 'Editar agendamento';
  document.getElementById('btnExcluir').classList.remove('hidden');
  resetBtnExcluir();
  resetAvisoPreSalvar();
  document.getElementById('avisoConflito').classList.add('hidden');
  document.getElementById('campoMecanico').value = a.mecanico_id;
  document.getElementById('campoCategoria').value = a.categoria;
  document.getElementById('campoNomeCliente').value = a.nome_cliente || '';
  document.getElementById('campoVeiculo').value = a.veiculo;
  document.getElementById('campoTelefone').value = a.telefone || '';
  document.getElementById('campoOS').value = a.numero_os || '';
  document.getElementById('campoServico').value = a.servico;
  document.getElementById('campoData').value = a.data;
  document.getElementById('campoHora').value = a.hora_inicio;
  document.getElementById('campoDuracao').value = a.duracao_horas;
  document.getElementById('campoObs').value = a.observacoes || '';
  document.getElementById('campoRepetir').value = 0;
  document.getElementById('campoRepetirWrapper').classList.remove('hidden');
  document.getElementById('btnPuxarUltimo').classList.remove('hidden');
  modalAgendamento.classList.add('hidden');
  modalAgendamento.classList.remove('hidden');
}

document.getElementById('btnPuxarUltimo').addEventListener('click', async () => {
  const mecanicoId = Number(document.getElementById('campoMecanico').value);
  const data = document.getElementById('campoData').value;
  const idAtual = document.getElementById('agendamentoId').value;

  const lista =
    data === dataAtual
      ? agendamentos
      : await fetch(`/api/agendamentos?data=${data}`).then((r) => r.json());

  let ultimoFim = toMinutos(config.hora_abertura);
  lista
    .filter((x) => x.mecanico_id === mecanicoId && String(x.id) !== idAtual)
    .forEach((x) => {
      ultimoFim = Math.max(ultimoFim, fimOcupado(x));
    });

  document.getElementById('campoHora').value = paraHHMM(ultimoFim);
  resetAvisoPreSalvar();
});

document.getElementById('campoCategoria').addEventListener('change', (ev) => {
  const padrao = DURACAO_PADRAO[ev.target.value];
  if (padrao) document.getElementById('campoDuracao').value = padrao;
});

['campoCategoria', 'campoData', 'campoMecanico'].forEach((id) => {
  document.getElementById(id).addEventListener('change', resetAvisoPreSalvar);
});

document.getElementById('btnNovo').addEventListener('click', () => abrirModalNovo(null, null));
document.getElementById('btnCancelar').addEventListener('click', () => modalAgendamento.classList.add('hidden'));

let confirmandoExclusao = false;
document.getElementById('btnExcluir').addEventListener('click', async (ev) => {
  const id = document.getElementById('agendamentoId').value;
  if (!id) return;
  if (!confirmandoExclusao) {
    confirmandoExclusao = true;
    ev.target.textContent = 'Confirmar exclusão?';
    ev.target.classList.add('btn-confirmando');
    return;
  }
  await fetch(`/api/agendamentos/${id}`, { method: 'DELETE' });
  modalAgendamento.classList.add('hidden');
  carregarAgenda();
});

function coletarPayload() {
  return {
    mecanico_id: Number(document.getElementById('campoMecanico').value),
    categoria: document.getElementById('campoCategoria').value,
    nome_cliente: document.getElementById('campoNomeCliente').value || null,
    veiculo: document.getElementById('campoVeiculo').value,
    telefone: document.getElementById('campoTelefone').value || null,
    numero_os: document.getElementById('campoOS').value,
    servico: document.getElementById('campoServico').value,
    data: document.getElementById('campoData').value,
    hora_inicio: document.getElementById('campoHora').value,
    duracao_horas: Number(document.getElementById('campoDuracao').value),
    observacoes: document.getElementById('campoObs').value,
    repetir_dias: Number(document.getElementById('campoRepetir').value) || 0,
  };
}

function mostrarAvisoPreSalvar(avisos) {
  document.getElementById('avisoPreSalvarMsg').innerHTML =
    avisos.map((a) => `⚠️ ${a.mensagem}`).join('<br>') + '<br><br>Você está ciente e deseja prosseguir?';
  document.getElementById('avisoPreSalvar').classList.remove('hidden');
}

document.getElementById('btnAvisoCancelar').addEventListener('click', resetAvisoPreSalvar);

document.getElementById('btnAvisoConfirmar').addEventListener('click', async () => {
  avisosConfirmados = true;
  document.getElementById('avisoPreSalvar').classList.add('hidden');
  await salvarAgendamento(coletarPayload());
});

let dataEspecialConfirmada = false;

formAgendamento.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const payload = coletarPayload();

  if (!dataEspecialConfirmada) {
    const info = await fetch(`/api/data-info?data=${payload.data}`).then((r) => r.json());
    if (info.especial) {
      const { tipo, nome } = info.especial;
      const labels = { sabado: 'Sábado', domingo: 'Domingo', feriado: 'Feriado', facultativo: 'Ponto facultativo' };
      const label = labels[tipo] || tipo;
      const msg = nome ? `${label}: ${nome}` : label;
      const ok = confirm(`⚠️ ${msg}\n\nDeseja prosseguir com o agendamento mesmo assim?`);
      if (!ok) return;
    }
    dataEspecialConfirmada = true;
  }

  if (!avisosConfirmados) {
    const idAtual = document.getElementById('agendamentoId').value;
    const params = new URLSearchParams({
      data: payload.data,
      categoria: payload.categoria,
      mecanico_id: payload.mecanico_id,
      hora_inicio: payload.hora_inicio,
    });
    if (idAtual) params.set('excludeId', idAtual);
    const { avisos } = await fetch(`/api/avisos?${params.toString()}`).then((r) => r.json());
    if (avisos.length) {
      mostrarAvisoPreSalvar(avisos);
      return;
    }
  }

  await salvarAgendamento(payload);
});

async function salvarAgendamento(payload) {
  const id = document.getElementById('agendamentoId').value;
  const url = id ? `/api/agendamentos/${id}` : '/api/agendamentos';
  const method = id ? 'PUT' : 'POST';
  const resp = await fetch(url, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
  const result = await resp.json();

  if (!resp.ok) {
    alert(result.erro || 'Erro ao salvar agendamento');
    return;
  }

  if (result.conflitos && result.conflitos.length) {
    const aviso = document.getElementById('avisoConflito');
    aviso.classList.remove('hidden');
    aviso.innerHTML =
      '⚠️ Conflito de horário com: ' +
      result.conflitos.map((c) => `${c.veiculo} (${c.hora_inicio}, ${c.duracao_horas}h)`).join(', ') +
      '. Agendamento salvo mesmo assim — revise os horários.';
    setTimeout(() => modalAgendamento.classList.add('hidden'), 2200);
  } else {
    modalAgendamento.classList.add('hidden');
  }

  if (payload.data === dataAtual) carregarAgenda();
  else {
    dataAtual = payload.data;
    document.getElementById('dataAtual').value = dataAtual;
    carregarAgenda();
  }
}

// ---------- Navegação de data ----------
const inputData = document.getElementById('dataAtual');
inputData.value = dataAtual;
inputData.addEventListener('change', () => {
  dataAtual = inputData.value;
  carregarAgenda();
});
document.getElementById('btnHoje').addEventListener('click', () => {
  dataAtual = hojeISO();
  inputData.value = dataAtual;
  carregarAgenda();
});
document.getElementById('btnPrev').addEventListener('click', () => mudarDia(-1));
document.getElementById('btnNext').addEventListener('click', () => mudarDia(1));
function mudarDia(delta) {
  dataAtual = somarDias(dataAtual, delta);
  inputData.value = dataAtual;
  carregarAgenda();
}

// ---------- Modal de configurações ----------
const modalConfig = document.getElementById('modalConfig');
document.getElementById('btnConfig').addEventListener('click', () => {
  document.getElementById('cfgAbertura').value = config.hora_abertura;
  document.getElementById('cfgFechamento').value = config.hora_fechamento;
  document.getElementById('cfgLimite').value = config.limite_horas_dia;
  document.getElementById('cfgAlmocoInicio').value = config.pausa_almoco_inicio;
  document.getElementById('cfgAlmocoFim').value = config.pausa_almoco_fim;
  preencherSelectMecanicos('indispMecanico');
  carregarIndisponibilidades();
  modalConfig.classList.remove('hidden');
});
document.getElementById('btnFecharConfig').addEventListener('click', () => modalConfig.classList.add('hidden'));

document.getElementById('formConfig').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const novaConfig = {
    hora_abertura: document.getElementById('cfgAbertura').value,
    hora_fechamento: document.getElementById('cfgFechamento').value,
    limite_horas_dia: document.getElementById('cfgLimite').value,
    pausa_almoco_inicio: document.getElementById('cfgAlmocoInicio').value,
    pausa_almoco_fim: document.getElementById('cfgAlmocoFim').value,
  };
  await fetch('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(novaConfig) });
  config = novaConfig;
  modalConfig.classList.add('hidden');
  carregarAgenda();
});

document.getElementById('btnAddMecanico').addEventListener('click', async () => {
  const nome = document.getElementById('novoMecanicoNome').value.trim();
  const cor = document.getElementById('novoMecanicoCor').value;
  if (!nome) return;
  const resp = await fetch('/api/mecanicos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nome, cor }) });
  if (!resp.ok) {
    const erro = await resp.json();
    alert(erro.erro);
    return;
  }
  document.getElementById('novoMecanicoNome').value = '';
  await carregarBase();
  carregarAgenda();
});

// ---------- Férias / períodos indisponíveis ----------
async function carregarIndisponibilidades() {
  todasIndisponibilidades = await fetch('/api/indisponibilidades').then((r) => r.json());
  renderListaIndisponibilidades();
}

function renderListaIndisponibilidades() {
  const cont = document.getElementById('listaIndisponibilidades');
  if (!todasIndisponibilidades.length) {
    cont.innerHTML = '<div style="color:#888;font-size:12.5px;">Nenhum período cadastrado.</div>';
    return;
  }
  cont.innerHTML = todasIndisponibilidades
    .map(
      (i) => `
      <div class="indisp-item">
        <div class="indisp-info" title="${i.mecanico_nome}"><strong>${primeiroNome(i.mecanico_nome)}</strong> — ${i.data_inicio} a ${i.data_fim}${i.motivo ? ' · ' + i.motivo : ''}</div>
        <button type="button" class="indisp-remover" data-id="${i.id}">Remover</button>
      </div>`
    )
    .join('');
  cont.querySelectorAll('.indisp-remover').forEach((btn) => {
    btn.addEventListener('click', async () => {
      await fetch(`/api/indisponibilidades/${btn.dataset.id}`, { method: 'DELETE' });
      await carregarIndisponibilidades();
      carregarAgenda();
    });
  });
}

document.getElementById('btnAddIndisp').addEventListener('click', async () => {
  const mecanico_id = Number(document.getElementById('indispMecanico').value);
  const data_inicio = document.getElementById('indispInicio').value;
  const data_fim = document.getElementById('indispFim').value;
  const motivo = document.getElementById('indispMotivo').value;
  if (!mecanico_id || !data_inicio || !data_fim) {
    alert('Preencha profissional, data início e data fim.');
    return;
  }
  const resp = await fetch('/api/indisponibilidades', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ mecanico_id, data_inicio, data_fim, motivo }),
  });
  if (!resp.ok) {
    const erro = await resp.json();
    alert(erro.erro);
    return;
  }
  document.getElementById('indispInicio').value = '';
  document.getElementById('indispFim').value = '';
  document.getElementById('indispMotivo').value = '';
  await carregarIndisponibilidades();
  carregarAgenda();
});

// ---------- Modal de informações ----------
let agendamentoInfoAtual = null;

function abrirModalInfo(a, mec) {
  agendamentoInfoAtual = a;
  const horaFimEstimada = paraHHMM(fimEfetivo(a.hora_inicio, a.duracao_horas));
  const [y, m, d] = a.data.split('-');
  const dataFormatada = `${d}/${m}/${y}`;
  const telefoneDisplay = a.telefone ? `+55(${a.telefone})` : '—';
  const nomeClienteDisplay = a.nome_cliente || '—';

  let statusHtml = '';
  if (a.concluido) {
    const fimPrevisto = fimEfetivo(a.hora_inicio, a.duracao_horas);
    const diff = fimPrevisto - toMinutos(a.hora_conclusao);
    const situacao = diff > 0 ? `${diff} min de antecipação` : diff < 0 ? `${Math.abs(diff)} min de atraso` : 'no horário previsto';
    statusHtml = `<div class="info-row"><span class="info-label">Conclusão</span><span class="info-value"><span class="b-concluido ${diff < 0 ? 'atrasado' : 'no-prazo'}">✔ ${a.hora_conclusao} · ${situacao}</span></span></div>`;
  } else {
    statusHtml = `<div class="info-row"><span class="info-label">Status</span><span class="info-value">Em andamento</span></div>`;
  }

  document.getElementById('infoContent').innerHTML = `
    <div class="info-grid">
      <div class="info-row"><span class="info-label">Profissional</span><span class="info-value">${mec.nome}</span></div>
      <div class="info-row"><span class="info-label">Categoria</span><span class="info-value"><span class="b-categoria ${CATEGORIA_CLASSE[a.categoria] || ''}">${a.categoria}</span></span></div>
      <div class="info-row"><span class="info-label">Cliente</span><span class="info-value">${nomeClienteDisplay}</span></div>
      <div class="info-row"><span class="info-label">Veículo</span><span class="info-value">${a.veiculo}</span></div>
      <div class="info-row"><span class="info-label">Telefone</span><span class="info-value">${telefoneDisplay}</span></div>
      <div class="info-row"><span class="info-label">OS</span><span class="info-value">${a.numero_os || '—'}</span></div>
      <div class="info-row"><span class="info-label">Serviço</span><span class="info-value">${a.servico}</span></div>
      <div class="info-row"><span class="info-label">Data</span><span class="info-value">${dataFormatada}</span></div>
      <div class="info-row"><span class="info-label">Horário</span><span class="info-value">${a.hora_inicio} – ${horaFimEstimada} (${a.duracao_horas}h)</span></div>
      ${a.observacoes ? `<div class="info-row"><span class="info-label">Observações</span><span class="info-value">${a.observacoes}</span></div>` : ''}
      ${statusHtml}
    </div>
  `;
  document.getElementById('modalInfo').classList.remove('hidden');
}

document.getElementById('btnFecharInfo').addEventListener('click', () => {
  document.getElementById('modalInfo').classList.add('hidden');
});

document.getElementById('btnEditarDoInfo').addEventListener('click', () => {
  document.getElementById('modalInfo').classList.add('hidden');
  if (agendamentoInfoAtual) abrirModalEdicao(agendamentoInfoAtual);
});

// ---------- WhatsApp status ----------
let waStatusAtual = 'disconnected';
let waStatusInterval = null;

async function verificarStatusWA() {
  const { status, qrDataUrl } = await fetch('/api/whatsapp/status').then((r) => r.json());
  waStatusAtual = status;

  const dot = document.getElementById('waStatusDot');
  const txt = document.getElementById('waStatusTxt');
  dot.className = 'wa-dot';
  if (status === 'ready') {
    dot.classList.add('wa-dot-on');
    txt.textContent = 'WhatsApp ✓';
  } else if (status === 'qr' || status === 'connecting') {
    dot.classList.add('wa-dot-wait');
    txt.textContent = status === 'qr' ? 'Escanear QR' : 'Conectando…';
    // Atualiza QR no modal se estiver aberto
    const qrImg = document.getElementById('qrImage');
    const qrLoading = document.getElementById('qrLoading');
    if (qrDataUrl && qrImg) {
      qrImg.src = qrDataUrl;
      qrImg.classList.remove('hidden');
      qrLoading.classList.add('hidden');
    }
  } else {
    dot.classList.add('wa-dot-off');
    txt.textContent = 'WhatsApp';
  }

  // Atualiza botões de enviar no modal de lembretes
  document.querySelectorAll('.btn-enviar-lembrete').forEach((btn) => {
    btn.disabled = status !== 'ready';
    if (status === 'ready' && btn.textContent === '📵 Desconectado') btn.textContent = '📤 Enviar';
    if (status !== 'ready' && !btn.classList.contains('enviado') && !btn.classList.contains('erro')) {
      btn.textContent = '📵 Desconectado';
    }
  });

  // Atualiza mensagem de status no modal QR
  const msgEl = document.getElementById('qrStatusMsg');
  if (msgEl) {
    if (status === 'ready') msgEl.textContent = '✅ Conectado com sucesso!';
    else if (status === 'qr') msgEl.textContent = 'Aguardando escaneamento do QR Code…';
    else if (status === 'connecting') msgEl.textContent = 'Conectando, aguarde…';
    else msgEl.textContent = 'Desconectado. Clique em Reconectar para gerar um novo QR.';
  }
}

document.getElementById('btnWAStatus').addEventListener('click', async () => {
  await verificarStatusWA();
  document.getElementById('qrImage').classList.add('hidden');
  document.getElementById('qrLoading').classList.remove('hidden');
  document.getElementById('modalQR').classList.remove('hidden');
  await verificarStatusWA();
  // Polling enquanto modal aberto e não conectado
  if (waStatusAtual !== 'ready') {
    waStatusInterval = setInterval(async () => {
      await verificarStatusWA();
      if (waStatusAtual === 'ready') {
        clearInterval(waStatusInterval);
        waStatusInterval = null;
      }
    }, 3000);
  }
});

document.getElementById('btnFecharQR').addEventListener('click', () => {
  clearInterval(waStatusInterval);
  waStatusInterval = null;
  document.getElementById('modalQR').classList.add('hidden');
});

document.getElementById('btnReconectarWA').addEventListener('click', async () => {
  document.getElementById('qrImage').classList.add('hidden');
  document.getElementById('qrLoading').classList.remove('hidden');
  document.getElementById('qrStatusMsg').textContent = 'Reiniciando conexão…';
  await fetch('/api/whatsapp/reconectar', { method: 'POST' });
  clearInterval(waStatusInterval);
  waStatusInterval = setInterval(async () => {
    await verificarStatusWA();
    if (waStatusAtual === 'ready') {
      clearInterval(waStatusInterval);
      waStatusInterval = null;
    }
  }, 3000);
});

async function desfazerLembrete(id, card, enviarBtn) {
  await fetch(`/api/agendamentos/${id}/lembrete`, { method: 'DELETE' });
  card.classList.remove('lembrete-card-enviado');
  const badge = card.querySelector('.lembrete-enviado-badge');
  if (badge) badge.remove();
  if (enviarBtn) {
    enviarBtn.textContent = waStatusAtual === 'ready' ? '📤 Enviar' : '📵 Desconectado';
    enviarBtn.classList.remove('enviado');
    enviarBtn.disabled = waStatusAtual !== 'ready';
  }
}

// ---------- Modal de lembretes WhatsApp ----------
document.getElementById('btnLembrete').addEventListener('click', async () => {
  document.getElementById('lembreteData').value = dataAtual;
  document.getElementById('lembreteResultado').innerHTML = '';
  document.getElementById('modalLembrete').classList.remove('hidden');
  await verificarStatusWA();
});

document.getElementById('btnFecharLembrete').addEventListener('click', () => {
  document.getElementById('modalLembrete').classList.add('hidden');
});

document.getElementById('btnGerarLembretes').addEventListener('click', async () => {
  const data = document.getElementById('lembreteData').value;
  if (!data) return;

  const ags = await fetch(`/api/agendamentos?data=${data}`).then((r) => r.json());
  const [y, m, d] = data.split('-');
  const dataFormatada = `${d}/${m}/${y}`;

  if (!ags.length) {
    document.getElementById('lembreteResultado').innerHTML =
      '<p style="color:#888;font-size:13px">Nenhum agendamento encontrado para esta data.</p>';
    return;
  }

  const comTelefone = ags.filter((a) => a.telefone);
  const semTelefone = ags.filter((a) => !a.telefone);

  let html = '';

  if (comTelefone.length) {
    html += '<div class="lembrete-list">';
    comTelefone.forEach((a) => {
      const tel = `+55(${a.telefone})`;
      const horaPeriodo = toMinutos(a.hora_inicio) < toMinutos(config.pausa_almoco_inicio)
        ? config.hora_abertura
        : config.pausa_almoco_fim;
      const corpoMsg = `Caro Cliente, esta mensagem é um lembrete do seu agendamento na oficina Cavallaria Garage para o dia ${dataFormatada} às ${horaPeriodo}. Posso confirmar sua presença?`;
      const msgExibicao = `${tel}\n${corpoMsg}`;
      const msgEnc = encodeURIComponent(msgExibicao);
      const telRaw = encodeURIComponent(a.telefone);
      const corpoEnc = encodeURIComponent(corpoMsg);
      const waLink = `https://wa.me/55${a.telefone.replace(/\D/g, '')}?text=${corpoEnc}`;

      const jaEnviado = !!a.lembrete_enviado_em;
      let enviadoEm = '';
      if (jaEnviado) {
        const [datePart, timePart] = a.lembrete_enviado_em.split(' ');
        const [ey, em, ed] = datePart.split('-');
        enviadoEm = `${ed}/${em}/${ey} ${timePart.slice(0, 5)}`;
      }

      html += `
        <div class="lembrete-card ${jaEnviado ? 'lembrete-card-enviado' : ''}">
          <div class="lembrete-card-header">
            <span class="lembrete-telefone">${tel}</span>
            <span class="lembrete-veiculo">${a.nome_cliente ? a.nome_cliente + ' · ' : ''}${a.veiculo}${a.numero_os ? ' · OS ' + a.numero_os : ''}</span>
            <span class="lembrete-hora">${a.hora_inicio}</span>
          </div>
          ${jaEnviado ? `<div class="lembrete-enviado-badge">✅ Lembrete enviado em ${enviadoEm} <button type="button" class="btn-desfazer-lembrete" data-id="${a.id}">Desfazer</button></div>` : ''}
          <textarea class="lembrete-msg" readonly rows="3">${msgExibicao}</textarea>
          <div class="lembrete-btns">
            <button type="button" class="btn-copiar-lembrete btn-ghost" data-msg="${msgEnc}">📋 Copiar</button>
            <a href="${waLink}" target="_blank" class="btn-ghost btn-wa-link">💬 Abrir no WhatsApp</a>
            <button type="button" class="btn-enviar-lembrete btn-primary ${jaEnviado ? 'enviado' : ''}" data-id="${a.id}" data-tel="${telRaw}" data-corpo="${corpoEnc}" ${jaEnviado || waStatusAtual !== 'ready' ? 'disabled' : ''}>
              ${jaEnviado ? '✅ Enviado' : waStatusAtual === 'ready' ? '📤 Enviar' : '📵 Desconectado'}
            </button>
          </div>
        </div>`;
    });
    html += '</div>';
  }

  if (semTelefone.length) {
    html += `<div class="lembrete-sem-tel">⚠️ ${semTelefone.length} agendamento${semTelefone.length > 1 ? 's' : ''} sem telefone: ${semTelefone.map((a) => a.veiculo).join(', ')}</div>`;
  }

  document.getElementById('lembreteResultado').innerHTML = html;

  document.querySelectorAll('.btn-copiar-lembrete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const msg = decodeURIComponent(btn.dataset.msg);
      navigator.clipboard.writeText(msg).then(() => {
        const orig = btn.textContent;
        btn.textContent = '✅ Copiado!';
        setTimeout(() => { btn.textContent = orig; }, 2000);
      });
    });
  });

  document.querySelectorAll('.btn-enviar-lembrete').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const telefone = decodeURIComponent(btn.dataset.tel);
      const mensagem = decodeURIComponent(btn.dataset.corpo);
      const agendamento_id = Number(btn.dataset.id);
      btn.disabled = true;
      btn.textContent = 'Enviando…';
      const resp = await fetch('/api/whatsapp/enviar', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ telefone, mensagem, agendamento_id }),
      });
      if (resp.ok) {
        btn.textContent = '✅ Enviado';
        btn.classList.add('enviado');
        // Atualizar badge sem recarregar a lista inteira
        const card = btn.closest('.lembrete-card');
        card.classList.add('lembrete-card-enviado');
        const agora = new Date();
        const enviadoEm = `${String(agora.getDate()).padStart(2,'0')}/${String(agora.getMonth()+1).padStart(2,'0')}/${agora.getFullYear()} ${String(agora.getHours()).padStart(2,'0')}:${String(agora.getMinutes()).padStart(2,'0')}`;
        const badge = document.createElement('div');
        badge.className = 'lembrete-enviado-badge';
        badge.innerHTML = `✅ Lembrete enviado em ${enviadoEm} <button type="button" class="btn-desfazer-lembrete" data-id="${agendamento_id}">Desfazer</button>`;
        card.querySelector('.lembrete-card-header').insertAdjacentElement('afterend', badge);
        badge.querySelector('.btn-desfazer-lembrete').addEventListener('click', () => desfazerLembrete(agendamento_id, card, btn));
      } else {
        const { erro } = await resp.json();
        btn.textContent = '❌ Erro';
        btn.classList.add('erro');
        btn.title = erro;
        setTimeout(() => {
          btn.textContent = '📤 Enviar';
          btn.classList.remove('erro');
          btn.disabled = false;
        }, 3000);
      }
    });
  });

  document.querySelectorAll('.btn-desfazer-lembrete').forEach((btn) => {
    btn.addEventListener('click', () => {
      const id = Number(btn.dataset.id);
      const card = btn.closest('.lembrete-card');
      const enviarBtn = card.querySelector('.btn-enviar-lembrete');
      desfazerLembrete(id, card, enviarBtn);
    });
  });
});

// ---------- Logout ----------
document.getElementById('btnLogout').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  window.location.href = '/login';
});

// ---------- Atualizações em tempo real (SSE) ----------
(function conectarSSE() {
  const es = new EventSource('/api/eventos');
  es.addEventListener('atualizar', () => carregarAgenda());
  es.onerror = async () => {
    es.close();
    const resp = await fetch('/api/mecanicos').catch(() => null);
    if (resp && resp.status === 401) {
      window.location.href = '/login';
    } else {
      setTimeout(conectarSSE, 5000);
    }
  };
})();

// ---------- Init ----------
(async function init() {
  await carregarBase();
  await carregarAgenda();
  verificarStatusWA();
})();
