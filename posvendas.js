/*
 * Pós-vendas — módulo embutido no servidor do agendamento.
 *
 * Lê os relatórios (Cavallaria semanais + AWDYNA) que foram ENVIADOS para o
 * volume de dados (DATA_DIR/posvendas/...) pelo script de push do PC, e expõe
 * SÓ dados não-financeiros: cliente, veículo, telefone, km, fotos, datas e
 * resumo dos serviços. Nenhum valor em R$ (faturamento, custo, comissão, taxa,
 * lucro, forma de pagamento) sai daqui.
 *
 * A geração dos relatórios continua no PC do Guilherme (é onde ficam os dados do
 * Onmotor); este módulo só consome o que o push sobe para a nuvem.
 */
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || __dirname;
const RELATORIOS_DIR = path.join(DATA_DIR, 'posvendas', 'relatorios'); // Semana_*.html (Cavallaria)
const AWDYNA_DIR = path.join(DATA_DIR, 'posvendas', 'awdyna');          // awdyna_*.json

/* ============ leitura e sanitização dos relatórios ============ */

// Extrai o literal (array/objeto) de `const NOME = ...` respeitando strings.
function extractSrc(txt, nome) {
  const re = new RegExp('const\\s+' + nome + '\\s*=\\s*');
  const m = re.exec(txt);
  if (!m) return null;
  const start = m.index + m[0].length;
  const open = txt[start];
  if (open !== '[' && open !== '{') return null;
  const close = open === '[' ? ']' : '}';
  let depth = 0, i = start, inStr = false, strCh = '', esc = false;
  for (; i < txt.length; i++) {
    const c = txt[i];
    if (inStr) {
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; continue; }
    if (c === open) depth++;
    else if (c === close) { depth--; if (depth === 0) { i++; break; } }
  }
  return txt.slice(start, i);
}
function evalBlock(txt, nome) {
  const src = extractSrc(txt, nome);
  if (!src) return null;
  try { return new Function('return (' + src + ')')(); } catch (e) { return null; }
}

// Semana_22-a-26-06-2026.html  |  Semana_29-06-a-03-07-2026.html
function parseNome(arquivo) {
  let m = /^Semana_(\d{2})-a-(\d{2})-(\d{2})-(\d{4})\.html$/.exec(arquivo);
  if (m) return { label: `${m[1]} a ${m[2]}/${m[3]}/${m[4]}`, key: `${m[4]}-${m[3]}-${m[1]}` };
  m = /^Semana_(\d{2})-(\d{2})-a-(\d{2})-(\d{2})-(\d{4})\.html$/.exec(arquivo);
  if (m) return { label: `${m[1]}/${m[2]} a ${m[3]}/${m[4]}/${m[5]}`, key: `${m[5]}-${m[2]}-${m[1]}` };
  return { label: arquivo.replace(/^Semana_|\.html$/g, ''), key: '0000-00-00' };
}

