const { test } = require('node:test');
const assert = require('node:assert/strict');
const { extrairDadosOS, parseModalVeiculo, normalizarChassi, anoVeiculo, buscarDetalhesOS } = require('../kanban/onmotor-os');
const { dataEtapa } = require('../patio/parser');
const { spParaUtc, formatarBR } = require('../kanban/datas');

// Trechos no formato real da página da OS (23/10/2026), com valores trocados.
const PAGINA_OS = `
<div class="col" data-field="data_entrada"><input class="field-datetime" data-formated="2026-10-20 16:06:00" value="20/10/2026 16:06"></div>
<select disabled
        name="data[id_veiculo]"
        data-name="data[id_veiculo]"
        id="ipt_id_veiculo"
        class="field-picklist form-control field-required">
  <option value="5197540">ABC1D23 - BMW 320i - 2.0 - Gasolina - 2018/2019 - Automático - 4P - Branco</option>
</select>
<i class="fa fa-check-circle"
   data-field="data_entrada"
   data-value="1"
   title="Entrada<br>20/10/26 às 16:06"></i>
<i class="fa fa-circle"
   data-field="data_de_finalizacao"
   data-value="0"
   title="Finalizado"></i>
<script>
            function abrirInformacoesVeiculo()
            {
                var json   = new Object();
                json.method = 'open-page';
                json.page   = 'oficina/structure/body/servicos/mais_info_veiculo';
                json.date   = $('div[data-field="data_entrada"] input.field-datetime').attr('data-formated');
                json.token  = 'b00c29eaTOKENFALSO';
                json.rand   = '65786adb4c6925531';
                json.id     = $('#ipt_id_veiculo').val();
                alert_modal('Informações do veículo', json, '', []);
            }
</script>`;

const linha = (k, v) => `                            <tr>
                                <th>${k}</th>
                                <td>${v}</td>
                            </tr>`;
const MODAL = JSON.stringify({
  success: true,
  time: 0.123,
  html: `<ul><li><a data-toggle="tab">Cadastro</a></li><li><a data-toggle="tab">Histórico de OS</a></li></ul>
<table>${[
    linha('Placa', 'ABC1D23'), linha('Modelo', '320i'), linha('Fabricante', 'BMW'),
    linha('Chassis', 'wbagl61002dm57925'), linha('Motor', '2.0'), linha('Ano fabricação', '2018'),
    linha('Ano modelo', '2019'), linha('Combustível', 'Gasolina'), linha('Câmbio', 'Automático'),
    linha('Direção', 'Elétrica'), linha('Ar', 'Digital'), linha('Cor', 'Branco'), linha('Portas', '4'),
  ].join('\n')}</table>
<table>${linha('Placa', 'OUTRA0000')}</table>`,
});

test('página da OS: token, rand, id do veículo, data de entrada e etapas', () => {
  const os = extrairDadosOS(PAGINA_OS);
  assert.equal(os.token, 'b00c29eaTOKENFALSO');
  assert.equal(os.rand, '65786adb4c6925531');
  assert.equal(os.veiculoId, '5197540');
  assert.equal(os.dataEntrada, '2026-10-20 16:06:00');
  assert.deepEqual(os.etapas, { entrada: true, finalizado: false, retirado: null });
  assert.equal(os.finalizadaEm, null);
});

test('data da etapa vem do ícone, não do <div data-field> do campo de data', () => {
  assert.equal(dataEtapa(PAGINA_OS, 'data_entrada'), '2026-10-20 16:06');
  assert.equal(dataEtapa(PAGINA_OS, 'data_de_finalizacao'), null);
});

test('cadastro do veículo: campos da aba Cadastro, chassi normalizado, ignora as outras abas', () => {
  const v = parseModalVeiculo(MODAL);
  assert.equal(v.fabricante, 'BMW');
  assert.equal(v.modelo, '320i');
  assert.equal(v.placa, 'ABC1D23');
  assert.equal(v.chassi, 'WBAGL61002DM57925');
  assert.equal(anoVeiculo(v), '2018/2019');
  assert.equal(v.cor, 'Branco');
});

test('cadastro do veículo: erros claros quando a sessão caiu ou o layout mudou', () => {
  assert.throws(() => parseModalVeiculo('<html>login</html>'), /não veio em JSON/);
  assert.throws(() => parseModalVeiculo(JSON.stringify({ success: false })), /sem conteúdo/);
  assert.throws(() => parseModalVeiculo(JSON.stringify({ success: true, html: '<p>nada</p>' })), /Chassis/);
});

test('chassi: 17 caracteres, maiúsculas, sem I/O/Q', () => {
  assert.equal(normalizarChassi(' 3fa6p0d91er345713 '), '3FA6P0D91ER345713');
  assert.equal(normalizarChassi('WBAGL6100'), null);
  assert.equal(normalizarChassi('WBAGL61002DM5792O'), null); // letra O
  assert.equal(normalizarChassi(''), null);
});

test('buscarDetalhesOS monta o POST /services igual à página do Onmotor', async () => {
  let pedido = null;
  const client = {
    osHtml: async () => PAGINA_OS,
    req: async (caminho, opts) => { pedido = { caminho, opts }; return { status: 200, html: MODAL }; },
  };
  const { veiculo } = await buscarDetalhesOS(client, '9486252');
  assert.equal(veiculo.chassi, 'WBAGL61002DM57925');
  assert.equal(pedido.caminho, '/services');
  assert.equal(pedido.opts.method, 'POST');
  const corpo = Object.fromEntries(new URLSearchParams(pedido.opts.body));
  assert.deepEqual(corpo, {
    method: 'open-page', page: 'oficina/structure/body/servicos/mais_info_veiculo',
    date: '2026-10-20 16:06:00', token: 'b00c29eaTOKENFALSO', rand: '65786adb4c6925531', id: '5197540',
  });
});

test('datas: hora de SP do Onmotor ↔ UTC gravado ↔ dd/mm/aaaa hh:mm na tela', () => {
  assert.equal(spParaUtc('2026-10-20 16:06'), '2026-10-20T19:06:00.000Z');
  assert.equal(spParaUtc('2026-10-20'), '2026-10-20T03:00:00.000Z');
  assert.equal(spParaUtc(''), null);
  assert.equal(formatarBR('2026-10-20T19:06:00.000Z'), '20/10/2026 16:06');
  assert.equal(formatarBR('2026-10-21T02:30:00.000Z'), '20/10/2026 23:30');
});
