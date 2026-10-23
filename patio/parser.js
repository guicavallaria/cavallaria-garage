// Parser da aba Serviços → Novidades do Onmotor (HTML server-rendered).
//
// Sem DOM: a página é estável (tabela com células `data-th`), então regex por
// linha basta e não traz dependência nova. Qualquer mudança de layout cai nos
// testes com o fixture (test/fixtures/novidades.html).
//
// A página tem 3 seções (em execução / finalizados / aguardando entrada) e os
// `tbody` repetem id, então o que separa cada OS é o ícone de etapa da linha:
//   data-field="data_entrada" data-value="1"         → já deu entrada
//   data-field="data_de_finalizacao" data-value="0"  → ainda não finalizou
// Isso é literalmente a regra de negócio do pátio.
const { normalizarPlaca, formatarPlaca } = require('./placa');

const ENTIDADES = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };
const decodificar = (s) => String(s || '').replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTIDADES[m]);
const texto = (html) => decodificar(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();

function celula(tr, th) {
  const m = tr.match(new RegExp(`<td data-th="${th}[^"]*"[^>]*>([\\s\\S]*?)<\\/td>`));
  return m ? m[1] : '';
}

function flag(tr, campo) {
  const m = tr.match(new RegExp(`data-field="${campo}"\\s+data-value="(\\d)"`));
  return m ? m[1] === '1' : null;
}

// Data/hora de uma etapa, tirada do tooltip do ícone: title="Finalizado<br>21/10/26 às 17:40".
// Só existe quando a etapa foi marcada (data-value="1"). Serve para a linha da
// Novidades e para a página da OS, que usam o mesmo ícone.
function dataEtapa(html, campo) {
  // `<i` + atributos até o data-field: na página da OS existe também um <div data-field="…">
  // com o campo de data, que não pode ser confundido com o ícone.
  const icone = String(html || '').match(new RegExp(`<i\\b[^<]*?data-field="${campo}"[\\s\\S]*?<\\/i>`));
  if (!icone) return null;
  const m = icone[0].match(/title="[^"]*?<br>\s*(\d{2}\/\d{2}\/\d{2,4})(?:\s*(?:às|as|&agrave;s)\s*(\d{2}:\d{2}))?/);
  return m ? dataBR(m[1] + (m[2] ? ' ' + m[2] : '')) : null;
}

// "20/10/26 16:06" → "2026-10-20 16:06" (ISO local, sem fuso: é o relógio do Onmotor)
function dataBR(s) {
  const m = String(s || '').match(/(\d{2})\/(\d{2})\/(\d{2,4})(?:\s+(\d{2}:\d{2}))?/);
  if (!m) return null;
  const ano = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${ano}-${m[2]}-${m[1]}${m[4] ? ' ' + m[4] : ''}`;
}

// Sanidade estrutural antes de confiar na leitura (nunca "zerar" o pátio por página quebrada).
function validarPagina(html) {
  const h = String(html || '');
  const problemas = [];
  if (!/table-novidades/.test(h)) problemas.push('tabela table-novidades não encontrada');
  if (!/ltimas novidades/i.test(h)) problemas.push('cabeçalho "Últimas novidades" não encontrado');
  const total = (h.match(/existem\s*(?:<[^>]+>\s*)*(\d+)\s*(?:<[^>]+>\s*)*servi/i) || [])[1];
  return { ok: problemas.length === 0, problemas, totalInformado: total ? Number(total) : null };
}

function parseLinhas(html) {
  const linhas = [...String(html || '').matchAll(/<tr class="tr-servico-bg[12]"[\s\S]*?<\/tr>/g)].map((m) => m[0]);
  return linhas.map((tr) => {
    const osId = (tr.match(/data-id="(\d+)"/) || [])[1] || null;
    const osNumber =
      (tr.match(/<span class="visible-sm-inline visible-xs-inline">\s*(\d+)\s*<\/span>/) || [])[1] ||
      (texto(celula(tr, 'Código')).match(/\d+/) || [])[0] || null;

    const cli = celula(tr, 'Cliente');
    const proprietario = texto((cli.match(/<a[^>]*>([\s\S]*?)<\/a>/) || [])[1] || '');
    const veic = texto(cli.replace(/<a[\s\S]*?<\/a>/, '').replace(/<small>[\s\S]*?<\/small>/, ''));
    const [placaTextoBruta, ...resto] = veic.split(' - ');
    const placaTexto = (placaTextoBruta || '').trim();
    const placa = normalizarPlaca(placaTexto);
    const modelo = resto.join(' - ').trim();
    const km = (cli.match(/\(\s*([\d.]+)\s*KM\s*\)/i) || [])[1] || null;

    const telefone = (texto(celula(tr, 'Contato')).match(/\(\d{2}\)\s?\d{4,5}-?\d{4}/) || [])[0] || null;
    const entrada = dataBR(texto(celula(tr, 'Entrada')));

    const etapas = {
      entrada: flag(tr, 'data_entrada'),
      orcamento: flag(tr, 'data_de_orcamento'),
      aguardandoPeca: flag(tr, 'data_de_aguardando_peca'),
      emExecucao: flag(tr, 'data_de_andamento'),
      finalizado: flag(tr, 'data_de_finalizacao'),
      retirado: flag(tr, 'data_de_retirada'),
    };

    const datas = {
      entrada: dataEtapa(tr, 'data_entrada'),
      orcamento: dataEtapa(tr, 'data_de_orcamento'),
      aguardandoPeca: dataEtapa(tr, 'data_de_aguardando_peca'),
      emExecucao: dataEtapa(tr, 'data_de_andamento'),
      finalizado: dataEtapa(tr, 'data_de_finalizacao'),
      retirado: dataEtapa(tr, 'data_de_retirada'),
    };

    return {
      osId, osNumber, proprietario,
      placaTexto, placa, placaExibicao: placa ? formatarPlaca(placa) : placaTexto,
      modelo, km, telefone, entrada, etapas, datas,
    };
  });
}

// Regra de negócio: está no pátio = deu entrada e ainda não finalizou.
const noPatio = (l) => l.etapas.entrada === true && l.etapas.finalizado === false;

function parseNovidades(html) {
  const validacao = validarPagina(html);
  const linhas = parseLinhas(html);
  // Cada OS tem exatamente um ícone "Entrada": se a contagem bruta não bater com
  // as linhas parseadas, o layout mudou — melhor falhar do que ler pela metade.
  const icones = (String(html || '').match(/data-field="data_entrada"/g) || []).length;
  const problemas = [...validacao.problemas];
  if (icones !== linhas.length) problemas.push(`inconsistência: ${icones} ícone(s) de entrada para ${linhas.length} linha(s) parseada(s)`);
  return {
    ok: problemas.length === 0,
    problemas,
    totalInformado: validacao.totalInformado,
    linhas,
    emExecucao: linhas.filter(noPatio),
    totalLido: linhas.length,
  };
}

module.exports = { parseNovidades, parseLinhas, validarPagina, noPatio, dataBR, dataEtapa, flag, texto };
