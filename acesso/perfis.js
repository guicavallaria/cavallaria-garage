// Perfis de acesso (pedido do Guilherme em 23/10/2026):
//   Recepção  — acesso total (agenda, pós-vendas, kanban com ações de gestor)
//   Compras   — tudo menos pós-vendas
//   Pátio     — tudo menos pós-vendas
//   Gerência  — acesso total + administração (usuários, mecânicos, modelos de checklist, auditoria)
//   Mecânicos — só o kanban (registros, checklists, mover cards)
//
// "gestor" = ações do kanban que o prompt reserva ao Gestor: arquivar/desarquivar, vincular
// relatórios Launch, link do PDF para o cliente e cancelar links.
// "backup" = exportar/importar a agenda inteira (Recepção e Gerência, as de acesso total).
// "admin"  = área de administração. A edição da lista de mecânicos foi pedida para a Gerência;
// usuários, modelos e auditoria ficam no mesmo lugar, só para ela.
const PERFIS = {
  gerencia: { nome: 'Gerência', agenda: true, posvendas: true, kanban: true, gestor: true, admin: true, backup: true },
  recepcao: { nome: 'Recepção', agenda: true, posvendas: true, kanban: true, gestor: true, admin: false, backup: true },
  compras: { nome: 'Compras', agenda: true, posvendas: false, kanban: true, gestor: true, admin: false, backup: false },
  patio: { nome: 'Pátio', agenda: true, posvendas: false, kanban: true, gestor: true, admin: false, backup: false },
  mecanico: { nome: 'Mecânico', agenda: false, posvendas: false, kanban: true, gestor: false, admin: false, backup: false },
};

function permissoes(usuario) {
  if (!usuario) return null;
  const p = PERFIS[usuario.perfil];
  if (!p) return { agenda: false, posvendas: false, kanban: false, gestor: false, admin: false, backup: false };
  return { agenda: p.agenda, posvendas: p.posvendas, kanban: p.kanban, gestor: p.gestor, admin: p.admin, backup: p.backup };
}

function pode(usuario, permissao) {
  const p = permissoes(usuario);
  return Boolean(p && p[permissao]);
}

// Área do app de cada caminho (o que não é pós-vendas nem kanban é a agenda/pátio).
function areaDoCaminho(caminho) {
  const c = String(caminho || '/');
  if (/^\/(api\/)?posvendas(\/|$)/.test(c)) return 'posvendas';
  if (/^\/(api\/)?kanban(\/|$)/.test(c)) return 'kanban';
  if (/^\/(api\/(acesso|eventos)|conta\.html|logout|favicon\.ico)(\/|$)/.test(c)) return 'qualquer';
  if (/^\/api\/admin\/(exportar|importar)$/.test(c)) return 'backup';
  return 'agenda';
}

// Página inicial de cada perfil.
function inicio(usuario) {
  return pode(usuario, 'agenda') ? '/' : '/kanban/';
}

module.exports = { PERFIS, permissoes, pode, areaDoCaminho, inicio };
