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
  // No setor de compras (tela do Cauã e grupo do quadro geral) a fase 5 se chama "Separação/Aquisição de peças".
  const NOME_NO_SETOR = { [FASE.AQUISICAO]: 'Separação/Aquisição de peças' };
  const nomeNoSetor = (id, nome) => NOME_NO_SETOR[id] || nome;

  // Botão "Abrir orçamento aprovado pelo cliente" (cards que já passaram pela aprovação).
  const botaoAprovado = (c, cls = 'kb-g-pdf') => (c.orcamento && c.orcamento.aprovado_url
    ? `<a class="${cls} kb-aprovado" href="${esc(c.orcamento.aprovado_url)}" target="_blank" rel="noopener">✅ Abrir orçamento aprovado pelo cliente</a>` : '');

  // Orçamento com opções para o cliente (Orçamento 1, 2…): aviso e um link por opção; a aprovada ganha ✅.
  function opcoesHtml(o, cls = 'kb-opc-aviso') {
    const lista = (o && o.opcoes) || [];
    if (lista.length < 2) return '';
    const escolhida = lista.find((x) => x.aprovada);
    const titulo = !o.decisao ? `⚠ Orçamento com opções de escolha pelo cliente (${lista.length})`
      : escolhida ? `Opções apresentadas ao cliente (${lista.length}): escolhido o Orçamento ${escolhida.numero}`
        : `Opções apresentadas ao cliente (${lista.length})`;
    return `<div class="${cls}${o.decisao ? ' kb-opc-decidido' : ''}"><strong>${titulo}</strong>
      <span class="kb-opc-links">${lista.map((x) => `<a href="${esc(x.url)}" target="_blank" rel="noopener"${x.aprovada ? ' class="kb-aprovado"' : ''}>${x.aprovada ? '✅' : '📄'} Orçamento ${x.numero}${x.aprovada ? ' (aprovado)' : ''}</a>`).join('')}</span></div>`;
  }
  const temOpcoes = (c) => Boolean(c.orcamento && !c.orcamento.decisao && (c.orcamento.opcoes || []).length > 1);

  // Quilometragem: 96361 → "96.361 km"; vazio ou 0 = não informada (null).
  function kmTexto(km) {
    const n = Number(String(km ?? '').replace(/D/g, ''));
    return Number.isFinite(n) && n > 0 ? `${n.toLocaleString('pt-BR')} km` : null;
  }

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
    if (c.fase_id === FASE.AGUARDANDO_PECAS) return b(FASE.AGENDAMENTO, '✔ Peças chegaram → Agendamento') + b(FASE.AQUISICAO, '↩ Separação/Aquisição', '', 'kb-botao-sec');
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
    const pdf = c.fase_id !== FASE.APROVACAO || !c.orcamento ? ''
      : temOpcoes(c) ? opcoesHtml(c.orcamento)
        : c.orcamento.pdf_url ? `<a class="kb-g-pdf" href="${esc(c.orcamento.pdf_url)}" target="_blank" rel="noopener">📄 Ver orçamento (PDF)</a>` : '';
    const acoes = acoesDoCard(ctx, c);
    const separar = podeSeparar(ctx) && ([FASE.AQUISICAO, FASE.AGUARDANDO_PECAS].includes(c.fase_id) || (c.pecas || []).length) && c.fase_id !== FASE.APROVACAO
      ? `<button type="button" class="kb-botao${contarPecas(c).a_definir || !(c.pecas || []).length ? '' : ' kb-botao-sec'}" data-fluxo-separar="${c.id}">📦 Separar peças</button>` : '';
    return `<article class="kb-g-card${motivo && !c.urgente_em ? ' kb-piscar' : ''}${c.urgente_em ? ' kb-urgente' : ''}" data-abrir-card="${c.id}" tabindex="0" role="button"
        aria-label="${c.urgente_em ? 'Serviço urgente, ' : ''}OS ${esc(c.os_numero)}${motivo ? ` — ${esc(motivo)}` : ''}">
      <div class="kb-g-l1">
        <span class="kb-g-os">${c.empresa === 'awdyna' ? '<span class="kb-selo-empresa">AWDYNA</span> ' : ''}OS ${esc(c.os_numero)}</span>
        ${c.placa ? `<span class="kb-placa">${esc(c.placa)}</span>` : ''}
        <span class="kb-g-tempo" title="Tempo nesta fase">${dhm(naFase(c, agora))}</span>
      </div>
      ${c.urgente_em ? '<div class="kb-urgente-selo">🚨 SERVIÇO URGENTE</div>' : ''}
      <div class="kb-g-l2">${esc(veiculo || 'Veículo sem modelo')}${c.ano ? ` · ${esc(c.ano)}` : ''}${kmTexto(c.km) ? ` · <span title="Quilometragem registrada no check-in de entrada">${kmTexto(c.km)}</span>` : ''} · ${esc(c.primeiro_nome || 'Cliente')}</div>
      ${motivo ? `<div class="kb-g-alerta">⚠ ${esc(motivo)}</div>` : ''}
      ${resumoPrazo(c, agora)}
      ${(c.pecas || []).length ? chipsPecas(c) + listaSeparacaoHtml(c, 6) : pecasHtml(c)}
      ${pdf}
      ${botaoAprovado(c)}
      ${acoes || separar ? `<div class="kb-g-acoes">${separar}${acoes}</div>` : ''}
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
      + bloco('⛔ Sem movimentação entre fases (+1 dia)', a.parados, (c, t) => `${dhm(naFase(c, t))} em ${c.fase_id === FASE.ORCAMENTO ? 'Orçamento' : 'Separação/Aquisição'}`, 'kb-alerta-forte')
      + bloco('💤 Sem evolução (nenhum registro há +24 h)', a.semEvolucao, (c, t) => `último registro há ${dhm(t - Date.parse(c.ultimo_evento_em || c.fase_desde))}`, 'kb-alerta-medio');
    return `<section class="kb-painel-ctrl" aria-label="Painel de controle do setor de peças">
      <div class="kb-ctrl-numeros">
        <div class="kb-ctrl-num"><span>${n(FASE.ORCAMENTO)}</span>Orçamento</div>
        <div class="kb-ctrl-num"><span>${n(FASE.AQUISICAO)}</span>Separação/Aquisição de peças</div>
        <div class="kb-ctrl-num"><span>${n(FASE.AGUARDANDO_PECAS)}</span>Aguardando Peças</div>
        <div class="kb-ctrl-num kb-ctrl-pedir"><span>${cards.reduce((s, c) => s + contarPecas(c).pedir, 0)}</span>Peças para pedir</div>
      </div>
      ${alertas || '<p class="kb-ctrl-ok">✔ Nenhum alerta: nada vencido, parado ou sem evolução.</p>'}
    </section>`;
  }

// ---------- separação das peças do orçamento aprovado (estoque / pedido) ----------
  const SIT = {
    a_definir: { rotulo: 'A separar', curto: 'a separar', icone: '🧩' },
    estoque: { rotulo: 'Tem em estoque', curto: 'em estoque', icone: '✔' },
    pedir: { rotulo: 'Para pedir', curto: 'p/ pedir', icone: '🛒' },
    pedido: { rotulo: 'Pedido feito', curto: 'a chegar', icone: '📦' },
    chegou: { rotulo: 'Peça chegou', curto: 'chegou', icone: '✅' },
    fora: { rotulo: 'Fora (não aprovada)', curto: 'fora', icone: '✕' },
  };
  const ORDEM_SIT = ['pedir', 'a_definir', 'pedido', 'chegou', 'estoque', 'fora'];
  const podeSeparar = (ctx) => ['total', 'orcamento'].includes(((ctx.estado() || {}).eu || {}).papel || 'total');
  const contarPecas = (c) => {
    const n = { a_definir: 0, estoque: 0, pedir: 0, pedido: 0, chegou: 0, fora: 0 };
    for (const p of c.pecas || []) if (n[p.situacao] !== undefined) n[p.situacao]++;
    return n;
  };
  // "3 p/ pedir · 2 em estoque · 1 a separar"
  function chipsPecas(c) {
    const n = contarPecas(c);
    const ch = ORDEM_SIT.filter((s) => n[s] && s !== 'fora')
      .map((s) => `<span class="kb-pc kb-pc-${s}">${SIT[s].icone} ${n[s]} ${SIT[s].curto}</span>`).join('');
    return ch ? `<div class="kb-pc-chips">${ch}</div>` : '';
  }
  // Lista da separação (card grande e painel do card): cada peça com a sua situação.
  function listaSeparacaoHtml(c, max = 99) {
    const p = (c.pecas || []).slice().sort((a, b) => ORDEM_SIT.indexOf(a.situacao) - ORDEM_SIT.indexOf(b.situacao));
    if (!p.length) return '';
    const mais = p.length > max ? `<li class="kb-g-mais">+ ${p.length - max} peça(s)</li>` : '';
    return `<ul class="kb-sep-lista">${p.slice(0, max).map((x) => `<li class="kb-sep-${x.situacao}"><span>${esc(x.descricao)}</span>
      <span class="kb-pc kb-pc-${x.situacao}">${SIT[x.situacao].icone} ${SIT[x.situacao].rotulo}</span></li>`).join('')}${mais}</ul>`;
  }
  // Seção "Peças" do painel do card
  function pecasPainelHtml(ctx, c) {
    const lista = c.pecas || [];
    const pode = podeSeparar(ctx);
    if (!lista.length && !(pode && [FASE.AQUISICAO, FASE.AGUARDANDO_PECAS].includes(c.fase_id))) return '';
    const n = contarPecas(c);
    return `<h3 class="kb-sec">Peças — estoque e pedido</h3>
      ${n.pedir ? `<p class="kb-sep-pendente">🛒 <strong>${n.pedir} peça(s) pendente(s) de pedido</strong></p>` : ''}
      ${n.pedido ? `<p class="kb-sep-chegada">📦 <strong>${n.pedido} peça(s) com pedido feito, aguardando chegada</strong> — o card só segue para o Agendamento quando todas chegarem</p>` : ''}
      ${n.a_definir ? `<p class="kb-sep-aviso">🧩 ${n.a_definir} peça(s) ainda a separar (estoque ou pedido)</p>` : ''}
      ${listaSeparacaoHtml(c) || '<p class="kb-vazio">Nenhuma peça lançada.</p>'}
      ${pode ? `<button type="button" class="kb-botao" data-fluxo-separar="${c.id}">📦 Separar peças (estoque / pedido)</button>` : ''}`;
  }

  // Painel do compras: todas as peças pendentes de pedido, por veículo.
  const haQuanto = (ms) => (ms < 60_000 ? 'agora' : `há ${dhm(ms)}`);
  const selecionadosPedido = new Set();
  function painelPedidos(ctx, cards, agora) {
    const comPedir = cards.filter((c) => (c.pecas || []).some((p) => p.situacao === 'pedir'));
    const aSeparar = cards.filter((c) => (c.pecas || []).some((p) => p.situacao === 'a_definir'));
    const total = comPedir.reduce((s, c) => s + contarPecas(c).pedir, 0);
    const pode = podeSeparar(ctx);
    const vivos = new Set(comPedir.flatMap((c) => c.pecas.filter((p) => p.situacao === 'pedir').map((p) => p.id)));
    for (const id of selecionadosPedido) if (!vivos.has(id)) selecionadosPedido.delete(id);
    const veiculo = (c) => [c.marca, c.modelo].filter(Boolean).join(' ') || 'Veículo';
    const separar = aSeparar.length ? `<div class="kb-alerta-bloco kb-alerta-medio"><strong>🧩 Orçamento aprovado com peças a separar <span class="kb-n">${aSeparar.length}</span></strong>
      <div>${aSeparar.map((c) => `<button type="button" class="kb-chip-os" ${pode ? `data-fluxo-separar="${c.id}"` : `data-abrir-card="${c.id}"`}>OS ${esc(c.os_numero)} <small>${contarPecas(c).a_definir} peça(s)</small></button>`).join('')}</div></div>` : '';
    const grupos = comPedir.map((c) => {
      const itens = c.pecas.filter((p) => p.situacao === 'pedir');
      return `<div class="kb-ped-grupo">
        <div class="kb-ped-veic"><button type="button" class="kb-ped-os" data-abrir-card="${c.id}">${c.empresa === 'awdyna' ? '<span class="kb-selo-empresa">AWDYNA</span> ' : ''}OS ${esc(c.os_numero)}</button>
          ${c.placa ? `<span class="kb-placa">${esc(c.placa)}</span>` : ''} <span>${esc(veiculo(c))}</span>
          <small class="kb-ped-fase">${esc(nomeNoSetor(c.fase_id, c.fase_nome || ''))}</small></div>
        <ul class="kb-ped-itens">${itens.map((p) => `<li><label>${pode ? `<input type="checkbox" data-pedido-id="${p.id}" ${selecionadosPedido.has(p.id) ? 'checked' : ''}>` : ''}
          <span>${esc(p.descricao)}</span><small>${haQuanto(agora - Date.parse(p.desde))}</small></label></li>`).join('')}</ul></div>`;
    }).join('');
    return `<section class="kb-pedidos" aria-label="Peças pendentes de pedido">
      <div class="kb-ped-topo"><h2>🛒 Peças pendentes de pedido <span class="kb-n">${total}</span></h2>
        ${pode && total ? `<button type="button" class="kb-botao" data-fluxo-pedidas ${selecionadosPedido.size ? '' : 'disabled'}>✔ Marcar ${selecionadosPedido.size || ''} selecionada(s) como pedida(s)</button>` : ''}</div>
      ${separar}
      ${grupos || '<p class="kb-ctrl-ok">✔ Nenhuma peça pendente de pedido.</p>'}
    </section>`;
  }

  // Painel do compras: peças com pedido feito que ainda não chegaram, por veículo. "Peça chegou" libera o card.
  const selecionadosChegou = new Set();
  function painelChegada(ctx, cards, agora) {
    const com = cards.filter((c) => (c.pecas || []).some((p) => p.situacao === 'pedido'));
    if (!com.length) { selecionadosChegou.clear(); return ''; }
    const total = com.reduce((s, c) => s + contarPecas(c).pedido, 0);
    const pode = podeSeparar(ctx);
    const vivos = new Set(com.flatMap((c) => c.pecas.filter((p) => p.situacao === 'pedido').map((p) => p.id)));
    for (const id of selecionadosChegou) if (!vivos.has(id)) selecionadosChegou.delete(id);
    const veiculo = (c) => [c.marca, c.modelo].filter(Boolean).join(' ') || 'Veículo';
    const grupos = com.map((c) => `<div class="kb-ped-grupo">
        <div class="kb-ped-veic"><button type="button" class="kb-ped-os" data-abrir-card="${c.id}">${c.empresa === 'awdyna' ? '<span class="kb-selo-empresa">AWDYNA</span> ' : ''}OS ${esc(c.os_numero)}</button>
          ${c.placa ? `<span class="kb-placa">${esc(c.placa)}</span>` : ''} <span>${esc(veiculo(c))}</span>
          <small class="kb-ped-fase">${esc(nomeNoSetor(c.fase_id, c.fase_nome || ''))}</small></div>
        <ul class="kb-ped-itens">${c.pecas.filter((p) => p.situacao === 'pedido').map((p) => `<li><label>${pode ? `<input type="checkbox" data-chegou-id="${p.id}" ${selecionadosChegou.has(p.id) ? 'checked' : ''}>` : ''}
          <span>${esc(p.descricao)}</span><small>pedida ${haQuanto(agora - Date.parse(p.desde))}</small></label></li>`).join('')}</ul></div>`).join('');
    return `<section class="kb-pedidos kb-chegada" aria-label="Peças aguardando chegada">
      <div class="kb-ped-topo"><h2>📦 Aguardando chegada <span class="kb-n">${total}</span></h2>
        ${pode ? `<button type="button" class="kb-botao" data-fluxo-chegaram ${selecionadosChegou.size ? '' : 'disabled'}>✅ Marcar ${selecionadosChegou.size || ''} selecionada(s): peça chegou</button>` : ''}</div>
      ${grupos}
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
    const nome = (id) => (visao === 'pecas' ? nomeNoSetor(id, '') : '') || (est.fases.find((f) => f.id === id) || {}).nome || '';
    const colunas = v.fases.map((f) => {
      const lista = cards.filter((c) => c.fase_id === f); // já vêm do mais antigo na fase para o mais novo
      return `<section class="kb-g-coluna" data-fase="${f}" aria-label="${esc(nome(f))}">
        <h2 class="kb-g-titulo">${esc(nome(f))} <span class="kb-n">${lista.length}</span></h2>
        <div class="kb-g-lista">${lista.length ? lista.map((c) => cardGrande(ctx, c, agora)).join('') : '<p class="kb-vazio">Nenhum card nesta fase.</p>'}</div>
      </section>`;
    }).join('');
    el.innerHTML = `${visao === 'pecas' ? painelSetor(cards, agora) + painelPedidos(ctx, cards, agora) + painelChegada(ctx, cards, agora) : avisoAprovacao(cards, agora)}
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

  async function enviarPdf(cardId, tipo, arquivo, operador, opcao = null) {
    const r = await fetch(`/api/kanban/cards/${cardId}/orcamento-pdf?tipo=${tipo}&operador=${encodeURIComponent(operador)}${opcao ? `&opcao=${opcao}` : ''}`, {
      method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/pdf' }, body: arquivo,
    });
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(corpo.erro || `erro ${r.status}`);
    return corpo.midia_id;
  }

  const ehPdf = (f) => f && (/\.pdf$/i.test(f.name) || f.type === 'application/pdf');
  const MAX_OPCOES = 5; // Orçamento 1 a 5 (o servidor confere o mesmo limite)
  const itemOrcHtml = (n) => `<div class="kb-orc-item" data-orc-item>
      <label class="kb-campo"><span data-orc-rotulo>Orçamento ${n} em PDF${n === 1 ? ' (obrigatório)' : ''}</span> <input type="file" accept="application/pdf,.pdf" data-arq="orc"></label>
      ${n > 1 ? '<button type="button" class="kb-x" data-orc-tirar aria-label="Tirar esta opção de orçamento">✕</button>' : ''}</div>`;

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
    // orçamento enviado com opções (Orçamento 1, 2…): na aprovação integral, qual o cliente escolheu
    const opcs = (card.orcamento && !card.orcamento.decisao && card.orcamento.opcoes) || [];
    return new Promise((resolve) => {
      let decisao = decisaoInicial || null;
      let opcao = null;
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
            <label><input type="radio" name="dec" value="parcial" ${decisao === 'parcial' ? 'checked' : ''}> <strong>Aprovado parcialmente</strong><small>anexe o orçamento aprovado pelo cliente em PDF</small></label>
          </fieldset>
          <label class="kb-campo" ${decisao === 'parcial' ? '' : 'hidden'} data-via>Orçamento aprovado pelo cliente (PDF) <input type="file" accept="application/pdf,.pdf" data-arq="via"></label>`;
          if (opcs.length > 1) {
            corpo = `<p class="kb-opc-aviso"><strong>⚠ Orçamento com opções de escolha pelo cliente (${opcs.length})</strong></p>` + corpo
              + `<fieldset class="kb-opcoes" data-opc ${decisao === 'integral' ? '' : 'hidden'}><legend>Qual orçamento o cliente aprovou?</legend>
                ${opcs.map((x) => `<label><input type="radio" name="opc" value="${x.numero}" ${opcao === x.numero ? 'checked' : ''}> <strong>Orçamento ${x.numero}</strong>
                  <small><a href="${esc(x.url)}" target="_blank" rel="noopener">abrir o PDF</a></small></label>`).join('')}
              </fieldset>`;
          }
        }
        if (exige.includes('pecas')) {
          corpo += `<p class="kb-modal-dica">${devolucao ? 'As peças da solicitação anterior já estão na lista: ajuste se precisar.' : 'Informe as peças que o orçamento deve cotar. Obrigatório para todo card que entra em Orçamento.'}</p>
            <ul class="kb-lista-pecas">${listaPecasHtml()}</ul>
            ${faltam.length ? `<button type="button" class="kb-botao kb-botao-sec" data-trazer>⇣ Trazer do checklist (${faltam.length})</button>` : (sugestoes.checklist.length ? '' : '<p class="kb-modal-dica">Nenhuma peça marcada nos checklists deste card.</p>')}
            <div class="kb-add-peca"><input type="text" maxlength="300" placeholder="Peça (ex.: sensor de ângulo de direção)" data-nova aria-label="Nova peça">
              <button type="button" class="kb-botao" data-add>+ Adicionar</button></div>`;
        }
        if (exige.includes('orcamento_pdf')) {
          corpo += `<div data-orc-lista>${itemOrcHtml(1)}</div>
            <button type="button" class="kb-botao kb-botao-sec" data-orc-mais>+ Adicionar Orçamento 2</button>
            <p class="kb-modal-dica">Mais de uma opção para o cliente (ex.: peça nova ou recondicionada)? Anexe cada orçamento separado: Orçamento 1, 2, 3…</p>`;
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

      // Orçamento 1, 2, 3…: renumera depois de incluir ou tirar uma opção (sem redesenhar: não perde os arquivos escolhidos)
      function numerarOrcs() {
        const itens = [...m.querySelectorAll('[data-orc-item]')];
        itens.forEach((it, i) => { it.querySelector('[data-orc-rotulo]').textContent = `Orçamento ${i + 1} em PDF${itens.length > 1 ? '' : ' (obrigatório)'}`; });
        const mais = m.querySelector('[data-orc-mais]');
        if (mais) { mais.textContent = `+ Adicionar Orçamento ${itens.length + 1}`; mais.hidden = itens.length >= MAX_OPCOES; }
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
        else if (b.hasAttribute('data-orc-mais')) {
          const lista = m.querySelector('[data-orc-lista]');
          if (lista.children.length >= MAX_OPCOES) return;
          lista.insertAdjacentHTML('beforeend', itemOrcHtml(lista.children.length + 1));
          numerarOrcs();
          lista.lastElementChild.querySelector('input').focus();
        } else if (b.hasAttribute('data-orc-tirar')) { b.closest('[data-orc-item]').remove(); numerarOrcs(); }
      };
      m.onkeydown = (ev) => {
        if (ev.key === 'Escape') fechar(null);
        if (ev.key === 'Enter' && ev.target.matches('[data-nova]')) { ev.preventDefault(); adicionar(); }
      };
      m.onchange = (ev) => {
        if (ev.target.name === 'dec') {
          decisao = ev.target.value;
          const via = m.querySelector('[data-via]'); if (via) via.hidden = decisao !== 'parcial';
          const opc = m.querySelector('[data-opc]'); if (opc) opc.hidden = decisao !== 'integral';
        }
        if (ev.target.name === 'opc') opcao = Number(ev.target.value);
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
              if (!ehPdf(f)) throw new Error('Anexe o orçamento aprovado pelo cliente em PDF');
              extras.via = f;
            }
            if (decisao === 'integral' && opcs.length > 1) {
              if (!opcao) throw new Error('Escolha qual orçamento o cliente aprovou');
              extras.opcao_aprovada = opcao;
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
            const arqs = [...m.querySelectorAll('[data-arq="orc"]')].map((i) => i.files[0]);
            arqs.forEach((f, i) => { if (!ehPdf(f)) throw new Error(arqs.length > 1 ? `Anexe o Orçamento ${i + 1} em PDF (ou tire essa opção)` : 'Anexe o orçamento em PDF'); });
            extras.orcs = arqs;
          }
          if (exige.includes('prazo')) {
            const dias = Number((m.querySelector('[data-prazo]') || {}).value);
            if (!Number.isInteger(dias) || dias < 1 || dias > 365) throw new Error('Informe o prazo em dias (de 1 a 365)');
            extras.prazo_dias = dias;
          }
          if (obs) extras.observacao = obs;
          btn.disabled = true;
          btn.textContent = extras.orcs && extras.orcs.length > 1 ? 'Enviando os PDFs…' : extras.orcs || extras.via ? 'Enviando o PDF…' : 'Movendo…';
          if (extras.orcs) {
            const ids = [];
            for (let i = 0; i < extras.orcs.length; i++) ids.push(await enviarPdf(card.id, 'orcamento', extras.orcs[i], operador, extras.orcs.length > 1 ? i + 1 : null));
            extras.pdf_midia_id = ids[0];
            if (ids.length > 1) extras.pdf_midia_ids = ids;
            delete extras.orcs;
          }
          if (extras.via) {
            extras.pdf_midia_id = await enviarPdf(card.id, 'via_cliente', extras.via, operador);
            delete extras.via;
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

// Janela "Separar peças": cada peça do orçamento aprovado vira estoque / para pedir / pedido / fora.
  // Devolve a resposta do servidor ou null (cancelou).
  async function separarPecas(ctx, card, { operador }) {
    const m = caixa();
    const itens = (card.pecas || []).map((p) => ({ id: p.id, descricao: p.descricao, situacao: p.situacao }));
    const opcoes = ['estoque', 'pedir', 'pedido', 'chegou', 'fora'];
    // peças do orçamento (última solicitação com peças) e dos checklists do card
    let sug = { checklist: [], ultima_solicitacao: [], pdf: [] };
    try { sug = await ctx.api(`/api/kanban/cards/${card.id}/pecas-sugeridas`); } catch (_) { /* segue sem sugestões */ }
    sug.pdf = sug.pdf || [];
    const tem = (d) => itens.some((i) => i.descricao.toLowerCase() === String(d).toLowerCase());
    const faltando = (lista) => lista.filter((p) => p.descricao && !tem(p.descricao));
    const trazer = (lista, origem) => { for (const p of faltando(lista)) itens.push({ id: null, descricao: p.descricao, situacao: 'a_definir', origem }); };
    // lista vazia: já traz as peças do PDF do orçamento (Onmotor) ou, sem PDF lido, as da solicitação
    const primeira = sug.pdf.length ? sug.pdf : sug.ultima_solicitacao;
    const trouxe = !itens.length && faltando(primeira).length > 0 ? (sug.pdf.length ? 'pdf' : 'orc') : '';
    if (!itens.length) trazer(primeira, 'orcamento');
    return new Promise((resolve) => {
      function fechar(valor) {
        m.hidden = true;
        m.innerHTML = '';
        m.onclick = null; m.onsubmit = null; m.onchange = null; m.onkeydown = null;
        resolve(valor);
      }
      function desenhar(erro = '') {
        const n = itens.filter((i) => i.situacao === 'a_definir').length;
        const fOrc = faltando(sug.ultima_solicitacao).length;
        const fPdf = faltando(sug.pdf).length;
        const fChk = faltando(sug.checklist).length;
        m.innerHTML = `<form class="kb-modal-caixa kb-modal-fluxo kb-modal-separar">
          <h2>Separar peças</h2>
          <p class="kb-modal-dica">OS ${esc(card.os_numero)}${card.placa ? ` · ${esc(card.placa)}` : ''} — marque o que tem em estoque e o que precisa pedir.
            As "para pedir" entram no painel de peças pendentes de pedido.</p>
          ${trouxe ? `<p class="kb-modal-dica">⇣ Peças trazidas ${trouxe === 'pdf' ? 'do PDF do orçamento' : 'do orçamento'}. Marque cada uma e grave.</p>` : ''}
          ${itens.length ? `<div class="kb-sep-todos">Marcar todas: ${opcoes.map((s) => `<button type="button" class="kb-botao kb-botao-sec" data-todas="${s}">${SIT[s].icone} ${SIT[s].rotulo}</button>`).join('')}</div>` : ''}
          <ul class="kb-sep-edit">${itens.length ? itens.map((it, i) => `<li>
            <div class="kb-sep-nome">${esc(it.descricao)}${it.id ? '' : ` <small>${{ orcamento: 'do orçamento', checklist: 'do checklist' }[it.origem] || 'incluída agora'}</small>`}
              ${it.id ? '' : `<button type="button" class="kb-x" data-tirar="${i}" aria-label="Tirar ${esc(it.descricao)}">✕</button>`}</div>
            <div class="kb-sep-opcoes" role="radiogroup" aria-label="Situação de ${esc(it.descricao)}">${opcoes.map((s) => `<label class="kb-sep-op kb-pc-${s}">
              <input type="radio" name="sit${i}" value="${s}" data-i="${i}" ${it.situacao === s ? 'checked' : ''}> ${SIT[s].icone} ${SIT[s].rotulo}</label>`).join('')}</div>
          </li>`).join('') : '<li class="kb-vazio">Nenhuma peça lançada no orçamento nem nos checklists deste card. Inclua abaixo.</li>'}</ul>
          ${fPdf || fOrc || fChk ? `<div class="kb-sep-todos">${fPdf ? `<button type="button" class="kb-botao" data-trazer="pdf">⇣ Trazer do PDF do orçamento (${fPdf})</button>` : ''}${fOrc ? `<button type="button" class="kb-botao kb-botao-sec" data-trazer="orc">⇣ Trazer do orçamento (${fOrc})</button>` : ''}${fChk ? `<button type="button" class="kb-botao kb-botao-sec" data-trazer="chk">⇣ Trazer do checklist (${fChk})</button>` : ''}</div>` : ''}
          <div class="kb-add-peca"><input type="text" maxlength="300" placeholder="Incluir peça que não estava no orçamento" data-nova aria-label="Nova peça">
            <button type="button" class="kb-botao" data-add>+ Incluir</button></div>
          ${n ? `<p class="kb-modal-dica">🧩 Falta separar ${n} peça(s). Dá para gravar assim e terminar depois.</p>` : ''}
          ${erro ? `<p class="kb-erro-form" role="alert">${esc(erro)}</p>` : ''}
          <div class="kb-modal-acoes">
            <button type="button" class="kb-botao kb-botao-sec" data-cancelar>Cancelar</button>
            <button type="submit" class="kb-botao">Gravar</button>
          </div></form>`;
      }
      const incluir = () => {
        const inp = m.querySelector('[data-nova]');
        const d = inp.value.replace(/\s+/g, ' ').trim();
        if (!d) { inp.focus(); return; }
        itens.push({ id: null, descricao: d, situacao: 'pedir' });
        desenhar();
        m.querySelector('[data-nova]').focus();
      };
      m.onchange = (ev) => {
        const r = ev.target.closest('input[type="radio"][data-i]');
        if (r) itens[Number(r.dataset.i)].situacao = r.value;
      };
      m.onclick = (ev) => {
        const b = ev.target.closest('button');
        if (!b) return;
        if (b.hasAttribute('data-cancelar')) fechar(null);
        else if (b.hasAttribute('data-add')) incluir();
        else if (b.dataset.todas) { for (const it of itens) it.situacao = b.dataset.todas; desenhar(); }
        else if (b.dataset.trazer) { if (b.dataset.trazer === 'pdf' || b.dataset.trazer === 'orc') trazer(b.dataset.trazer === 'pdf' ? sug.pdf : sug.ultima_solicitacao, 'orcamento'); else trazer(sug.checklist, 'checklist'); desenhar(); }
        else if (b.dataset.tirar !== undefined) { itens.splice(Number(b.dataset.tirar), 1); desenhar(); }
      };
      m.onkeydown = (ev) => {
        if (ev.key === 'Enter' && ev.target.matches('[data-nova]')) { ev.preventDefault(); incluir(); }
        if (ev.key === 'Escape') fechar(null);
      };
      m.onsubmit = async (ev) => {
        ev.preventDefault();
        const btn = m.querySelector('button[type="submit"]');
        btn.disabled = true;
        btn.textContent = 'Gravando…';
        try {
          const r = await ctx.api(`/api/kanban/cards/${card.id}/pecas`, { method: 'PUT', json: { operador, itens } });
          fechar(r);
        } catch (e) {
          desenhar(e.message);
        }
      };
      desenhar();
      m.hidden = false;
      const foco = m.querySelector('input[type="radio"]:checked, input[type="radio"], [data-nova]');
      if (foco) foco.focus();
    });
  }

  window.KanbanFluxo = { FASE, VISOES, kmTexto, nomeNoSetor, botaoAprovado, opcoesHtml, temOpcoes, enviarPdf, MAX_OPCOES, contarPecas, pecasPainelHtml, selecionadosPedido, selecionadosChegou, separarPecas, dhm, motivoPiscar, alertasSetor, atrasadosAprovacao, renderSetor, coletar };
})();
