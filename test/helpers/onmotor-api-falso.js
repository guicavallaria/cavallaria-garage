// Onmotor NOVO falso (API JSON /api/v1), para os testes. Dados inventados, no formato real
// observado em 18/11/2026: a Pátio traz as datas sem ano ("18/11 08:59"); a OS inteira traz
// "2026-11-18 08:59"; telefone "+55(11)98888-7777"; valores podem vir {blocked, value}.
const uid = (n) => ('6afd' + String(n).padStart(4, '0')).padEnd(45, 'a0');

function servico(code, { entrada = null, aprovado = null, peca = null, execucao = null, fim = null, retirada = null, placa = 'ABC1D23',
  modelo = '320I', marca = 'BMW', cliente = `Cliente ${code}`, celular = '+55(11)98888-7777', atualizado = '2026-11-18 09:00:00', ano = '2026',
  cancelada = null } = {}) {
  const semAno = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)} ${d.slice(11, 16)}` : null);
  const comAno = (d) => (d ? `${ano}${d.slice(4)}` : null);
  const datas = { entry_date: entrada, approved_budget_date: aprovado, awaiting_part_date: peca, execution_date: execucao, end_date: fim, pickup_date: retirada };
  const resumo = {
    uid: uid(code), code, code_label: `${code} OS${code}`, status: 1, priority: 0, deleted_at: null, cancellation_date: cancelada,
    vehicle_plate: placa, vehicle_model: modelo, vehicle_manufacturer: marca, vehicle_odometer: null, vehicle_chassi: `WBATESTE${String(code).padStart(9, '0')}`,
    customer_name: cliente, customer_email: null, customer_phone: null, customer_mobile_number: celular, updated_at: atualizado,
  };
  const os = { uid: uid(code), code, odometer: 54321, created_at: comAno(entrada) || `${ano}-11-01 08:00`, cancellation_date: cancelada,
    vehicle: { plate: placa, manufacturer: marca, model: modelo, chassis: `WBATESTE${String(code).padStart(9, '0')}`, manufacture_year: '2019',
      model_year: '2020', color: 'PRETO', engine: null, fuel: 'Gasolina', transmission: null, steering: null, air_conditioning: null, doors: null } };
  for (const [k, v] of Object.entries(datas)) { resumo[k] = semAno(v); os[k] = comAno(v); }
  return { resumo, os };
}

// Servidor falso: `servicos` é a lista atual da Pátio (dá para trocar entre leituras).
function onmotorFalso({ servicos = [], otp = false, senhaCerta = 'segredo-teste' } = {}) {
  const st = { servicos, otp, logins: 0, chamadas: [], tokensValidos: new Set(), extras: new Map(), detalhes: 0 };
  let n = 0;
  const resp = (status, json) => ({ status, async text() { return JSON.stringify(json); }, headers: new Map() });
  st.fetch = async (url, opts = {}) => {
    const u = new URL(url);
    const caminho = u.pathname;
    st.chamadas.push(`${opts.method || 'GET'} ${caminho}`);
    const cookies = Object.fromEntries(String((opts.headers || {}).Cookie || '').split(/;\s*/).filter(Boolean).map((c) => c.split('=')));
    if (caminho === '/api/v1/login') {
      const b = JSON.parse(opts.body);
      if (b.password !== senhaCerta) return resp(422, { status: 422, message: 'Usuário ou senha inválidos.' });
      if (st.otp && !cookies.device_code) return resp(400, { status: 400, message: 'Informe o código', otp: { timeout: 60 } });
      st.logins++;
      const token = `tok${++n}`;
      st.tokensValidos.add(token);
      return resp(200, { authorization: { token, device_code: cookies.device_code || 'dev-123' } });
    }
    if (!st.tokensValidos.has(cookies.token)) return resp(403, { status: 403, message: 'Este usuário não tem acesso para realizar esta ação.' });
    if (caminho === '/api/v1/service/core/services-news') {
      return resp(200, { data: { services: st.servicos.map((s) => s.resumo), totals: {} } });
    }
    const m = caminho.match(/^\/api\/v1\/service\/core\/([0-9a-f]+)$/);
    if (m) {
      st.detalhes++;
      const s = st.servicos.find((x) => x.os.uid === m[1]) || st.extras.get(m[1]);
      return s ? resp(200, { data: s.os }) : resp(404, { status: 404, message: 'Registro não encontrado.' });
    }
    return resp(404, { status: 404, message: 'rota desconhecida' });
  };
  // Deixa a OS consultável pelo uid mesmo fora da Pátio (OS que saiu da lista).
  st.guardar = (s) => st.extras.set(s.os.uid, s);
  st.expirarTokens = () => st.tokensValidos.clear();
  return st;
}

module.exports = { servico, onmotorFalso, uid };
