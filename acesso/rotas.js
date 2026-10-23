// Login individual (Etapa 7): sessão, login/logout, conta, usuários e o porteiro de cada área.
const express = require('express');
const path = require('path');
const perfis = require('./perfis');
const usuarios = require('./usuarios');
const auditoria = require('./auditoria');
const { criarLimite } = require('./limite');

// Dados do usuário guardados na sessão (nada além disso).
const naSessao = (u) => ({ id: u.id, login: u.login, nome: u.nome, perfil: u.perfil, trocar_senha: Boolean(u.trocar_senha), inicial: Boolean(u.inicial) });

// Acesso inicial: enquanto não existe nenhum usuário ativo, a senha antiga do app (APP_PASSWORD)
// entra como Gerência só para criar as contas. Em produção, sem APP_PASSWORD definida, não há
// acesso inicial (nada de senha padrão no ar).
function senhaInicial(env = process.env, producao = false) {
  if (env.APP_PASSWORD) return env.APP_PASSWORD;
  return producao ? null : 'cavallaria2026';
}

function responder(res, fn) {
  try {
    res.json(fn());
  } catch (e) {
    if (e instanceof usuarios.ErroUsuario) return res.status(e.status).json({ erro: e.message });
    console.log('acesso: erro: ' + e.message);
    res.status(500).json({ erro: 'Erro interno' });
  }
}

function criarAcesso({ db, producao = false, env = process.env, publicDir }) {
  const limite = criarLimite();
  const r = express.Router();

  r.get('/login', (req, res) => {
    if (req.session.usuario) return res.redirect(perfis.inicio(req.session.usuario));
    res.sendFile(path.join(publicDir, 'login.html'));
  });

  r.get('/api/acesso/inicial', (req, res) => {
    res.json({ acesso_inicial: !usuarios.algumAtivo(db) && Boolean(senhaInicial(env, producao)) });
  });

  r.post('/login', (req, res) => {
    const b = req.body || {};
    const login = String(b.usuario || '').trim().slice(0, 40);
    const senha = String(b.senha || '');
    const ip = req.ip;
    const espera = limite.bloqueado(ip, login);
    if (espera) return res.status(429).json({ erro: `Muitas tentativas. Tente de novo em ${espera} min.` });

    let u = null;
    if (!usuarios.algumAtivo(db)) {
      const inicial = senhaInicial(env, producao);
      if (inicial && senha === inicial) u = { id: 0, login: 'acesso-inicial', nome: 'Acesso inicial', perfil: 'gerencia', inicial: true };
    } else {
      if (!login) return res.status(400).json({ erro: 'Informe o usuário' });
      u = usuarios.autenticar(db, login, senha);
    }
    if (!u) {
      limite.erro(ip, login);
      auditoria.registrar(db, { usuario: { login: login || '(vazio)' }, acao: 'login_falhou', ip });
      return res.status(401).json({ erro: 'Usuário ou senha incorretos' });
    }
    limite.acerto(ip, login);
    // sessão nova a cada login (evita fixação de sessão)
    req.session.regenerate((err) => {
      if (err) return res.status(500).json({ erro: 'Erro ao iniciar a sessão' });
      req.session.usuario = naSessao(u);
      auditoria.registrar(db, { usuario: u, acao: 'login', ip });
      req.session.save(() => res.json({ ok: true, destino: u.trocar_senha ? '/conta.html?primeiro=1' : (u.inicial ? '/kanban/admin.html#usuarios' : perfis.inicio(u)) }));
    });
  });

  r.post('/logout', (req, res) => {
    const u = req.session.usuario;
    if (u) auditoria.registrar(db, { usuario: u, acao: 'logout', ip: req.ip });
    req.session.destroy(() => res.clearCookie('cavallaria.sid').json({ ok: true }));
  });

  return { router: r, limite };
}

