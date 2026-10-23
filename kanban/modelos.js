// Administração dos modelos de checklist (seção 6: "tela simples de administração para
// editar modelos no futuro"). Salvar nunca altera um modelo em uso: cria uma VERSÃO NOVA,
// que passa a ser a ativa. Checklists já feitos continuam apontando para a versão antiga.
// (Na Etapa 7 só o perfil Gestor acessa.)
const { ErroAcao, validarOperador } = require('./acoes');
const { carregarModelo } = require('./checklists');

const TIPOS_SECAO = ['itens', 'fotos_obrigatorias', 'avarias', 'pecas_defeituosas'];
const TIPOS_COMPONENTE = {
  estado: ['escala', 'obrigatorio', 'nao_tem', 'descricao_se_reparo'],
  sim_nao: ['obrigatorio', 'rotulos', 'nao_tem', 'texto_se_sim', 'gera_peca'],
  medida: ['rotulo', 'unidade', 'obrigatorio', 'inteiro', 'min', 'max'],
  foto: ['obrigatorio', 'rotulo'],
  texto: ['rotulo', 'obrigatorio'],
  opcoes: ['opcoes', 'obrigatorio'],
  multipla: ['opcoes'],
  avarias: ['regioes'],
};

function listar(db) {
  const linhas = db.prepare(`SELECT m.id, m.codigo, m.versao, m.nome, m.ativo, m.criado_em, m.criado_por,
      (SELECT COUNT(*) FROM kb_checklist_execucoes e WHERE e.modelo_id = m.id) AS usos
      FROM kb_checklist_modelos m ORDER BY m.codigo, m.versao DESC`).all();
  const porCodigo = new Map();
  for (const l of linhas) {
    if (!porCodigo.has(l.codigo)) porCodigo.set(l.codigo, { codigo: l.codigo, nome: l.nome, versoes: [] });
    const g = porCodigo.get(l.codigo);
    if (l.ativo) g.nome = l.nome;
    g.versoes.push({ id: l.id, versao: l.versao, ativo: Boolean(l.ativo), criado_em: l.criado_em, criado_por: l.criado_por, usos: l.usos });
  }
  return [...porCodigo.values()];
}

function validarComponente(c, onde) {
  if (!c || typeof c !== 'object' || Array.isArray(c)) throw new ErroAcao(400, `${onde}: componente inválido`);
  const permitidos = TIPOS_COMPONENTE[c.tipo];
  if (!permitidos) throw new ErroAcao(400, `${onde}: tipo de componente desconhecido "${c.tipo}" (use ${Object.keys(TIPOS_COMPONENTE).join(', ')})`);
  for (const k of Object.keys(c)) if (k !== 'tipo' && !permitidos.includes(k)) throw new ErroAcao(400, `${onde}: campo "${k}" não existe em "${c.tipo}"`);
  if (c.tipo === 'estado' && c.escala && !['troca', 'reparo'].includes(c.escala)) throw new ErroAcao(400, `${onde}: escala deve ser "troca" ou "reparo"`);
  if (c.tipo === 'medida' && !String(c.rotulo || '').trim()) throw new ErroAcao(400, `${onde}: medida precisa de rótulo`);
  if ((c.tipo === 'opcoes' || c.tipo === 'multipla') && !(Array.isArray(c.opcoes) && c.opcoes.length >= 2 && c.opcoes.every((o) => typeof o === 'string' && o.trim()))) {
    throw new ErroAcao(400, `${onde}: informe ao menos duas opções`);
  }
  if (c.tipo === 'avarias' && !(Array.isArray(c.regioes) && c.regioes.length)) throw new ErroAcao(400, `${onde}: informe as regiões`);
  if (c.rotulos && !(Array.isArray(c.rotulos) && c.rotulos.length === 2)) throw new ErroAcao(400, `${onde}: rótulos devem ser dois textos, ex.: ["Feito","Não feito"]`);
  return c;
}

