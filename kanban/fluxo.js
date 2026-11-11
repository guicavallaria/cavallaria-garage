// Quem move cards e o que cada passagem de fase exige (pedido do Guilherme em 11/11/2026).
//
// Papel no kanban (usuarios.kb_papel, ajustável na Administração):
//   total      — move qualquer card para qualquer fase (Guilherme, Lucas, Vanilton)
//   orcamento  — Cauã: Orçamento → Aprovação; Aquisição → Aguardando Peças ou Agendamento;
//                Aguardando Peças → Agendamento ou de volta para Aquisição
//   aprovacao  — Luan: Aprovação → Aquisição (aprovado integral/parcial) ou de volta para Orçamento
//   registro   — todos os demais: registram no card, não movem
// As exigências valem para todos, inclusive para quem move tudo:
//   entrar em Orçamento        → lista das peças a orçar (do checklist e/ou digitadas)
//   entrar em Aprovação        → PDF do orçamento
//   Aprovação → Aquisição      → aprovado integral, ou parcial com o PDF da nova via do cliente
//   Aprovação → Orçamento      → observação do motivo + peças (vêm as da solicitação anterior)
//   entrar em Aguardando Peças → prazo em dias para as peças chegarem
const FASE = {
  ENTRADA: 1, DIAGNOSTICO: 2, ORCAMENTO: 3, APROVACAO: 4, AQUISICAO: 5,
  AGENDAMENTO: 6, EXECUCAO: 7, TESTE: 8, PRONTO: 9, AGUARDANDO_PECAS: 10,
};
const FASES_SETOR_PECAS = [FASE.ORCAMENTO, FASE.AQUISICAO, FASE.AGUARDANDO_PECAS];

const PAPEIS = {
  total: 'Movimentação total',
  orcamento: 'Orçamento e peças',
  aprovacao: 'Aprovação de orçamento',
  registro: 'Só registros (não move)',
};

const SAIDAS = {
  orcamento: {
    [FASE.ORCAMENTO]: [FASE.APROVACAO],
    [FASE.AQUISICAO]: [FASE.AGUARDANDO_PECAS, FASE.AGENDAMENTO],
    [FASE.AGUARDANDO_PECAS]: [FASE.AGENDAMENTO, FASE.AQUISICAO],
  },
  aprovacao: {
    [FASE.APROVACAO]: [FASE.AQUISICAO, FASE.ORCAMENTO],
  },
};

// Papel de quem está logado, lido do banco a cada ação (mudou na Administração, vale na hora).
// Sem usuário na sessão (testes do router) ou no acesso inicial: total.
function papelDoUsuario(db, usuario) {
  if (!usuario || !usuario.id) return 'total';
  const u = db.prepare('SELECT kb_papel FROM usuarios WHERE id = ? AND ativo = 1').get(usuario.id);
  return u && PAPEIS[u.kb_papel] ? u.kb_papel : 'registro';
}

// Fases para onde o papel pode mandar um card que está em `origem` (null = qualquer uma).
function destinosPermitidos(papel, origem, todas) {
  if (papel === 'total') return todas.filter((f) => f !== origem);
  return ((SAIDAS[papel] || {})[origem] || []).slice();
}

function podeMover(papel, origem, destino, todas) {
  return destinosPermitidos(papel, origem, todas).includes(destino);
}

// O que a passagem origem → destino exige (lista; vazia = nada).
function exigencias(origem, destino) {
  if (origem === destino) return [];
  if (destino === FASE.ORCAMENTO) return origem === FASE.APROVACAO ? ['pecas', 'observacao'] : ['pecas'];
  if (destino === FASE.APROVACAO) return ['orcamento_pdf'];
  if (origem === FASE.APROVACAO && destino === FASE.AQUISICAO) return ['aprovacao'];
  if (destino === FASE.AGUARDANDO_PECAS) return ['prazo'];
  return [];
}

function mensagemSemPermissao(papel, origem) {
  if (papel === 'registro') return 'Seu usuário não move cards: só registra (texto, fotos, checklists)';
  if (papel === 'orcamento') {
    return FASES_SETOR_PECAS.includes(origem)
      ? 'Desta fase você só pode mandar o card para as fases seguintes do setor de peças'
      : 'Você só move cards de Orçamento, Aquisição de Peças e Aguardando Peças';
  }
  if (papel === 'aprovacao') return 'Você só move cards da Aprovação de Orçamento (para Aquisição de Peças ou de volta ao Orçamento)';
  return 'Movimento não permitido';
}

module.exports = {
  FASE, FASES_SETOR_PECAS, PAPEIS, papelDoUsuario, destinosPermitidos, podeMover, exigencias, mensagemSemPermissao,
};
