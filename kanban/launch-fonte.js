// De onde vêm os e-mails do Launch: Gmail de verdade (padrão quando configurado) ou uma
// pasta de PDFs simulando a caixa (LAUNCH_FONTE=mock), para o desenvolvimento.
// E a rodada de importação (job a cada 5 min).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { ClienteGmail, configurado: gmailConfigurado } = require('./gmail');
const launch = require('./launch');
const { ErroAcao } = require('./acoes');

function modo(env = process.env) {
  if (env.LAUNCH_FONTE === 'mock') return 'mock';
  if (env.LAUNCH_FONTE === 'desligado') return 'desligado';
  return gmailConfigurado(env) ? 'gmail' : 'desligado';
}

// Pasta com PDFs = caixa de entrada simulada. Cada PDF vira um "e-mail" (id estável pelo nome);
// a data do e-mail é a data do arquivo.
class FonteMock {
  constructor({ pasta = process.env.KANBAN_LAUNCH_MOCK_DIR } = {}) {
    if (!pasta) throw new Error('KANBAN_LAUNCH_MOCK_DIR não definido');
    this.pasta = pasta;
  }

  async buscarNovas(jaProcessada) {
    if (!fs.existsSync(this.pasta)) return [];
    const out = [];
    // mais antigos primeiro (como o Gmail)
    const nomes = fs.readdirSync(this.pasta).filter((n) => /\.pdf$/i.test(n))
      .sort((a, b) => fs.statSync(path.join(this.pasta, a)).mtimeMs - fs.statSync(path.join(this.pasta, b)).mtimeMs);
    for (const nome of nomes) {
      const id = 'mock-' + crypto.createHash('sha1').update(nome).digest('hex').slice(0, 16);
      if (jaProcessada(id)) continue;
      const arq = path.join(this.pasta, nome);
      out.push({
        messageId: id,
        recebidoEm: fs.statSync(arq).mtime.toISOString(),
        assunto: 'LAUNCH',
        remetente: 'LAUNCH <report@x431.com>',
        anexos: [{ nome, carregar: async () => fs.readFileSync(arq) }],
      });
    }
    return out;
  }
}

function criarFonte(env = process.env) {
  const m = modo(env);
  if (m === 'mock') return new FonteMock({ pasta: env.KANBAN_LAUNCH_MOCK_DIR });
  if (m === 'gmail') return new ClienteGmail({ env });
  return null;
}

// Uma rodada: e-mails novos → PDFs → bucket → vínculo pelo chassi. Erro de rede/Gmail não
// marca o e-mail como processado (tenta de novo na próxima); PDF inválido marca como erro.
async function sincronizarLaunch(db, storage, fonte, { origem = 'auto', log = console.log, broadcast = () => {} } = {}) {
  const inicio = new Date().toISOString();
  const logId = db.prepare('INSERT INTO launch_sync_log (origem, iniciado_em) VALUES (?, ?)').run(origem, inicio).lastInsertRowid;
  const fechar = db.prepare('UPDATE launch_sync_log SET terminado_em = ?, sucesso = ?, emails_lidos = ?, relatorios_novos = ?, vinculados = ?, erro = ? WHERE id = ?');
  const jaProcessada = (id) => Boolean(db.prepare('SELECT 1 FROM launch_emails WHERE message_id = ?').get(id));
  const regEmail = db.prepare(`INSERT INTO launch_emails (message_id, recebido_em, assunto, remetente, processado_em, status, anexos, erro)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(message_id) DO NOTHING`);
  let lidos = 0;
  let novos = 0;
  let vinculados = 0;
  try {
    if (!fonte) throw new Error('fonte dos relatórios Launch não configurada');
    if (!storage || !storage.configurado) throw new Error('armazenamento não configurado');
    const msgs = await fonte.buscarNovas(jaProcessada);
    for (const m of msgs) {
      // segurança extra além da busca: só e-mails do scanner
      if (!/launch/i.test(`${m.assunto} ${m.remetente}`)) {
        regEmail.run(m.messageId, m.recebidoEm, m.assunto, m.remetente, new Date().toISOString(), 'ignorado', 0, 'não é do LAUNCH');
        continue;
      }
      lidos++;
      let ok = 0;
      let erroPermanente = null;
      for (const a of m.anexos) {
        try {
          const r = await launch.importarRelatorio(db, storage, {
            origem: 'email', messageId: m.messageId, nomeArquivo: a.nome, bytes: await a.carregar(), relatorioEm: m.recebidoEm,
          });
          if (!r.duplicado) { ok++; novos++; if (r.vinculado) vinculados++; }
        } catch (e) {
          if (e instanceof ErroAcao || e.permanente) erroPermanente = `${a.nome}: ${e.message}`; else throw e;
        }
      }
      regEmail.run(m.messageId, m.recebidoEm, m.assunto, m.remetente, new Date().toISOString(),
        erroPermanente ? 'erro' : (m.anexos.length ? 'ok' : 'sem_anexo'), ok, erroPermanente);
    }
    fechar.run(new Date().toISOString(), 1, lidos, novos, vinculados, null, logId);
    if (novos) log(`launch (${origem}): ${lidos} e-mail(s), ${novos} relatório(s) novo(s), ${vinculados} vinculado(s)`);
    if (novos) broadcast('kanban');
    return { ok: true, emails: lidos, novos, vinculados };
  } catch (e) {
    fechar.run(new Date().toISOString(), 0, lidos, novos, vinculados, e.message, logId);
    log(`launch (${origem}) FALHOU: ${e.message}`);
    if (novos) broadcast('kanban');
    return { ok: false, erro: e.message, emails: lidos, novos, vinculados };
  }
}

function estadoLaunch(db) {
  const ultimaOk = db.prepare('SELECT terminado_em FROM launch_sync_log WHERE sucesso = 1 ORDER BY id DESC LIMIT 1').get();
  const ultima = db.prepare('SELECT * FROM launch_sync_log ORDER BY id DESC LIMIT 1').get();
  return {
    modo: modo(),
    ultima_ok_em: ultimaOk ? ultimaOk.terminado_em : null,
    ultimo_erro: ultima && ultima.terminado_em && !ultima.sucesso ? ultima.erro : null,
    nao_vinculados: db.prepare('SELECT COUNT(*) AS n FROM launch_relatorios WHERE card_id IS NULL AND removido_em IS NULL').get().n,
  };
}

module.exports = { modo, criarFonte, FonteMock, sincronizarLaunch, estadoLaunch };
