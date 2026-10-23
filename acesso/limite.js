// Limite de tentativas de login (em memória): 5 erros em 15 min por IP + usuário → espera.
const JANELA_MS = 15 * 60_000;
const MAX_ERROS = 5;

function criarLimite({ janelaMs = JANELA_MS, maxErros = MAX_ERROS, agora = () => Date.now() } = {}) {
  const erros = new Map(); // chave → [instantes]
  const chave = (ip, login) => `${ip || '?'}|${String(login || '').toLowerCase()}`;
  const recentes = (k) => (erros.get(k) || []).filter((t) => agora() - t < janelaMs);
  return {
    bloqueado(ip, login) {
      const r = recentes(chave(ip, login));
      if (r.length < maxErros) return 0;
      return Math.ceil((janelaMs - (agora() - r[0])) / 60_000); // minutos até liberar
    },
    erro(ip, login) {
      const k = chave(ip, login);
      erros.set(k, [...recentes(k), agora()]);
    },
    acerto(ip, login) { erros.delete(chave(ip, login)); },
  };
}

module.exports = { criarLimite };
