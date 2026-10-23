// Administração dos modelos de checklist: editar perguntas, instruções, componentes,
// ordem, seções; salvar cria uma versão nova (as antigas ficam para os checklists já feitos).
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const lerOperador = () => { try { return localStorage.getItem('kb.operador') || ''; } catch (_) { return ''; } };

  let lista = [];
  let tipos = {};
  let atual = null; // { codigo, nome, secoes:[{titulo,tipo,itens:[{codigo,texto,instrucao,componentes(texto)}]}] }

  async function api(caminho, opts = {}) {
    const init = { credentials: 'same-origin', ...opts };
    if (opts.json !== undefined) { init.method = init.method || 'POST'; init.headers = { 'Content-Type': 'application/json' }; init.body = JSON.stringify(opts.json); }
    const r = await fetch(caminho, init);
    if (r.status === 401) { location.href = '/login'; throw new Error('sessão expirada'); }
    const corpo = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(corpo.erro || `erro ${r.status}`);
    return corpo;
  }

  function avisar(t, erro) {
    const el = $('kbAviso');
    el.textContent = t;
    el.classList.toggle('kb-aviso-erro', Boolean(erro));
    el.hidden = false;
    setTimeout(() => { el.hidden = true; }, erro ? 7000 : 3500);
  }

  async function carregarLista(selecionar) {
    const r = await api('/api/kanban/admin/modelos');
    lista = r.modelos;
    tipos = r.tipos_componente;
    $('admModelo').innerHTML = lista.map((m) => `<option value="${esc(m.codigo)}">${esc(m.nome)}</option>`).join('');
    if (selecionar) $('admModelo').value = selecionar;
    $('admAjuda').innerHTML = `<p>Cada item tem uma lista JSON de componentes. Tipos e campos aceitos:</p><ul>${Object.entries(tipos).map(([t, campos]) =>
      `<li><code>${t}</code>: ${campos.map((c) => `<code>${c}</code>`).join(', ')}</li>`).join('')}</ul>
      <p>Exemplos: <code>[{"tipo":"estado","escala":"troca","obrigatorio":true}]</code> ·
      <code>[{"tipo":"estado","escala":"reparo","obrigatorio":true,"descricao_se_reparo":true}]</code> ·
      <code>[{"tipo":"medida","rotulo":"GAP","unidade":"mm","obrigatorio":true}]</code> ·
      <code>[{"tipo":"sim_nao","obrigatorio":true,"rotulos":["Feito","Não feito"],"nao_tem":true}]</code></p>`;
    await abrir($('admModelo').value);
  }

  async function abrir(codigo) {
    const g = lista.find((m) => m.codigo === codigo);
    const ativa = g.versoes.find((v) => v.ativo) || g.versoes[0];
    const m = await api(`/api/kanban/admin/modelos/${ativa.id}`);
    atual = {
      codigo, nome: m.nome,
      secoes: m.secoes.map((s) => ({ titulo: s.titulo, tipo: s.tipo, itens: s.itens.map((i) => ({ codigo: i.codigo, texto: i.texto, instrucao: i.instrucao || '', componentes: JSON.stringify(i.componentes) })) })),
    };
    $('admVersoes').innerHTML = `Versões: ${g.versoes.map((v) => `<span>v${v.versao}${v.ativo ? ' <strong>(em uso)</strong>' : ''} · ${v.usos} checklist(s) feitos${v.ativo ? '' : ` <button type="button" class="adm-mini" data-ativar="${v.id}">usar esta</button>`}</span>`).join(' — ')}`;
    render();
  }

  function render() {
    const tiposSecao = ['itens', 'fotos_obrigatorias', 'avarias', 'pecas_defeituosas'];
    let n = 0;
    $('admForm').innerHTML = `<label class="kb-campo">Nome do checklist<input id="admNome" value="${esc(atual.nome)}"></label>` +
      atual.secoes.map((s, si) => `<section class="adm-secao" data-s="${si}">
        <div class="adm-secao-topo">
          <input data-campo="titulo" value="${esc(s.titulo)}" aria-label="Título da seção">
          <select data-campo="tipo">${tiposSecao.map((t) => `<option ${t === s.tipo ? 'selected' : ''}>${t}</option>`).join('')}</select>
          <button type="button" class="adm-mini" data-acao="secao-subir">↑</button>
          <button type="button" class="adm-mini" data-acao="secao-descer">↓</button>
          <button type="button" class="adm-mini" data-acao="secao-remover">Remover seção</button>
        </div>
        ${s.itens.map((it, ii) => `<div class="adm-item" data-i="${ii}">
          <span class="n">${++n}.</span>
          <div class="adm-campos">
            <input data-campo="texto" value="${esc(it.texto)}" placeholder="Pergunta">
            <input data-campo="instrucao" value="${esc(it.instrucao)}" placeholder="Instrução (opcional)">
            <textarea class="json" data-campo="componentes" rows="2" spellcheck="false">${esc(it.componentes)}</textarea>
            <small class="kb-dica">código: ${esc(it.codigo || '(novo)')}</small>
          </div>
          <div class="adm-botoes">
            <button type="button" data-acao="subir">↑</button><button type="button" data-acao="descer">↓</button><button type="button" data-acao="remover">✕</button>
          </div>
        </div>`).join('')}
        <button type="button" class="adm-mini" data-acao="item-novo">+ Item</button>
      </section>`).join('') + '<button type="button" class="adm-mini" data-acao="secao-nova">+ Seção</button>';
  }

  // Lê o formulário de volta para `atual` antes de mexer na ordem ou salvar.
  function ler() {
    atual.nome = $('admNome').value;
    document.querySelectorAll('.adm-secao').forEach((el) => {
      const s = atual.secoes[Number(el.dataset.s)];
      s.titulo = el.querySelector('[data-campo="titulo"]').value;
      s.tipo = el.querySelector('[data-campo="tipo"]').value;
      el.querySelectorAll('.adm-item').forEach((ie) => {
        const it = s.itens[Number(ie.dataset.i)];
        for (const c of ['texto', 'instrucao', 'componentes']) it[c] = ie.querySelector(`[data-campo="${c}"]`).value;
      });
    });
  }

  const trocar = (arr, a, b) => { if (b < 0 || b >= arr.length) return; [arr[a], arr[b]] = [arr[b], arr[a]]; };

  $('admForm').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-acao]');
    if (!b) return;
    ler();
    const sEl = b.closest('.adm-secao');
    const si = sEl ? Number(sEl.dataset.s) : null;
    const iEl = b.closest('.adm-item');
    const ii = iEl ? Number(iEl.dataset.i) : null;
    const s = si !== null ? atual.secoes[si] : null;
    switch (b.dataset.acao) {
      case 'subir': trocar(s.itens, ii, ii - 1); break;
      case 'descer': trocar(s.itens, ii, ii + 1); break;
      case 'remover': s.itens.splice(ii, 1); break;
      case 'item-novo': s.itens.push({ codigo: '', texto: '', instrucao: '', componentes: '[{"tipo":"estado","escala":"troca","obrigatorio":true}]' }); break;
      case 'secao-subir': trocar(atual.secoes, si, si - 1); break;
      case 'secao-descer': trocar(atual.secoes, si, si + 1); break;
      case 'secao-remover': atual.secoes.splice(si, 1); break;
      case 'secao-nova': atual.secoes.push({ titulo: 'Nova seção', tipo: 'itens', itens: [] }); break;
      default: return;
    }
    render();
  });

  $('admVersoes').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-ativar]');
    if (!b) return;
    try {
      await api(`/api/kanban/admin/modelos/${b.dataset.ativar}/ativar`, { json: { operador: lerOperador() || 'Administração' } });
      avisar('Versão ativada');
      carregarLista(atual.codigo);
    } catch (e) { avisar(e.message, true); }
  });

  $('admModelo').addEventListener('change', (ev) => abrir(ev.target.value));

  $('admSalvar').addEventListener('click', async () => {
    ler();
    const operador = lerOperador();
    if (!operador) { avisar('Abra o kanban e informe quem está usando o aparelho antes de editar os modelos', true); return; }
    $('admSalvar').disabled = true;
    try {
      const m = await api(`/api/kanban/admin/modelos/${atual.codigo}/versoes`, { json: { nome: atual.nome, secoes: atual.secoes, operador } });
      avisar(`Salvo: versão ${m.versao} em uso`);
      await carregarLista(atual.codigo);
    } catch (e) {
      avisar(e.message, true);
    } finally {
      $('admSalvar').disabled = false;
    }
  });

  // ---------- mecânicos ----------
  async function carregarMecanicos() {
    const lista = await api('/api/kanban/admin/mecanicos');
    const ativos = lista.filter((m) => !m.removido_em);
    const removidos = lista.filter((m) => m.removido_em);
    $('admMecLista').innerHTML = ativos.map((m) => `<li><strong>${esc(m.nome)}</strong>
        <small>${m.agenda_nome ? `ligado à agenda: ${esc(m.agenda_nome)}` : 'sem vínculo com a agenda'}</small>
        <button type="button" class="adm-mini" data-remover="${m.id}" data-nome="${esc(m.nome)}">Remover</button></li>`).join('')
      || '<li><em>Nenhum mecânico na lista.</em></li>';
    $('admMecRemovidos').innerHTML = removidos.map((m) => `<li>${esc(m.nome)} — removido por ${esc(m.removido_por)}</li>`).join('') || '<li>Nenhum.</li>';
  }

  // Remover pede confirmação na própria linha (sem confirm() do navegador).
  $('admMecLista').addEventListener('click', async (ev) => {
    const b = ev.target.closest('[data-remover]');
    if (!b) return;
    if (!b.dataset.confirmar) {
      b.dataset.confirmar = '1';
      b.textContent = `Confirmar remoção de ${b.dataset.nome}?`;
      setTimeout(() => { if (b.isConnected) { delete b.dataset.confirmar; b.textContent = 'Remover'; } }, 5000);
      return;
    }
    const operador = lerOperador();
    if (!operador) { avisar('Abra o kanban e informe quem está usando o aparelho antes de editar a lista', true); return; }
    try {
      await api(`/api/kanban/admin/mecanicos/${b.dataset.remover}/remover`, { json: { operador } });
      avisar(`${b.dataset.nome} removido da lista`);
      carregarMecanicos();
    } catch (e) { avisar(e.message, true); }
  });

  $('admMecForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const nome = $('admMecNome').value.trim();
    if (!nome) { $('admMecNome').focus(); return; }
    const operador = lerOperador();
    if (!operador) { avisar('Abra o kanban e informe quem está usando o aparelho antes de editar a lista', true); return; }
    try {
      const m = await api('/api/kanban/admin/mecanicos', { json: { nome, operador } });
      $('admMecNome').value = '';
      avisar(`${m.nome} adicionado${m.agenda_nome ? ` (ligado à agenda: ${m.agenda_nome})` : ''}`);
      carregarMecanicos();
    } catch (e) { avisar(e.message, true); }
  });

  carregarMecanicos().catch((e) => { $('admMecLista').innerHTML = `<li class="kb-erro-inline">${esc(e.message)}</li>`; });
  carregarLista().catch((e) => { $('admForm').innerHTML = `<p class="kb-erro-inline">${esc(e.message)}</p>`; });
})();
