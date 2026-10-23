// Leitura da página da OS e do cadastro do veículo no Onmotor (só leitura).
//
// O chassi não aparece na Novidades nem no texto do veículo da OS. Ele vem do modal
// "Informações do veículo" da página da OS, que a própria página pede assim:
//   POST /services  (form)  method=open-page
//                           page=oficina/structure/body/servicos/mais_info_veiculo
//                           id=<id do veículo, #ipt_id_veiculo>  token/rand=<da página>  date=<entrada>
// A resposta é JSON {success, time, html}; o html tem uma tabela <tr><th>Rótulo</th><td>Valor</td>.
// Verificado em 23/10/2026 em OS reais (aba "Cadastro" do modal).
const { flag, dataEtapa, texto } = require('../patio/parser');

const PAGINA_MODAL_VEICULO = 'oficina/structure/body/servicos/mais_info_veiculo';
const RX_VIN = /^[A-HJ-NPR-Z0-9]{17}$/; // VIN: 17 caracteres, sem I, O e Q

function normalizarChassi(valor) {
  const limpo = String(valor || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return RX_VIN.test(limpo) ? limpo : null;
}

function extrairDadosOS(html) {
  const h = String(html || '');
  const bloco = (h.match(/function abrirInformacoesVeiculo\s*\(\)[\s\S]*?alert_modal/) || [''])[0];
  const token = (bloco.match(/json\.token\s*=\s*'([^']+)'/) || [])[1] || null;
  const rand = (bloco.match(/json\.rand\s*=\s*'([^']+)'/) || [])[1] || null;
  const sel = (h.match(/<select[^>]*id="ipt_id_veiculo"[\s\S]*?<\/select>/) || [''])[0];
  const veiculoId = (
    sel.match(/<option[^>]*\bselected\b[^>]*value="(\d+)"/) ||
    sel.match(/<option[^>]*value="(\d+)"[^>]*\bselected\b/) ||
    sel.match(/<option[^>]*value="(\d+)"/) || []
  )[1] || null;
  const dataEntrada = (h.match(/<div[^>]*data-field="data_entrada"[\s\S]{0,800}?data-formated="([^"]*)"/) || [])[1] || '';
  return {
    token, rand, veiculoId, dataEntrada,
    etapas: {
      entrada: flag(h, 'data_entrada'),
      finalizado: flag(h, 'data_de_finalizacao'),
      retirado: flag(h, 'data_de_retirada'),
    },
    finalizadaEm: dataEtapa(h, 'data_de_finalizacao'), // hora local de SP, "AAAA-MM-DD HH:MM"
  };
}

function parseModalVeiculo(resposta) {
  let j;
  try {
    j = typeof resposta === 'string' ? JSON.parse(resposta) : resposta;
  } catch (_) {
    throw new Error('cadastro do veículo não veio em JSON (sessão expirada ou layout mudou?)');
  }
  if (!j || !j.success || typeof j.html !== 'string') throw new Error('cadastro do veículo veio sem conteúdo');

  // Só a 1ª ocorrência de cada rótulo: as outras abas do modal (histórico de OS) também têm tabelas.
  const campos = {};
  for (const m of j.html.matchAll(/<tr>\s*<th[^>]*>([\s\S]*?)<\/th>\s*<td[^>]*>([\s\S]*?)<\/td>/g)) {
    const rotulo = texto(m[1]);
    if (rotulo && !(rotulo in campos)) campos[rotulo] = texto(m[2]);
  }
  if (!('Chassis' in campos)) throw new Error('cadastro do veículo sem o campo "Chassis" (layout mudou?)');

  const c = (k) => campos[k] || '';
  return {
    placa: c('Placa'),
    fabricante: c('Fabricante'),
    modelo: c('Modelo'),
    chassi: normalizarChassi(c('Chassis')),
    chassiInformado: c('Chassis'),
    anoFabricacao: c('Ano fabricação'),
    anoModelo: c('Ano modelo'),
    motor: c('Motor'),
    combustivel: c('Combustível'),
    cambio: c('Câmbio'),
    direcao: c('Direção'),
    ar: c('Ar'),
    cor: c('Cor'),
    portas: c('Portas'),
  };
}

// "2018" + "2019" → "2018/2019"; iguais ou só um → "2019"
function anoVeiculo(v) {
  const fab = String(v.anoFabricacao || '').trim();
  const mod = String(v.anoModelo || '').trim();
  if (fab && mod && fab !== mod) return `${fab}/${mod}`;
  return mod || fab || '';
}

// Página da OS + modal do veículo. `client` é o OnmotorClient do pátio (ou o mock).
async function buscarDetalhesOS(client, osIdInterno) {
  const os = extrairDadosOS(await client.osHtml(osIdInterno));
  if (!os.veiculoId) throw new Error('OS sem veículo vinculado');
  if (!os.token || !os.rand) throw new Error('página da OS sem o token do cadastro do veículo (layout mudou?)');
  const r = await client.req('/services', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      'X-Requested-With': 'XMLHttpRequest',
      Accept: 'application/json, text/javascript, */*; q=0.01',
    },
    body: new URLSearchParams({
      method: 'open-page', page: PAGINA_MODAL_VEICULO, date: os.dataEntrada,
      token: os.token, rand: os.rand, id: os.veiculoId,
    }).toString(),
  });
  if (r.status !== 200) throw new Error(`cadastro do veículo respondeu ${r.status}`);
  return { os, veiculo: parseModalVeiculo(r.html) };
}

module.exports = { extrairDadosOS, parseModalVeiculo, buscarDetalhesOS, normalizarChassi, anoVeiculo, PAGINA_MODAL_VEICULO };
