// Usuários do app (senha só como hash bcrypt).
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { PERFIS } = require('./perfis');

class ErroUsuario extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}

const agoraUtc = () => new Date().toISOString();
const CUSTO = 10;
// hash de verdade para comparar quando o login não existe (mesmo tempo de resposta)
const HASH_FALSO = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), CUSTO);

// Contas combinadas com o Guilherme (23/10/2026). Senhas iniciais aleatórias, trocadas no 1º acesso.
const CONTAS_COMBINADAS = [
  { login: 'recepcao', nome: 'Recepção', perfil: 'recepcao' },
  { login: 'compras', nome: 'Compras', perfil: 'compras' },
  { login: 'patio', nome: 'Pátio', perfil: 'patio' },
  { login: 'gerencia', nome: 'Gerência', perfil: 'gerencia' },
  { login: 'edson', nome: 'Edson', perfil: 'mecanico' },
  { login: 'iago', nome: 'Iago', perfil: 'mecanico' },
  { login: 'ronaldy', nome: 'Ronaldy', perfil: 'mecanico' },
  { login: 'matheus', nome: 'Matheus', perfil: 'mecanico' },
  { login: 'luiz', nome: 'Luiz', perfil: 'mecanico' },
];

// Senha inicial fácil de ditar: 3 grupos de letras/números sem caracteres ambíguos (0/O, 1/l).
function gerarSenha() {
  const alfabeto = 'abcdefghjkmnpqrstuvwxyz23456789';
  const grupo = () => Array.from(crypto.randomBytes(4), (b) => alfabeto[b % alfabeto.length]).join('');
  return `${grupo()}-${grupo()}-${grupo()}`;
}

function validarSenha(senha, login) {
  const s = String(senha || '');
  if (s.length < 8) throw new ErroUsuario(400, 'A senha precisa ter pelo menos 8 caracteres');
  if (s.length > 200) throw new ErroUsuario(400, 'Senha longa demais');
  if (login && s.toLowerCase().includes(String(login).toLowerCase())) throw new ErroUsuario(400, 'A senha não pode conter o nome de usuário');
  return s;
}

const publico = (u) => u && ({
  id: u.id, login: u.login, nome: u.nome, perfil: u.perfil, perfil_nome: (PERFIS[u.perfil] || {}).nome || u.perfil,
  trocar_senha: Boolean(u.trocar_senha), kb_mecanico_id: u.kb_mecanico_id, ativo: Boolean(u.ativo),
  criado_em: u.criado_em, criado_por: u.criado_por, ultimo_login_em: u.ultimo_login_em,
});

function listar(db) {
  return db.prepare('SELECT * FROM usuarios ORDER BY ativo DESC, perfil, nome').all().map(publico);
}

const algumAtivo = (db) => Boolean(db.prepare('SELECT 1 FROM usuarios WHERE ativo = 1 LIMIT 1').get());

// Login de mecânico liga ao mecânico do kanban de mesmo nome (para o operador sair certo).
function mecanicoDoNome(db, nome) {
  const m = db.prepare('SELECT id FROM kb_mecanicos WHERE lower(nome) = lower(?) AND removido_em IS NULL').get(String(nome || '').trim());
  return m ? m.id : null;
}

function criar(db, { login, nome, perfil, senha = null }, { por, agora = agoraUtc() } = {}) {
  const l = String(login || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,30}$/.test(l)) throw new ErroUsuario(400, 'Usuário: 3 a 30 letras minúsculas, números, ponto, hífen ou _');
  const n = String(nome || '').replace(/\s+/g, ' ').trim();
  if (n.length < 2 || n.length > 60) throw new ErroUsuario(400, 'Informe o nome (2 a 60 caracteres)');
  if (!PERFIS[perfil]) throw new ErroUsuario(400, 'Perfil inválido');
  if (db.prepare('SELECT 1 FROM usuarios WHERE lower(login) = ?').get(l)) throw new ErroUsuario(409, `O usuário "${l}" já existe`);
  const inicial = senha ? validarSenha(senha, l) : gerarSenha();
  const id = db.prepare(`INSERT INTO usuarios (login, nome, perfil, senha_hash, trocar_senha, kb_mecanico_id, criado_em, criado_por)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)`).run(l, n, perfil, bcrypt.hashSync(inicial, CUSTO), perfil === 'mecanico' ? mecanicoDoNome(db, n) : null, agora, por || 'sistema').lastInsertRowid;
  return { usuario: publico(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(id)), senha_inicial: inicial };
}

