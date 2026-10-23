const { test } = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const session = require('express-session');
const { bancoDeTeste } = require('./helpers/db');
const nov = require('./helpers/novidades');
const { aplicarLeitura } = require('../kanban/sync');
const { criarRouter } = require('../kanban/routes');
const perfis = require('../acesso/perfis');
const usuarios = require('../acesso/usuarios');
const auditoria = require('../acesso/auditoria');
const { StoreSqlite } = require('../acesso/sessoes');
const { criarLimite } = require('../acesso/limite');
const acesso = require('../acesso/rotas');

function bancoComCards() {
  const db = bancoDeTeste();
  db.transaction(() => aplicarLeitura(db, nov.linhas(), { agora: '2026-10-23T12:00:00.000Z', primeiraCarga: true }))();
  return db;
}

// App igual ao server.js na parte de acesso: sessão no SQLite, login, porteiro, conta, kanban
// e rotas de mentira para agenda e pós-vendas.
async function subirApp(db, { producao = false, env = { APP_PASSWORD: 'senha-antiga-123' } } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json());
  app.use(session({ name: 'cavallaria.sid', secret: 'x'.repeat(40), store: new StoreSqlite(db, { limparACadaMs: 0 }), resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax' } }));
  app.use(acesso.criarAcesso({ db, producao, env, publicDir: __dirname }).router);
  app.use(acesso.porteiro({ db }));
  app.use('/api/acesso', acesso.rotasConta({ db }));
  app.use('/api/kanban', criarRouter({ db, log: () => {}, criarCliente: () => null }));
  app.get('/', (req, res) => res.send('agenda'));
  app.get('/kanban/', (req, res) => res.send('kanban'));
  app.get('/api/agendamentos', (req, res) => res.json([]));
  app.get('/api/posvendas/semanas', (req, res) => res.json([]));
  app.get('/api/admin/exportar', (req, res) => res.json({ ok: true }));
  const srv = app.listen(0);
  await new Promise((r) => srv.once('listening', r));
  return { srv, base: `http://127.0.0.1:${srv.address().port}` };
}

// "Navegador" mínimo: guarda o cookie de sessão entre as chamadas.
function navegador(base) {
  let cookie = '';
  const ir = async (caminho, { json, method } = {}) => {
    const r = await fetch(base + caminho, {
      method: method || (json !== undefined ? 'POST' : 'GET'), redirect: 'manual',
      headers: { ...(cookie ? { Cookie: cookie } : {}), ...(json !== undefined ? { 'Content-Type': 'application/json' } : {}) },
      body: json !== undefined ? JSON.stringify(json) : undefined,
    });
    const sc = r.headers.get('set-cookie');
    if (sc) cookie = sc.split(';')[0];
    const texto = await r.text();
    let corpo = texto;
    try { corpo = JSON.parse(texto); } catch (_) { /* html/texto */ }
    return { status: r.status, corpo, local: r.headers.get('location') };
  };
  return { ir, entrar: (usuario, senha) => ir('/login', { json: { usuario, senha } }) };
}

// Cria o usuário e já troca a senha provisória (como no 1º acesso).
function usuarioPronto(db, login, nome, perfil, senha = 'senha-boa-123') {
  const { usuario, senha_inicial: inicial } = usuarios.criar(db, { login, nome, perfil }, { por: 'teste' });
  usuarios.trocarSenha(db, usuario.id, { atual: inicial, nova: senha });
  return usuario;
}

test('perfis: áreas e permissões combinadas com a oficina', () => {
  const p = (perfil) => perfis.permissoes({ perfil });
  assert.deepEqual(p('gerencia'), { agenda: true, posvendas: true, kanban: true, gestor: true, admin: true, backup: true });
  assert.deepEqual(p('recepcao'), { agenda: true, posvendas: true, kanban: true, gestor: true, admin: false, backup: true });
  for (const x of ['compras', 'patio']) assert.deepEqual(p(x), { agenda: true, posvendas: false, kanban: true, gestor: true, admin: false, backup: false });
  assert.deepEqual(p('mecanico'), { agenda: false, posvendas: false, kanban: true, gestor: false, admin: false, backup: false });
  assert.equal(perfis.areaDoCaminho('/posvendas/'), 'posvendas');
  assert.equal(perfis.areaDoCaminho('/api/posvendas/semanas'), 'posvendas');
  assert.equal(perfis.areaDoCaminho('/kanban/admin.html'), 'kanban');
  assert.equal(perfis.areaDoCaminho('/api/kanban/estado'), 'kanban');
  assert.equal(perfis.areaDoCaminho('/api/eventos'), 'qualquer');
  assert.equal(perfis.areaDoCaminho('/api/acesso/me'), 'qualquer');
  assert.equal(perfis.areaDoCaminho('/api/admin/importar'), 'backup');
  assert.equal(perfis.areaDoCaminho('/api/agendamentos'), 'agenda');
  assert.equal(perfis.areaDoCaminho('/'), 'agenda');
  assert.equal(perfis.inicio({ perfil: 'mecanico' }), '/kanban/');
  assert.equal(perfis.inicio({ perfil: 'patio' }), '/');
});

test('usuários: senha só em hash, provisória forte, troca obrigatória, login sem diferenciar maiúsculas', () => {
  const db = bancoDeTeste();
  const { usuario, senha_inicial: inicial } = usuarios.criar(db, { login: 'Recepcao', nome: 'Recepção', perfil: 'recepcao' }, { por: 'teste' });
  assert.equal(usuario.login, 'recepcao');
  assert.equal(usuario.trocar_senha, true);
  assert.match(inicial, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  const linha = db.prepare('SELECT senha_hash FROM usuarios WHERE id = ?').get(usuario.id);
  assert.match(linha.senha_hash, /^\$2[aby]\$10\$/);
  assert.ok(!linha.senha_hash.includes(inicial));
  assert.equal(usuarios.autenticar(db, 'RECEPCAO', inicial).id, usuario.id);
  assert.equal(usuarios.autenticar(db, 'recepcao', 'errada'), null);
  assert.equal(usuarios.autenticar(db, 'ninguem', inicial), null);
  assert.throws(() => usuarios.criar(db, { login: 'recepcao', nome: 'Outra', perfil: 'patio' }), /já existe/);
  assert.throws(() => usuarios.criar(db, { login: 'x', nome: 'X', perfil: 'patio' }), /3 a 30/);
  assert.throws(() => usuarios.criar(db, { login: 'chefe', nome: 'Chefe', perfil: 'dono' }), /Perfil inválido/);
  assert.throws(() => usuarios.trocarSenha(db, usuario.id, { atual: 'errada', nova: 'nova-senha-1' }), /Senha atual incorreta/);
  assert.throws(() => usuarios.trocarSenha(db, usuario.id, { atual: inicial, nova: 'curta' }), /8 caracteres/);
  assert.throws(() => usuarios.trocarSenha(db, usuario.id, { atual: inicial, nova: 'minharecepcao1' }), /nome de usuário/);
  const depois = usuarios.trocarSenha(db, usuario.id, { atual: inicial, nova: 'nova-senha-1' });
  assert.equal(depois.trocar_senha, false);
  assert.equal(usuarios.autenticar(db, 'recepcao', inicial), null);
  assert.ok(usuarios.autenticar(db, 'recepcao', 'nova-senha-1'));
  const { senha_provisoria: prov } = usuarios.resetarSenha(db, usuario.id);
  assert.equal(usuarios.autenticar(db, 'recepcao', 'nova-senha-1'), null);
  assert.equal(usuarios.autenticar(db, 'recepcao', prov).trocar_senha, true);
});

test('contas combinadas: cria só as que faltam; login de mecânico liga ao mecânico do kanban', () => {
  const db = bancoDeTeste();
  usuarios.criar(db, { login: 'gerencia', nome: 'Gerência', perfil: 'gerencia' }, { por: 'teste' });
  const criadas = usuarios.criarContasCombinadas(db, { por: 'gerencia' });
  assert.deepEqual(criadas.map((c) => c.usuario.login), ['recepcao', 'compras', 'patio', 'edson', 'iago', 'ronaldy', 'matheus', 'luiz']);
  assert.equal(new Set(criadas.map((c) => c.senha_inicial)).size, 8);
  assert.deepEqual(usuarios.criarContasCombinadas(db, { por: 'gerencia' }), []);
  const edson = db.prepare("SELECT kb_mecanico_id FROM usuarios WHERE login = 'edson'").get();
  assert.equal(edson.kb_mecanico_id, db.prepare("SELECT id FROM kb_mecanicos WHERE nome = 'Edson'").get().id);
});

test('desativar: nunca o próprio usuário nem a última Gerência; derruba as sessões', () => {
  const db = bancoDeTeste();
  const g = usuarioPronto(db, 'gerencia', 'Gerência', 'gerencia');
  const p = usuarioPronto(db, 'patio', 'Pátio', 'patio');
  assert.throws(() => usuarios.definirAtivo(db, g.id, false, { porId: g.id }), /próprio usuário/);
  assert.throws(() => usuarios.definirAtivo(db, g.id, false, { porId: p.id }), /ao menos um usuário da Gerência/);
  const store = new StoreSqlite(db, { limparACadaMs: 0 });
  store.set('sid-patio', { cookie: { maxAge: 60_000 }, usuario: { id: p.id, login: 'patio' } });
  store.set('sid-ger', { cookie: { maxAge: 60_000 }, usuario: { id: g.id, login: 'gerencia' } });
  usuarios.definirAtivo(db, p.id, false, { porId: g.id });
  assert.deepEqual(db.prepare('SELECT sid FROM sessoes').all().map((s) => s.sid), ['sid-ger']);
  assert.equal(usuarios.autenticar(db, 'patio', 'senha-boa-123'), null);
});

test('sessões no SQLite: grava, lê, expira e apaga', async () => {
  const db = bancoDeTeste();
  const store = new StoreSqlite(db, { limparACadaMs: 0 });
  const ler = (sid) => new Promise((res, rej) => store.get(sid, (e, s) => (e ? rej(e) : res(s))));
  store.set('a', { cookie: { expires: new Date(Date.now() + 60_000).toISOString() }, usuario: { id: 1 } });
  assert.deepEqual((await ler('a')).usuario, { id: 1 });
  store.set('b', { cookie: { expires: new Date(Date.now() - 1000).toISOString() } });
  assert.equal(await ler('b'), null);
  store.destroy('a');
  assert.equal(await ler('a'), null);
});

test('limite de tentativas: 5 erros em 15 min bloqueiam aquele IP + usuário; acerto zera', () => {
  let t = 0;
  const l = criarLimite({ agora: () => t });
  for (let i = 0; i < 5; i++) l.erro('1.1.1.1', 'edson');
  assert.equal(l.bloqueado('1.1.1.1', 'edson'), 15);
  assert.equal(l.bloqueado('1.1.1.1', 'iago'), 0);
  assert.equal(l.bloqueado('2.2.2.2', 'edson'), 0);
  t = 15 * 60_000;
  assert.equal(l.bloqueado('1.1.1.1', 'edson'), 0);
  l.erro('3.3.3.3', 'x'); l.acerto('3.3.3.3', 'x');
  assert.equal(l.bloqueado('3.3.3.3', 'x'), 0);
});

test('acesso inicial: senha antiga entra como Gerência só enquanto não há usuários; em produção exige APP_PASSWORD', async () => {
  const db = bancoComCards();
  const { srv, base } = await subirApp(db);
  try {
    const n = navegador(base);
    assert.equal((await n.ir('/api/kanban/estado')).status, 401);
    assert.equal((await n.ir('/')).local, '/login');
    assert.deepEqual((await n.ir('/api/acesso/inicial')).corpo, { acesso_inicial: true });
    assert.equal((await n.entrar('', 'errada')).status, 401);
    const r = await n.entrar('', 'senha-antiga-123');
    assert.equal(r.status, 200);
    assert.equal(r.corpo.destino, '/kanban/admin.html#usuarios');
    assert.equal((await n.ir('/api/acesso/me')).corpo.usuario.perfil, 'gerencia');
    const c = await n.ir('/api/acesso/usuarios', { json: { login: 'gerencia', nome: 'Gerência', perfil: 'gerencia' } });
    assert.equal(c.status, 200);
    assert.ok(c.corpo.senha_inicial);
    // a sessão inicial continua (para ver as senhas), mas a senha antiga não entra mais
    assert.equal((await n.ir('/api/acesso/usuarios')).status, 200);
    const outro = navegador(base);
    assert.equal((await outro.entrar('', 'senha-antiga-123')).status, 400);
    assert.equal((await outro.entrar('gerencia', 'senha-antiga-123')).status, 401);
  } finally { srv.close(); }

  const db2 = bancoDeTeste();
  const prod = await subirApp(db2, { producao: true, env: {} });
  try {
    const n = navegador(prod.base);
    assert.deepEqual((await n.ir('/api/acesso/inicial')).corpo, { acesso_inicial: false });
    assert.equal((await n.entrar('', 'cavallaria2026')).status, 401);
  } finally { prod.srv.close(); }
});

test('1º acesso: com senha provisória só dá para trocar a senha; depois libera a área do perfil', async () => {
  const db = bancoComCards();
  const { senha_inicial: inicial } = usuarios.criar(db, { login: 'compras', nome: 'Compras', perfil: 'compras' }, { por: 'teste' });
  const { srv, base } = await subirApp(db);
  try {
    const n = navegador(base);
    const r = await n.entrar('compras', inicial);
    assert.equal(r.corpo.destino, '/conta.html?primeiro=1');
    const bloqueado = await n.ir('/api/kanban/estado');
    assert.equal(bloqueado.status, 403);
    assert.equal(bloqueado.corpo.trocar_senha, true);
    assert.equal((await n.ir('/')).local, '/conta.html?primeiro=1');
    assert.equal((await n.ir('/api/acesso/usuarios')).status, 403);
    const t = await n.ir('/api/acesso/senha', { json: { atual: inicial, nova: 'compras-nova-1' } });
    assert.equal(t.status, 400); // contém o nome de usuário
    assert.equal((await n.ir('/api/acesso/senha', { json: { atual: inicial, nova: 'pecas-2026-ok' } })).corpo.destino, '/');
    assert.equal((await n.ir('/api/kanban/estado')).status, 200);
    assert.equal((await n.ir('/api/agendamentos')).status, 200);
    assert.equal((await n.ir('/api/posvendas/semanas')).status, 403); // Compras: tudo menos pós-vendas
    assert.equal((await n.ir('/api/admin/exportar')).status, 403);
  } finally { srv.close(); }
});

test('mecânico: só o kanban, assina com o próprio nome e não faz ações de gestor', async () => {
  const db = bancoComCards();
  usuarioPronto(db, 'edson', 'Edson', 'mecanico');
  const card = db.prepare('SELECT * FROM kb_cards ORDER BY id LIMIT 1').get();
  const { srv, base } = await subirApp(db);
  try {
    const n = navegador(base);
    assert.equal((await n.entrar('edson', 'senha-boa-123')).corpo.destino, '/kanban/');
    assert.equal((await n.ir('/')).local, '/kanban/');
    assert.equal((await n.ir('/api/agendamentos')).status, 403);
    assert.equal((await n.ir('/api/posvendas/semanas')).status, 403);
    assert.equal((await n.ir('/kanban/')).status, 200);
    // operador vem do login, não do que o aparelho mandou
    const t = await n.ir(`/api/kanban/cards/${card.id}/textos`, { json: { texto: 'Trocado o filtro', operador: 'Outra Pessoa' } });
    assert.equal(t.status, 200);
    assert.equal(db.prepare('SELECT operador_nome FROM kb_eventos WHERE id = ?').get(t.corpo.evento_id).operador_nome, 'Edson');
    const m = await n.ir(`/api/kanban/cards/${card.id}/mover`, { json: { fase_id: 3, fase_atual: card.fase_id, operador: 'X' } });
    assert.equal(m.status, 200);
    assert.equal((await n.ir(`/api/kanban/cards/${card.id}/arquivar`, { json: { operador: 'Edson' } })).status, 403);
    assert.equal((await n.ir(`/api/kanban/cards/${card.id}/links`)).status, 403);
    assert.equal((await n.ir('/api/kanban/admin/mecanicos')).status, 403);
    assert.equal((await n.ir('/api/kanban/admin/auditoria')).status, 403);
    // auditoria: login + ações com usuário, operador e card
    const log = auditoria.listar(db, {});
    const acoesDoCard = log.filter((a) => a.card_id === card.id && a.usuario_login === 'edson').map((a) => a.acao);
    assert.deepEqual(acoesDoCard.sort(), ['fase_alterada', 'texto_postado']);
    assert.ok(log.some((a) => a.acao === 'login' && a.usuario_login === 'edson'));
    assert.equal(log.find((a) => a.acao === 'texto_postado').operador, 'Edson');
    assert.ok(!JSON.stringify(log).includes('Trocado o filtro')); // nada do conteúdo vai para a auditoria
  } finally { srv.close(); }
});

test('gestor (Pátio) arquiva e vê links; só a Gerência entra na administração e na auditoria', async () => {
  const db = bancoComCards();
  usuarioPronto(db, 'patio', 'Pátio', 'patio');
  usuarioPronto(db, 'gerencia', 'Gerência', 'gerencia');
  const card = db.prepare('SELECT * FROM kb_cards ORDER BY id LIMIT 1').get();
  const { srv, base } = await subirApp(db);
  try {
    const p = navegador(base);
    await p.entrar('patio', 'senha-boa-123');
    assert.equal((await p.ir(`/api/kanban/cards/${card.id}/arquivar`, { json: { operador: 'Vanilton' } })).status, 200);
    assert.equal((await p.ir(`/api/kanban/cards/${card.id}/links`)).status, 200);
    assert.equal((await p.ir('/api/kanban/admin/modelos')).status, 403);
    assert.equal((await p.ir('/api/acesso/usuarios')).status, 403);
    const g = navegador(base);
    await g.entrar('gerencia', 'senha-boa-123');
    assert.equal((await g.ir('/api/kanban/admin/modelos')).status, 200);
    const aud = await g.ir(`/api/kanban/admin/auditoria?os=${card.os_numero}`);
    assert.equal(aud.status, 200);
    assert.ok(aud.corpo.some((a) => a.acao === 'card_arquivado' && a.usuario_login === 'patio' && a.operador === 'Vanilton'));
    assert.ok(aud.corpo.some((a) => a.acao === 'card_criado' && a.operador === 'Sistema'));
  } finally { srv.close(); }
});

test('login: erro não diz se o usuário existe; 5 erros bloqueiam; desativado sai na hora', async () => {
  const db = bancoComCards();
  usuarioPronto(db, 'gerencia', 'Gerência', 'gerencia');
  const iago = usuarioPronto(db, 'iago', 'Iago', 'mecanico');
  const { srv, base } = await subirApp(db);
  try {
    const n = navegador(base);
    const a = await n.entrar('iago', 'errada');
    const b = await n.entrar('nao-existe', 'errada');
    assert.deepEqual([a.status, b.status], [401, 401]);
    assert.equal(a.corpo.erro, b.corpo.erro);
    for (let i = 0; i < 4; i++) await n.entrar('iago', 'errada');
    const bloq = await n.entrar('iago', 'senha-boa-123');
    assert.equal(bloq.status, 429);
    assert.equal(auditoria.listar(db, { acao: 'login_falhou' }).length, 6);

    // o bloqueio é por IP + usuário: outra conta no mesmo IP entra normalmente
    assert.equal((await navegador(base).entrar('gerencia', 'senha-boa-123')).status, 200);
  } finally { srv.close(); }

  // limite novo (app reiniciado): entra, e sai na hora quando o usuário é desativado
  const novo = await subirApp(db);
  try {
    const i = navegador(novo.base);
    assert.equal((await i.entrar('iago', 'senha-boa-123')).status, 200);
    assert.equal((await i.ir('/api/kanban/estado')).status, 200);
    db.prepare('UPDATE usuarios SET ativo = 0 WHERE id = ?').run(iago.id); // mesmo sem apagar a sessão
    assert.equal((await i.ir('/api/kanban/estado')).status, 401);
    assert.equal((await i.ir('/api/kanban/estado')).status, 401);
  } finally { novo.srv.close(); }
});