/* ---------- sugestão de mensagem de pós-venda (Luan, em nome da equipe) ---------- */
// Cuidado: usar \b nos dois lados nos termos curtos — sem isso, "Santos" casava com "S/A".
const EMPRESA_RX = new RegExp([
  '\\bLTDA\\b', '\\bEIRELI\\b', '\\bMEI\\b', '\\bME\\b', '\\bCIA\\b', '\\bS/A\\b', '\\bS\\.A\\b',
  '\\bAUTO\\b', 'COMERCI', 'COMÉRCI', 'SERVI[CÇ]OS', 'REPRESENTA', 'CONFEC', 'ENGENHARIA',
  'TRANSPORT', 'ADVOCACIA', 'SOCIEDADE', 'IND[UÚ]STRIA', 'EMPREEND', 'CONSTRUTORA', 'COMPENSADOS'
].join('|'), 'i');
function primeiroNomeCliente(nome) {
  if (!nome) return '';
  if (EMPRESA_RX.test(nome)) return '';
  const w = nome.trim().split(/\s+/)[0] || '';
  if (w.length < 2) return '';
  return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
}
function veiculoCurto(veic) {
  if (!veic) return 'veículo';
  const seg = String(veic).split('·')[0].trim();
  const fora = /^(flex|gasolina|diesel|el[eé]trico|automático|automatico|autom|4p|awd|fwd|rwd)$/i;
  const w = seg.split(/\s+/).filter(x => x && !fora.test(x));
  if (!w.length) return 'veículo';
  const n = (w[0].length <= 2 && w[2]) ? 3 : 2;
  return w.slice(0, n).join(' ');
}
const ABERTURAS = [
  n => n ? `Oi ${n}, tudo bem? Aqui é o Luan, da Cavallaria Garage.` : `Olá, tudo bem? Aqui é o Luan, da Cavallaria Garage.`,
  n => n ? `Olá ${n}! Aqui quem fala é o Luan, da equipe da Cavallaria Garage.` : `Olá! Aqui quem fala é o Luan, da equipe da Cavallaria Garage.`,
  n => n ? `${n}, tudo certo? Sou o Luan e falo pela Cavallaria Garage.` : `Tudo certo? Sou o Luan e falo pela Cavallaria Garage.`,
  n => n ? `Oi ${n}! É o Luan aqui, da Cavallaria Garage.` : `Olá! É o Luan aqui, da Cavallaria Garage.`,
  n => n ? `Olá ${n}, tudo bem? Quem fala é o Luan, da equipe da Cavallaria.` : `Olá, tudo bem? Quem fala é o Luan, da equipe da Cavallaria.`,
  n => n ? `${n}, bom dia! Aqui é o Luan, da Cavallaria Garage.` : `Bom dia! Aqui é o Luan, da Cavallaria Garage.`,
  n => n ? `Oi ${n}! Luan aqui, falando em nome da equipe da Cavallaria Garage.` : `Olá! Luan aqui, falando em nome da equipe da Cavallaria Garage.`,
  n => n ? `Olá ${n}, como vai? Sou o Luan, da Cavallaria Garage.` : `Olá, como vai? Sou o Luan, da Cavallaria Garage.`
];
const CORPOS = [
  v => `A gente acompanha de perto cada atendimento, e passamos para saber como está o seu ${v} depois do serviço.`,
  v => `Estamos revisando com os clientes os atendimentos da semana, e o seu ${v} está na nossa lista.`,
  v => `Passando para saber como ficou o seu ${v} depois do serviço que fizemos aqui na oficina.`,
  v => `Aqui na Cavallaria a gente gosta de conferir depois como ficou o trabalho — no caso, o seu ${v}.`,
  v => `Queríamos saber como o seu ${v} está se comportando depois da passagem pela nossa oficina.`,
  v => `Faz parte do nosso processo dar esse retorno depois do serviço, então queria falar do seu ${v}.`,
  v => `Estou entrando em contato para saber da sua experiência com o serviço no seu ${v}.`,
  v => `Nós acompanhamos todos os atendimentos depois de prontos, e queria conversar rapidinho sobre o seu ${v}.`
];
const PERGUNTAS = [
  () => `O serviço ficou dentro do que você esperava? E ficou alguma dúvida sobre o que foi feito?`,
  () => `Queria saber se o resultado atendeu a sua expectativa e se restou alguma dúvida sobre o serviço.`,
  () => `O atendimento correspondeu ao que você esperava? Ficou alguma dúvida que a gente possa esclarecer?`,
  () => `Ficou tudo como você imaginava? E tem alguma dúvida sobre os serviços realizados?`,
  () => `O serviço atendeu sua expectativa? Se ficou qualquer dúvida sobre o que foi feito, é só perguntar.`,
  () => `Gostaríamos de saber se ficou de acordo com o que você esperava e se sobrou alguma dúvida.`,
  () => `Deu tudo certo como você esperava? E ficou alguma dúvida a respeito do serviço?`,
  () => `O resultado ficou à altura do que você esperava? Alguma dúvida sobre o que foi feito no veículo?`
];
const FECHOS = [
  () => `Seu retorno ajuda a gente a melhorar sempre. Obrigado! 🙏`,
  () => `Qualquer ponto que possamos melhorar, estamos abertos a ouvir. Obrigado!`,
  () => `Ficamos à disposição para qualquer esclarecimento. Um abraço da equipe Cavallaria!`,
  () => `Se puder responder quando der, agradecemos muito. Estamos à disposição!`,
  () => `Qualquer coisa é só chamar por aqui. Obrigado pela confiança!`,
  () => `Estamos à disposição para o que precisar. Obrigado por confiar na Cavallaria!`,
  () => `Seu retorno é muito importante para nós. Obrigado! 👍`,
  () => `Conte com a gente para qualquer dúvida. Obrigado!`
];
// "5546991166772" -> "+55 46 99116-6772" (formato pronto para colar no WhatsApp)
function formatarWa(wa) {
  const d = String(wa || '').replace(/\D/g, '');
  if (d.length < 12) return '';
  const cc = d.slice(0, 2), ddd = d.slice(2, 4), num = d.slice(4);
  const meio = num.length >= 9 ? 5 : 4;
  return `+${cc} ${ddd} ${num.slice(0, meio)}-${num.slice(meio)}`;
}
function montarMensagem(osNum, nomeCliente, veic, marca) {
  const n = parseInt(String(osNum).replace(/\D/g, ''), 10) || 0;
  const nome = primeiroNomeCliente(nomeCliente);
  const v = veiculoCurto(veic);
  let msg = [
    ABERTURAS[n % ABERTURAS.length](nome),
    CORPOS[(n * 3 + 1) % CORPOS.length](v),
    PERGUNTAS[(n * 5 + 2) % PERGUNTAS.length](),
    FECHOS[(n * 7 + 3) % FECHOS.length]()
  ].join(' ');
  if (marca && marca !== 'Cavallaria') {
    msg = msg.replace(/Cavallaria Garage/g, marca).replace(/Cavallaria/g, marca);
  }
  return msg;
}