// Cria as contas combinadas que ainda não existem. Devolve as senhas iniciais (mostradas uma vez).
function criarContasCombinadas(db, { por }) {
  const criadas = [];
  for (const c of CONTAS_COMBINADAS) {
    if (db.prepare('SELECT 1 FROM usuarios WHERE lower(login) = ?').get(c.login)) continue;
    criadas.push(criar(db, c, { por }));
  }
  return criadas;
}

function autenticar(db, login, senha, { agora = agoraUtc() } = {}) {
  const u = db.prepare('SELECT * FROM usuarios WHERE lower(login) = lower(?) AND ativo = 1').get(String(login || '').trim());
  // compara mesmo sem usuário, para o tempo de resposta não revelar quais logins existem
  const ok = bcrypt.compareSync(String(senha || ''), u ? u.senha_hash : HASH_FALSO);
  if (!u || !ok) return null;
  db.prepare('UPDATE usuarios SET ultimo_login_em = ? WHERE id = ?').run(agora, u.id);
  return publico(u);
}

function trocarSenha(db, id, { atual, nova }, { agora = agoraUtc() } = {}) {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ? AND ativo = 1').get(Number(id));
  if (!u) throw new ErroUsuario(404, 'Usuário não encontrado');
  if (!bcrypt.compareSync(String(atual || ''), u.senha_hash)) throw new ErroUsuario(400, 'Senha atual incorreta');
  const s = validarSenha(nova, u.login);
  if (bcrypt.compareSync(s, u.senha_hash)) throw new ErroUsuario(400, 'A nova senha precisa ser diferente da atual');
  db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 0, atualizado_em = ? WHERE id = ?').run(bcrypt.hashSync(s, CUSTO), agora, u.id);
  return publico(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.id));
}

// Gerência gera uma senha provisória (o usuário troca no próximo acesso).
function resetarSenha(db, id, { agora = agoraUtc() } = {}) {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(id));
  if (!u) throw new ErroUsuario(404, 'Usuário não encontrado');
  const nova = gerarSenha();
  db.prepare('UPDATE usuarios SET senha_hash = ?, trocar_senha = 1, atualizado_em = ? WHERE id = ?').run(bcrypt.hashSync(nova, CUSTO), agora, u.id);
  return { usuario: publico(u), senha_provisoria: nova };
}

function definirAtivo(db, id, ativo, { porId = null, agora = agoraUtc() } = {}) {
  const u = db.prepare('SELECT * FROM usuarios WHERE id = ?').get(Number(id));
  if (!u) throw new ErroUsuario(404, 'Usuário não encontrado');
  if (!ativo && porId === u.id) throw new ErroUsuario(400, 'Você não pode desativar o seu próprio usuário');
  if (!ativo && u.perfil === 'gerencia'
    && db.prepare("SELECT COUNT(*) AS n FROM usuarios WHERE perfil = 'gerencia' AND ativo = 1").get().n <= 1) {
    throw new ErroUsuario(400, 'Precisa existir ao menos um usuário da Gerência ativo');
  }
  db.prepare('UPDATE usuarios SET ativo = ?, atualizado_em = ? WHERE id = ?').run(ativo ? 1 : 0, agora, u.id);
  // derruba as sessões de quem foi desativado
  if (!ativo) db.prepare("DELETE FROM sessoes WHERE json_extract(dados, '$.usuario.id') = ?").run(u.id);
  return publico(db.prepare('SELECT * FROM usuarios WHERE id = ?').get(u.id));
}

module.exports = {
  ErroUsuario, CONTAS_COMBINADAS, gerarSenha, validarSenha, listar, algumAtivo, criar, criarContasCombinadas, autenticar,
  trocarSenha, resetarSenha, definirAtivo, publico,
};