function normalizarModelo(dados) {
  const nome = String(dados.nome || '').trim();
  if (!nome) throw new ErroAcao(400, 'Informe o nome do checklist');
  if (!Array.isArray(dados.secoes) || !dados.secoes.length) throw new ErroAcao(400, 'O checklist precisa de ao menos uma seção');
  const codigos = new Set();
  const secoes = dados.secoes.map((s, i) => {
    const titulo = String(s.titulo || '').trim();
    if (!titulo) throw new ErroAcao(400, `Seção ${i + 1}: informe o título`);
    const tipo = s.tipo || 'itens';
    if (!TIPOS_SECAO.includes(tipo)) throw new ErroAcao(400, `Seção "${titulo}": tipo inválido`);
    const itens = (Array.isArray(s.itens) ? s.itens : []).map((it, j) => {
      const texto = String(it.texto || '').trim();
      const onde = `Seção "${titulo}", item ${j + 1}`;
      if (!texto) throw new ErroAcao(400, `${onde}: informe a pergunta`);
      let comps = it.componentes;
      if (typeof comps === 'string') {
        try { comps = JSON.parse(comps); } catch (_) { throw new ErroAcao(400, `${onde}: componentes não estão em JSON válido`); }
      }
      if (!Array.isArray(comps) || !comps.length) throw new ErroAcao(400, `${onde}: informe ao menos um componente de resposta`);
      comps.forEach((c) => validarComponente(c, onde));
      let codigo = String(it.codigo || '').trim() || `${(dados.codigo || 'item').slice(0, 12)}_${i + 1}_${j + 1}`;
      if (!/^[a-z0-9_]{2,40}$/.test(codigo)) throw new ErroAcao(400, `${onde}: código inválido (use letras minúsculas, números e _)`);
      while (codigos.has(codigo)) codigo += '_b';
      codigos.add(codigo);
      return { codigo, texto, instrucao: String(it.instrucao || '').trim() || null, componentes: comps };
    });
    if (tipo !== 'pecas_defeituosas' && !itens.length) throw new ErroAcao(400, `Seção "${titulo}": adicione ao menos um item`);
    return { titulo, tipo, itens };
  });
  return { nome, secoes };
}

function salvarNovaVersao(db, codigo, dados, { agora = new Date().toISOString() } = {}) {
  const op = validarOperador(dados.operador);
  const atual = db.prepare('SELECT * FROM kb_checklist_modelos WHERE codigo = ? ORDER BY versao DESC LIMIT 1').get(String(codigo));
  if (!atual) throw new ErroAcao(404, 'Checklist desconhecido');
  const m = normalizarModelo({ ...dados, codigo });
  return db.transaction(() => {
    const versao = atual.versao + 1;
    db.prepare('UPDATE kb_checklist_modelos SET ativo = 0 WHERE codigo = ?').run(codigo);
    const id = db.prepare(`INSERT INTO kb_checklist_modelos (codigo, versao, nome, ativo, criado_em, criado_por) VALUES (?, ?, ?, 1, ?, ?)`)
      .run(codigo, versao, m.nome, agora, op).lastInsertRowid;
    const insS = db.prepare('INSERT INTO kb_checklist_secoes (modelo_id, ordem, titulo, pede_responsavel, tipo) VALUES (?, ?, ?, 0, ?)');
    const insI = db.prepare('INSERT INTO kb_checklist_itens (secao_id, ordem, codigo, texto, instrucao, componentes) VALUES (?, ?, ?, ?, ?, ?)');
    m.secoes.forEach((s, i) => {
      const sid = insS.run(id, i + 1, s.titulo, s.tipo).lastInsertRowid;
      s.itens.forEach((it, j) => insI.run(sid, j + 1, it.codigo, it.texto, it.instrucao, JSON.stringify(it.componentes)));
    });
    return carregarModelo(db, id);
  })();
}

// Volta a usar uma versão anterior (vira a ativa).
function ativarVersao(db, modeloId, { operador }) {
  validarOperador(operador);
  const m = db.prepare('SELECT * FROM kb_checklist_modelos WHERE id = ?').get(Number(modeloId));
  if (!m) throw new ErroAcao(404, 'Versão não encontrada');
  db.transaction(() => {
    db.prepare('UPDATE kb_checklist_modelos SET ativo = 0 WHERE codigo = ?').run(m.codigo);
    db.prepare('UPDATE kb_checklist_modelos SET ativo = 1 WHERE id = ?').run(m.id);
  })();
  return { ok: true };
}

module.exports = { listar, salvarNovaVersao, ativarVersao, normalizarModelo, TIPOS_COMPONENTE, TIPOS_SECAO };