// Monta a versão sanitizada de uma semana. Retorna null se não tiver pós-vendas.
function lerSemana(arquivo) {
  const full = path.join(RELATORIOS_DIR, arquivo);
  let txt;
  try { txt = fs.readFileSync(full, 'utf8'); } catch (e) { return null; }

  const POS = evalBlock(txt, 'POS');
  if (!Array.isArray(POS) || !POS.length) return null;

  const CHK = evalBlock(txt, 'CHK') || {};
  const osData = evalBlock(txt, 'os_data') || [];
  const datas = {};
  osData.forEach(d => { datas[d.os] = { fin: d.fin || '—', ret: d.ret || '—', fat: d.fat || '—' }; });

  const ordenado = [...POS].sort((a, b) => (b.total || 0) - (a.total || 0));

  const lista = ordenado.map(p => {
    const c = CHK[p.os] || {};
    const dt = datas[p.os] || {};
    return {
      _total: p.total || 0,
      empresa: 'Cavallaria',
      os: p.os,
      cliente: p.nome || '',
      fone: p.fone || '',
      foneWa: formatarWa(p.wa),
      semFone: !!p.semFone,
      veiculo: p.veic || '',
      resumo: p.resumo || '',
      km: c.km || '',
      kmOk: c.kmOk !== false,
      kmMot: c.kmMot || '',
      fotos: typeof c.fotos === 'number' ? c.fotos : null,
      fotosOk: c.fotosOk !== false,
      finalizado: dt.fin || '—',
      retirada: dt.ret || '—',
      faturado: dt.fat || '—',
      mensagem: montarMensagem(p.os, p.nome, p.veic)
      // NUNCA: total, com, custo, venda_p, taxa, lucro, forma
    };
  });

  const info = parseNome(arquivo);
  return { arquivo, empresa: 'Cavallaria', label: info.label, key: info.key, qtd: lista.length, os: lista };
}

function listarSemanas() {
  let arquivos;
  try { arquivos = fs.readdirSync(RELATORIOS_DIR); } catch (e) { return []; }
  return arquivos
    .filter(f => /^Semana_.*\.html$/i.test(f))
    .map(lerSemana)
    .filter(Boolean)
    .sort((a, b) => (a.key < b.key ? 1 : a.key > b.key ? -1 : 0));
}

/* ============ AWDYNA (2ª empresa) — lê os JSONs de dados ============ */
function readJson(dir, nome) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, nome), 'utf8')); } catch (e) { return null; }
}
function veicModeloAwdyna(veic) {
  const parts = String(veic || '').split(' - ').map(s => s.trim());
  return parts.length >= 2 ? parts[1] : (veic || '');
}
function awdynaContatos() {
  const dados = readJson(AWDYNA_DIR, 'awdyna_dados.json');
  if (!dados) return [];
  const kf = readJson(AWDYNA_DIR, 'awdyna_kmfotos.json') || { km: {}, fotos: {} };
  const tels = readJson(AWDYNA_DIR, 'awdyna_telefones.json') || {};
  return Object.values(dados).map(o => {
    const total = (o.servicos || []).reduce((s, x) => s + (x.valor || 0), 0) + (o.vendaP || 0);
    const km = kf.km ? kf.km[o.codigo] : undefined;
    const fotos = kf.fotos ? (kf.fotos[o.codigo] || 0) : 0;
    const telRaw = tels[o.cliente] || tels[(o.cliente || '').trim()] || '';
    const wa = telRaw ? '55' + telRaw.replace(/\D/g, '') : '';
    const veicModelo = veicModeloAwdyna(o.veic);
    const resumo = (o.servicos || []).map(s => s.descricao).filter(Boolean).join(' · ') || '—';
    return {
      _total: total,
      empresa: 'AWDYNA',
      os: o.codigo,
      cliente: o.cliente || '',
      foneWa: formatarWa(wa),
      semFone: !telRaw,
      veiculo: veicModelo,
      resumo,
      km: (km === undefined ? '' : km),
      kmOk: !(km === 0 || km === undefined || km === ''),
      kmMot: (km === 0 ? 'não preenchida (0)' : ''),
      fotos: typeof fotos === 'number' ? fotos : null,
      fotosOk: (fotos > 0),
      finalizado: o.finalizado || '—',
      retirada: o.retirada || '—',
      faturado: o.faturamento || '—',
      mensagem: montarMensagem(o.codigo, o.cliente, veicModelo)   // sempre Cavallaria
      // NUNCA: total, custo, comissão/repasse, taxa, lucro, forma de pagamento
    };
  });
}

