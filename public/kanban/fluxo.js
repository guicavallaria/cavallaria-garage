// Kanban de OS — setor de orçamento e peças e aprovação de orçamento (pedido de 11/11/2026).
//
//  - Tela "Orçamento e peças" (padrão do Cauã): painel de controle (quantos cards em Orçamento,
//    Aquisição e Aguardando Peças + alertas) e as três fases com cards grandes.
//  - Tela "Aprovação de orçamento" (padrão do Luan): só a fase de aprovação, cards grandes, aviso
//    na tela quando algum card passa de 1 h esperando.
//  - Janelas obrigatórias de cada passagem de fase (peças, PDF do orçamento, aprovação, prazo).
// Quem pode mover o quê vem do servidor (estado.fluxo); o servidor confere tudo de novo.
(() => {
  const HORA = 3_600_000;
  const DIA = 24 * HORA;
  const FASE = { ORCAMENTO: 3, APROVACAO: 4, AQUISICAO: 5, AGENDAMENTO: 6, AGUARDANDO_PECAS: 10 };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const primeiro = (s) => String(s || '').trim().split(/\s+/)[0] || '';
  const fmtDia = new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
  const diaHora = (iso) => (iso ? fmtDia.format(new Date(iso)).replace(',', '') : '');

  // "2d 03h 15min" — tempo na fase nas telas do setor e da aprovação
  function dhm(ms) {
    const total = Math.max(0, Math.floor(ms / 60_000));
    const d = Math.floor(total / 1440);
    const h = Math.floor((total % 1440) / 60);
    const m = total % 60;
    return `${d}d ${String(h).padStart(2, '0')}h ${String(m).padStart(2, '0')}min`;
  }

  const naFase = (c, agora) => agora - Date.parse(c.fase_desde);
  const prazoVencido = (c, agora) => c.fase_id === FASE.AGUARDANDO_PECAS && c.pecas_prazo_em && agora > Date.parse(c.pecas_prazo_em);

  // Por que o card pisca em vermelho (null = não pisca). Vale em todas as telas.
  function motivoPiscar(c, agora) {
    if (prazoVencido(c, agora)) return 'Prazo das peças vencido';
    if (c.fase_id === FASE.APROVACAO && naFase(c, agora) > HORA) return 'Mais de 1 h aguardando aprovação';
    if ((c.fase_id === FASE.ORCAMENTO || c.fase_id === FASE.AQUISICAO) && naFase(c, agora) > DIA) return 'Mais de 1 dia nesta fase';
    return null;
  }

  // Alertas do painel de controle do setor de peças
  function alertasSetor(cards, agora) {
    const setor = cards.filter((c) => [FASE.ORCAMENTO, FASE.AQUISICAO, FASE.AGUARDANDO_PECAS].includes(c.fase_id));
    return {
      vencidos: setor.filter((c) => prazoVencido(c, agora)),
      parados: setor.filter((c) => (c.fase_id === FASE.ORCAMENTO || c.fase_id === FASE.AQUISICAO) && naFase(c, agora) > DIA),
      semEvolucao: setor.filter((c) => agora - Date.parse(c.ultimo_evento_em || c.fase_desde) > DIA),
    };
  }

  function resumoPrazo(c, agora) {
    if (c.fase_id !== FASE.AGUARDANDO_PECAS || !c.pecas_prazo_em) return '';
    const fim = Date.parse(c.pecas_prazo_em);
    return fim < agora
      ? `<div class="kb-g-prazo kb-g-prazo-vencido">⏰ Prazo vencido há ${dhm(agora - fim)} <small>(${c.pecas_prazo_dias} d, até ${diaHora(c.pecas_prazo_em)})</small></div>`
      : `<div class="kb-g-prazo">⏳ Peças até ${diaHora(c.pecas_prazo_em)} <small>(faltam ${dhm(fim - agora)})</small></div>`;
  }

  function pecasHtml(c, max = 6) {
    const p = (c.orcamento && c.orcamento.pecas) || [];
    if (!p.length) return '';
    const mais = p.length > max ? `<li class="kb-g-mais">+ ${p.length - max} peça(s)</li>` : '';
    return `<ul class="kb-g-pecas">${p.slice(0, max).map((x) => `<li>${esc(x.descricao)}</li>`).join('')}${mais}</ul>`;
  }

  // Botões de ação direto no card grande (só o que este login pode fazer)
  function acoesDoCard(ctx, c) {
    const est = ctx.estado();
    const pode = (destino) => ((est.fluxo.destinos || {})[c.fase_id] || []).includes(destino);
    const b = (destino, rotulo, extra = '', cls = '') => (pode(destino)
      ? `<button type="button" class="kb-botao ${cls}" data-fluxo-mover="${destino}" data-id="${c.id}" ${extra}>${rotulo}</button>` : '');
    if (c.fase_id === FASE.ORCAMENTO) return b(FASE.APROVACAO, '📄 Anexar orçamento → Aprovação');
    if (c.fase_id === FASE.AQUISICAO) return b(FASE.AGUARDANDO_PECAS, '⏳ Aguardando peças (prazo)') + b(FASE.AGENDAMENTO, 'Peças em mãos → Agendamento', '', 'kb-botao-sec');
    if (c.fase_id === FASE.AGUARDANDO_PECAS) return b(FASE.AGENDAMENTO, '✔ Peças chegaram → Agendamento') + b(FASE.AQUISICAO, '↩ Aquisição', '', 'kb-botao-sec');
    if (c.fase_id === FASE.APROVACAO) {
      return b(FASE.AQUISICAO, '✔ Aprovado integral', 'data-decisao="integral"')
        + b(FASE.AQUISICAO, '◐ Aprovado parcial', 'data-decisao="parcial"', 'kb-botao-sec')
        + b(FASE.ORCAMENTO, '↩ Devolver ao Orçamento', '', 'kb-botao-sec');
    }
    return '';
  }

  function cardGrande(ctx, c, agora) {
    const motivo = motivoPiscar(c, agora);
    const veiculo = [c.marca, c.modelo].filter(Boolean).join(' ');
    const pdf = c.orcamento && c.orcamento.pdf_url && c.fase_id === FASE.APROVACAO
      ? `<a class="kb-g-pdf" href="${esc(c.orcamento.pdf_url)}" target="_blank" rel="noopener">📄 Ver orçamento (PDF)</a>` : '';
    const acoes = acoesDoCard(ctx, c);
    return `<article class="kb-g-card${motivo ? ' kb-piscar' : ''}" data-abrir-card="${c.id}" tabindex="0" role="button"
        aria-label="OS ${esc(c.os_numero)}${motivo ? ` — ${esc(motivo)}` : ''}">
      <div class="kb-g-l1">
        <span class="kb-g-os">${c.empresa === 'awdyna' ? '<span class="kb-selo-empresa">AWDYNA</span> ' : ''}OS ${esc(c.os_numero)}</span>
        ${c.placa ? `<span class="kb-placa">${esc(c.placa)}</span>` : ''}
        <span class="kb-g-tempo" title="Tempo nesta fase">${dhm(naFase(c, agora))}</span>
      </div>
      <div class="kb-g-l2">${esc(veiculo || 'Veículo sem modelo')}${c.ano ? ` · ${esc(c.ano)}` : ''} · ${esc(c.primeiro_nome || 'Cliente')}</div>
      ${motivo ? `<div class="kb-g-alerta">⚠ ${esc(motivo)}</div>` : ''}
      ${resumoPrazo(c, agora)}
      ${pecasHtml(c)}
      ${pdf}
      ${acoes ? `<div class="kb-g-acoes">${acoes}</div>` : ''}
    </article>`;
  }

  const chipsOS = (lista, agora, texto) => lista.map((c) =>
    `<button type="button" class="kb-chip-os" data-abrir-card="${c.id}">OS ${esc(c.os_numero)} <small>${texto(c, agora)}</small></button>`).join('');

  function painelSetor(cards, agora) {
    const n = (f) => cards.filter((c) => c.fase_id === f).length;
    const a = alertasSetor(cards, agora);
    const bloco = (titulo, lista, texto, cls) => (lista.length
      ? `<div class="kb-alerta-bloco ${cls}"><strong>${titulo} <span class="kb-n">${lista.length}</span></strong><div>${chipsOS(lista, agora, texto)}</div></div>` : '');
    const alertas = bloco('⏰ Prazo de peças vencido', a.vencidos, (c, t) => `vencido há ${dhm(t - Date.parse(c.pecas_prazo_em))}`, 'kb-alerta-forte')
      + bloco('⛔ Sem movimentação entre fases (+1 dia)', a.parados, (c, t) => `${dhm(naFase(c, t))} em ${c.fase_id === FASE.ORCAMENTO ? 'Orçamento' : 'Aquisição'}`, 'kb-alerta-forte')
      + bloco('💤 Sem evolução (nenhum registro há +24 h)', a.semEvolucao, (c, t) => `último registro há ${dhm(t - Date.parse(c.ultimo_evento_em || c.fase_desde))}`, 'kb-alerta-medio');
    return `<section class="kb-painel-ctrl" aria-label="Painel de controle do setor de peças">
      <div class="kb-ctrl-numeros">
        <div class="kb-ctrl-num"><span>${n(FASE.ORCAMENTO)}</span>Orçamento</div>
        <div class="kb-ctrl-num"><span>${n(FASE.AQUISICAO)}</span>Aquisição de Peças</div>
        <div class="kb-ctrl-num"><span>${n(FASE.AGUARDANDO_PECAS)}</span>Aguardando Peças</div>
      </div>
      ${alertas || '<p class="kb-ctrl-ok">✔ Nenhum alerta: nada vencido, parado ou sem evolução.</p>'}
    </section>`;
  }

  // ---------- aviso de aprovação atrasada (> 1 h) ----------
  const avisados = new Set();
  function atrasadosAprovacao(cards, agora) {
    return cards.filter((c) => c.fase_id === FASE.APROVACAO && naFase(c, agora) > HORA);
  }
  function avisoAprovacao(cards, agora) {
    const lista = atrasadosAprovacao(cards, agora);
    // notificação do aparelho (se a pessoa permitiu), uma vez por card
    if (typeof Notification !== 'undefined' && Notification.permission === 'granted') {
      for (const c of lista) {
        if (avisados.has(c.id)) continue;
        avisados.add(c.id);
        try { new Notification('Aprovação de orçamento atrasada', { body: `OS ${c.os_numero} há ${dhm(naFase(c, agora))} aguardando aprovação`, tag: `kb-aprov-${c.id}` }); } catch (_) { /* sem notificação */ }
      }
    }
    const pedir = typeof Notification !== 'undefined' && Notification.permission === 'default'
      ? '<button type="button" class="kb-botao kb-botao-sec" data-fluxo-notif>🔔 Avisar também no aparelho</button>' : '';
    if (!lista.length) return pedir ? `<div class="kb-aviso-aprov kb-aviso-aprov-ok">Nenhum card há mais de 1 h na aprovação. ${pedir}</div>` : '';
    return `<div class="kb-aviso-aprov" role="alert">🔴 <strong>${lista.length} card(s) há mais de 1 h aguardando aprovação</strong>
      <div>${chipsOS(lista, agora, (c, t) => dhm(naFase(c, t)))}</div>${pedir}</div>`;
  }

  // ---------- telas ----------
  const VISOES = {
    pecas: { titulo: 'Orçamento e peças', fases: [FASE.ORCAMENTO, FASE.AQUISICAO, FASE.AGUARDANDO_PECAS] },
    aprovacao: { titulo: 'Aprovação de orçamento', fases: [FASE.APROVACAO] },
  };

  function renderSetor(ctx, el, visao, cards) {
    const est = ctx.estado();
    const agora = Date.now();
    const v = VISOES[visao];
    const nome = (id) => (est.fases.find((f) => f.id === id) || {}).nome || '';
    const colunas = v.fases.map((f) => {
      const lista = cards.filter((c) => c.fase_id === f); // já vêm do mais antigo na fase para o mais novo
      return `<section class="kb-g-coluna" data-fase="${f}" aria-label="${esc(nome(f))}">
        <h2 class="kb-g-titulo">${esc(nome(f))} <span class="kb-n">${lista.length}</span></h2>
        <div class="kb-g-lista">${lista.length ? lista.map((c) => cardGrande(ctx, c, agora)).join('') : '<p class="kb-vazio">Nenhum card nesta fase.</p>'}</div>
      </section>`;
    }).join('');
    el.innerHTML = `${visao === 'pecas' ? painelSetor(cards, agora) : avisoAprovacao(cards, agora)}
      <div class="kb-g-colunas kb-g-${visao}">${colunas}</div>`;
  }

  // ---------- janelas obrigatórias da passagem de fase ----------
  let modal = null;
  function caixa() {
    if (modal) return modal;
    modal = document.createElement('div');
    modal.className = 'kb-modal';
    modal.hidden = true;
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    document.body.appendChild(modal);
    return modal;
  }

  async function enviarPdf(cardId, tipo, arquivo, operador) {
    const r = await fetch(`/api/kanban/cards/${cardId}/orcamento-pdf?tipo=${tipo}&operador=${encodeURIComponent(operador)}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/pdf' }, body: arquivo,
    });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(corpo.erro || `erro ${r.status}`);
    return corpo.midia_id;
  }

  const ehPdf = (f) => f && (/\.pdf$/i.test(f.name) || f.type === 'application/pdf');

  // Abre a janela da passagem origem → destino. Devolve os campos extras do "mover" ou null
  // (cancelou: o card fica onde está). Sem exigência, devolve {} sem abrir nada.
  async function coletar(ctx, card, destino, { operador, decisao: decisaoInicial } = {}) {
    const est = ctx.estado();
    const exige = ((est.fluxo.exigencias || {})[card.fase_id] || {})[destino] || [];
    if (!exige.length) return {};
    const nomeDestino = (est.fases.find((f) => f.id === destino) || {}).nome || '';
    const devolucao = exige.includes('observacao');
    let sugestoes = { checklist: [], ultima_solicitacao: [] };
    if (exige.includes('pecas')) {
      try { sugestoes = await ctx.api(`/api/kanban/cards/${card.id}/pecas-sugeridas`); } catch (_) { /* segue sem sugestões */ }
    }
    const pecas = devolucao ? sugestoes.ultima_solicitacao.map((p) => ({ descricao: p.descricao, origem: p.origem })) : [];

    const m = caixa();
    return new Promise((resolve) => {
      let decisao = decisaoInicial || null;
      const titulo = exige.includes('aprovacao') ? 'Aprovação do orçamento'
        : devolucao ? 'Devolver ao Orçamento'
          : exige.includes('pecas') ? 'Peças para o orçamento'
            : exige.includes('orcamento_pdf') ? 'Enviar orçamento para aprovação'
              : 'Prazo das peças';

      function listaPecasHtml() {
        return pecas.length
          ? pecas.map((p, i) => `<li><span>${esc(p.descricao)}${p.origem === 'checklist' ? ' <small>checklist</small>' : ''}</span>
              <button type="button" class="kb-x" data-tirar="${i}" aria-label="Tirar ${esc(p.descricao)}">✕</button></li>`).join('')
          : '<li class="kb-vazio">Nenhuma peça na lista ainda.</li>';
      }
      const doChecklistFaltando = () => sugestoes.checklist.filter((s) => !pecas.some((p) => p.descricao.toLowerCase() === s.descricao.toLowerCase()));

      function desenhar(erro = '') {
        const faltam = doChecklistFaltando();
        let corpo = '';
        if (exige.includes('aprovacao')) {
          corpo += `<fieldset class="kb-opcoes"><legend>Como o cliente aprovou?</legend>
            <label><input type="radio" name="dec" value="integral" ${decisao === 'integral' ? 'checked' : ''}> <strong>Aprovado integralmente</strong><small>mantém o orçamento como está</small></label>
            <label><input type="radio" name="dec" value="parcial" ${decisao === 'parcial' ? 'checked' : ''}> <strong>Aprovado parcialmente</strong><small>anexe a nova via do cliente em PDF</small></label>
          </fieldset>
          <label class="kb-campo" ${decisao === 'parcial' ? '' : 'hidden'} data-via>Nova via do cliente (PDF) <input type="file" accept="application/pdf,.pdf" data-arq="via"></label>`;
        }
        if (exige.includes('pecas')) {
          corpo += `<p class="kb-modal-dica">${devolucao ? 'As peças da solicitação anterior já estão na lista: ajuste se precisar.' : 'Informe as peças que o orçamento deve cotar. Obrigatório para todo card que entra em Orçamento.'}</p>
            <ul class="kb-lista-pecas">${listaPecasHtml()}</ul>
            ${faltam.length ? `<button type="button" class="kb-botao kb-botao-sec" data-trazer>⇣ Trazer do checklist (${faltam.length})</button>` : (sugestoes.checklist.length ? '' : '<p class="kb-modal-dica">Nenhuma peça marcada nos checklists deste card.</p>')}
            <div class="kb-add-peca"><input type="text" maxlength="300" placeholder="Peça (ex.: sensor de ângulo de direção)" data-nova aria-label="Nova peça">
              <button type="button" class="kb-botao" data-add>+ Adicionar</button></div>`;
        }
        if (exige.includes('orcamento_pdf')) {
          corpo += `<label class="kb-campo">Orçamento em PDF (obrigatório) <input type="file" accept="application/pdf,.pdf" data-arq="orc"></label>`;
        }
        if (exige.includes('prazo')) {
          corpo += `<label class="kb-campo">Prazo para as peças chegarem (dias) <input type="number" min="1" max="365" step="1" inputmode="numeric" data-prazo></label>
            <p class="kb-modal-dica">Passou do prazo, o card pisca em vermelho.</p>`;
        }
        if (exige.includes('aprovacao') || exige.includes('orcamento_pdf') || exige.includes('pecas')) {
          corpo += `<label class="kb-campo">${devolucao ? 'Motivo da devolução (obrigatório)' : 'Observações (opcional)'} <textarea rows="3" maxlength="2000" data-obs></textarea></label>`;
        }
        m.innerHTML = `<form class="kb-modal-caixa kb-modal-fluxo">
          <h2>${esc(titulo)}</h2>
          <p class="kb-modal-dica">OS ${esc(card.os_numero)}${card.placa ? ` · ${esc(card.placa)}` : ''} → <strong>${esc(nomeDestino)}</strong></p>
          ${corpo}
          ${erro ? `<p class="kb-erro-form" role="alert">${esc(erro)}</p>` : ''}
          <div class="kb-modal-acoes">
            <button type="button" class="kb-botao kb-botao-sec" data-cancelar>Cancelar</button>
            <button type="submit" class="kb-botao">Confirmar e mover</button>
          </div></form>`;
      }

      // guarda o que já foi digitado ao redesenhar a lista de peças
      const lerCampos = () => ({ obs: (m.querySelector('[data-obs]') || {}).value, prazo: (m.querySelector('[data-prazo]') || {}).value });
      const repor = ({ obs, prazo }) => {
        if (obs !== undefined && m.querySelector('[data-obs]')) m.querySelector('[data-obs]').value = obs;
        if (prazo !== undefined && m.querySelector('[data-prazo]')) m.querySelector('[data-prazo]').value = prazo;
      };
      const redesenhar = (erro) => { const v = lerCampos(); desenhar(erro); repor(v); };

      function fechar(valor) {
        m.hidden = true;
        m.innerHTML = '';
        m.onclick = null; m.onsubmit = null; m.onchange = null; m.onkeydown = null;
        resolve(valor);
      }

      function adicionar() {
        const inp = m.querySelector('[data-nova]');
        const d = inp.value.replace(/\s+/g, ' ').trim();
        if (!d) { inp.focus(); return; }
        pecas.push({ descricao: d, origem: 'manual' });
        redesenhar();
        m.querySelector('[data-nova]').focus();
      }

      m.onclick = (ev) => {
        const b = ev.target.closest('button');
        if (!b) return; // clique fora da caixa não fecha: não perde o que já foi preenchido
        if (b.hasAttribute('data-cancelar')) fechar(null);
        else if (b.hasAttribute('data-add')) adicionar();
        else if (b.hasAttribute('data-trazer')) { for (const s of doChecklistFaltando()) pecas.push({ descricao: s.descricao, origem: 'checklist' }); redesenhar(); }
        else if (b.dataset.tirar !== undefined) { pecas.splice(Number(b.dataset.tirar), 1); redesenhar(); }
      };
      m.onkeydown = (ev) => {
        if (ev.key === 'Escape') fechar(null);
        if (ev.key === 'Enter' && ev.target.matches('[data-nova]')) { ev.preventDefault(); adicionar(); }
      };
      m.onchange = (ev) => {
        if (ev.target.name === 'dec') { decisao = ev.target.value; const via = m.querySelector('[data-via]'); if (via) via.hidden = decisao !== 'parcial'; }
      };
      m.onsubmit = async (ev) => {
        ev.preventDefault();
        const btn = m.querySelector('button[type="submit"]');
        const obs = ((m.querySelector('[data-obs]') || {}).value || '').trim();
        const extras = {};
        try {
          if (exige.includes('aprovacao')) {
            if (!decisao) throw new Error('Escolha: aprovado integralmente ou parcialmente');
            extras.decisao = decisao;
            if (decisao === 'parcial') {
              const f = m.querySelector('[data-arq="via"]').files[0];
              if (!ehPdf(f)) throw new Error('Anexe a nova via do cliente em PDF');
              extras.via = f;
            }
          }
          if (exige.includes('pecas')) {
            const pendente = ((m.querySelector('[data-nova]') || {}).value || '').trim();
            if (pendente) pecas.push({ descricao: pendente.replace(/\s+/g, ' '), origem: 'manual' });
            if (!pecas.length) throw new Error('Informe ao menos uma peça para o orçamento');
            extras.pecas = pecas;
          }
          if (devolucao && !obs) throw new Error('Escreva o motivo da devolução');
          if (exige.includes('orcamento_pdf')) {
            const f = m.querySelector('[data-arq="orc"]').files[0];
            if (!ehPdf(f)) throw new Error('Anexe o orçamento em PDF');
            extras.orc = f;
          }
          if (exige.includes('prazo')) {
            const dias = Number((m.querySelector('[data-prazo]') || {}).value);
            if (!Number.isInteger(dias) || dias < 1 || dias > 365) throw new Error('Informe o prazo em dias (de 1 a 365)');
            extras.prazo_dias = dias;
          }
          if (obs) extras.observacao = obs;
          btn.disabled = true;
          btn.textContent = extras.orc || extras.via ? 'Enviando o PDF…' : 'Movendo…';
          const arquivo = extras.orc || extras.via;
          if (arquivo) {
            extras.pdf_midia_id = await enviarPdf(card.id, extras.orc ? 'orcamento' : 'via_cliente', arquivo, operador);
            delete extras.orc; delete extras.via;
          }
          fechar(extras);
        } catch (e) {
          btn.disabled = false;
          btn.textContent = 'Confirmar e mover';
          if (exige.includes('pecas')) redesenhar(e.message);
          else {
            const p = m.querySelector('.kb-erro-form') || Object.assign(document.createElement('p'), { className: 'kb-erro-form' });
            p.textContent = e.message;
            p.setAttribute('role', 'alert');
            m.querySelector('.kb-modal-acoes').before(p);
          }
        }
      };

      desenhar();
      m.hidden = false;
      const foco = m.querySelector('[data-prazo], [data-nova], input[name="dec"], [data-arq], textarea');
      if (foco) foco.focus();
    });
  }

  window.KanbanFluxo = { FASE, VISOES, dhm, motivoPiscar, alertasSetor, atrasadosAprovacao, renderSetor, coletar };
})();