// Porteiro: depois das rotas públicas. Confere login, perfil ainda ativo, troca de senha
// obrigatória e a área (agenda, pós-vendas, kanban) de cada caminho.
function porteiro({ db }) {
  const ler = db.prepare('SELECT id, login, nome, perfil, trocar_senha, ativo FROM usuarios WHERE id = ?');
  return (req, res, next) => {
    const api = req.path.startsWith('/api/');
    let u = req.session && req.session.usuario;
    if (u && u.id) {
      // relê do banco: usuário desativado sai na hora; perfil e troca de senha sempre atuais
      const atual = ler.get(u.id);
      if (!atual || !atual.ativo) {
        return req.session.destroy(() => (api ? res.status(401).json({ erro: 'Sessão encerrada' }) : res.redirect('/login')));
      }
      u = req.session.usuario = naSessao(atual);
    }
    // (a sessão do acesso inicial segue até sair/expirar, para mostrar as senhas criadas;
    // depois que existe usuário ativo, a senha antiga não entra mais)
    if (!u) return api ? res.status(401).json({ erro: 'Não autenticado' }) : res.redirect('/login');

    const area = perfis.areaDoCaminho(req.path);
    if (u.trocar_senha && area !== 'qualquer') {
      return api ? res.status(403).json({ erro: 'Troque a sua senha para continuar', trocar_senha: true }) : res.redirect('/conta.html?primeiro=1');
    }
    if (area !== 'qualquer' && !perfis.pode(u, area)) {
      return api ? res.status(403).json({ erro: 'Seu perfil não tem acesso a esta área' }) : res.redirect(perfis.inicio(u));
    }
    return next();
  };
}

// Rotas logadas: minha conta e administração de usuários (Gerência).
function rotasConta({ db }) {
  const r = express.Router();
  const eu = (req) => req.session.usuario;
  const exigirAdmin = (req) => {
    if (!perfis.pode(eu(req), 'admin')) throw new usuarios.ErroUsuario(403, 'Só a Gerência pode alterar isto');
  };
  const audit = (req, acao, detalhes, entidadeId = null) => auditoria.registrar(db, {
    usuario: eu(req), acao, entidade: 'usuarios', entidadeId, detalhes, ip: req.ip,
  });

  // com troca de senha pendente só dá para ver a conta e trocar a senha
  r.use((req, res, next) => (eu(req).trocar_senha && !['/me', '/senha'].includes(req.path)
    ? res.status(403).json({ erro: 'Troque a sua senha para continuar', trocar_senha: true }) : next()));

  r.get('/me', (req, res) => res.json({ usuario: eu(req), permissoes: perfis.permissoes(eu(req)) }));

  r.post('/senha', (req, res) => responder(res, () => {
    if (!eu(req).id) throw new usuarios.ErroUsuario(400, 'O acesso inicial não tem senha própria: crie os usuários');
    const u = usuarios.trocarSenha(db, eu(req).id, { atual: (req.body || {}).atual, nova: (req.body || {}).nova });
    req.session.usuario = naSessao(u);
    audit(req, 'senha_trocada', null, u.id);
    return { ok: true, destino: perfis.inicio(u) };
  }));

  r.get('/usuarios', (req, res) => responder(res, () => {
    exigirAdmin(req);
    return { usuarios: usuarios.listar(db), perfis: Object.entries(perfis.PERFIS).map(([id, p]) => ({ id, nome: p.nome })), combinadas: usuarios.CONTAS_COMBINADAS };
  }));

  r.post('/usuarios', (req, res) => responder(res, () => {
    exigirAdmin(req);
    const b = req.body || {};
    const out = usuarios.criar(db, { login: b.login, nome: b.nome, perfil: b.perfil }, { por: eu(req).login });
    audit(req, 'usuario_criado', { login: out.usuario.login, perfil: out.usuario.perfil }, out.usuario.id);
    return out;
  }));

  r.post('/usuarios/combinadas', (req, res) => responder(res, () => {
    exigirAdmin(req);
    const criadas = usuarios.criarContasCombinadas(db, { por: eu(req).login });
    for (const c of criadas) audit(req, 'usuario_criado', { login: c.usuario.login, perfil: c.usuario.perfil }, c.usuario.id);
    return { criadas };
  }));

  r.post('/usuarios/:id/resetar-senha', (req, res) => responder(res, () => {
    exigirAdmin(req);
    const out = usuarios.resetarSenha(db, req.params.id);
    audit(req, 'senha_resetada', { login: out.usuario.login }, out.usuario.id);
    return out;
  }));

  r.post('/usuarios/:id/ativo', (req, res) => responder(res, () => {
    exigirAdmin(req);
    const ativo = Boolean((req.body || {}).ativo);
    const u = usuarios.definirAtivo(db, req.params.id, ativo, { porId: eu(req).id });
    audit(req, ativo ? 'usuario_reativado' : 'usuario_desativado', { login: u.login }, u.id);
    return u;
  }));

  return r;
}

module.exports = { criarAcesso, porteiro, rotasConta, senhaInicial, naSessao };