/* ============ visão UNIFICADA por semana (Cavallaria + AWDYNA juntos) ============ */
const CUTOFF_SEMANA = '2026-06-29';
function mondayKeyOf(ddmmyyyy) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(ddmmyyyy || '');
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1]);
  const dow = (d.getDay() + 6) % 7;
  d.setDate(d.getDate() - dow);
  const dd = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${dd(d.getMonth() + 1)}-${dd(d.getDate())}`;
}
function semanaLabelFromKey(key) {
  const [y, mo, da] = key.split('-').map(Number);
  const mon = new Date(y, mo - 1, da), fri = new Date(y, mo - 1, da + 4);
  const dd = n => String(n).padStart(2, '0');
  return mon.getMonth() === fri.getMonth()
    ? `${dd(mon.getDate())} a ${dd(fri.getDate())}/${dd(mo)}`
    : `${dd(mon.getDate())}/${dd(mon.getMonth() + 1)} a ${dd(fri.getDate())}/${dd(fri.getMonth() + 1)}`;
}
function semanaFechada(key) {
  const [y, mo, da] = key.split('-').map(Number);
  const fri = new Date(y, mo - 1, da + 4); fri.setHours(0, 0, 0, 0);
  const hoje = new Date(); hoje.setHours(0, 0, 0, 0);
  return fri < hoje;
}
function listarSemanasUnificadas() {
  const buckets = {};
  const add = (key, o) => { if (!key || key < CUTOFF_SEMANA) return; (buckets[key] = buckets[key] || []).push(o); };
  listarSemanas().forEach(wk => wk.os.forEach(o => add(wk.key, o)));
  awdynaContatos().forEach(o => add(mondayKeyOf(o.finalizado), o));

  return Object.keys(buckets).filter(semanaFechada).sort((a, b) => (a < b ? 1 : -1)).map(key => {
    const list = buckets[key].slice().sort((a, b) => (b._total || 0) - (a._total || 0));
    const qtdCav = list.filter(o => o.empresa === 'Cavallaria').length;
    const qtdAwd = list.filter(o => o.empresa === 'AWDYNA').length;
    const os = list.map(o => { const c = Object.assign({}, o); delete c._total; return c; });
    return { arquivo: 'semana-' + key, label: semanaLabelFromKey(key), key, qtd: os.length, qtdCav, qtdAwd, os };
  });
}
function lerSemanaUnificada(arquivo) {
  const k = String(arquivo).replace(/^semana-/, '');
  return listarSemanasUnificadas().find(s => s.key === k) || null;
}

/* ============ upload (push do PC) — grava o relatório no volume ============ */
// tipo: 'cavallaria' (Semana_*.html) | 'awdyna' (awdyna_*.json). Nome sanitizado.
function salvarRelatorio(tipo, nome, conteudo) {
  const base = path.basename(String(nome || '')); // impede path traversal
  let dir, ok;
  if (tipo === 'cavallaria') { dir = RELATORIOS_DIR; ok = /^Semana_.+\.html$/i.test(base); }
  else if (tipo === 'awdyna') { dir = AWDYNA_DIR; ok = /^awdyna_[a-z]+\.json$/i.test(base); }
  else throw new Error('tipo inválido (use cavallaria ou awdyna)');
  if (!ok) throw new Error('nome de arquivo inválido para o tipo ' + tipo);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, base), conteudo, 'utf8');
  return base;
}

module.exports = { listarSemanasUnificadas, lerSemanaUnificada, salvarRelatorio, RELATORIOS_DIR, AWDYNA_DIR };
