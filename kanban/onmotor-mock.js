// Fonte FALSA do Onmotor para desenvolvimento (KANBAN_FONTE=mock).
//
// A Novidades vem de um arquivo HTML no formato real (padrão: o fixture anonimizado
// do pátio). O arquivo é relido a cada sincronização, então dá para simular OS nova,
// alteração ou finalização editando uma cópia dele e apontando KANBAN_MOCK_NOVIDADES.
// A página da OS e o cadastro do veículo são gerados a partir da linha da Novidades,
// com chassi falso determinístico (WBATEST + id).
const fs = require('fs');
const path = require('path');
const { parseLinhas } = require('../patio/parser');
const { PAGINA_MODAL_VEICULO } = require('./onmotor-os');

const PADRAO = path.join(__dirname, '..', 'test', 'fixtures', 'novidades.html');

function chassiFalso(id) {
  return ('WBATEST' + String(id).replace(/\D/g, '').padStart(10, '0')).slice(0, 17);
}

class OnmotorMock {
  constructor({ arquivo = process.env.KANBAN_MOCK_NOVIDADES || PADRAO, log = () => {} } = {}) {
    this.nome = 'mock';
    this.arquivo = arquivo;
    this.log = log;
  }

  configurado() { return true; }

  async novidadesHtml() {
    return fs.readFileSync(this.arquivo, 'utf8');
  }

  // Linha <tr> da OS na Novidades (traz os ícones de etapa com as datas).
  linhaDaOS(osId) {
    const html = fs.readFileSync(this.arquivo, 'utf8');
    const trs = html.match(/<tr class="tr-servico-bg[12]"[\s\S]*?<\/tr>/g) || [];
    const tr = trs.find((t) => t.includes(`data-id="${osId}"`));
    if (!tr) return null;
    return { tr, dados: parseLinhas(tr)[0] };
  }

  async osHtml(osId) {
    const achado = this.linhaDaOS(osId);
    if (!achado) throw new Error(`OS ${osId} não existe no mock`);
    return `<html><body>
<select disabled name="data[id_veiculo]" id="ipt_id_veiculo"><option value="${osId}">${achado.dados.placaTexto} - ${achado.dados.modelo}</option></select>
<div class="etapas">${(achado.tr.match(/<i class="fa[\s\S]*?<\/i>/g) || []).join('\n')}</div>
<script>
function abrirInformacoesVeiculo() {
  var json = new Object();
  json.method = 'open-page';
  json.page = '${PAGINA_MODAL_VEICULO}';
  json.token = 'tokenfalso${osId}';
  json.rand = 'randfalso';
  json.id = $('#ipt_id_veiculo').val();
  alert_modal('Informações do veículo', json, '', []);
}
</script></body></html>`;
  }

  async req(caminho, opts = {}) {
    if (caminho !== '/services') throw new Error(`mock não conhece ${caminho}`);
    const p = new URLSearchParams(String(opts.body || ''));
    const achado = this.linhaDaOS(p.get('id'));
    if (!achado) return { status: 200, url: caminho, html: JSON.stringify({ success: false }) };
    const d = achado.dados;
    const MARCAS = ['BMW', 'VOLKSWAGEN', 'VOLVO', 'PORSCHE', 'AUDI', 'FORD', 'SUBARU', 'MITSUBISHI', 'HYUNDAI', 'CHEVROLET'];
    const partes = String(d.modelo || 'MODELO').split(' ');
    const marcaNoTexto = MARCAS.includes(partes[0].toUpperCase()) && partes.length > 1;
    const fabricante = marcaNoTexto ? partes[0] : 'BMW';
    const modelo = marcaNoTexto ? partes.slice(1).join(' ') : d.modelo;
    const linha = (k, v) => `<tr>\n<th>${k}</th>\n<td>${v}</td>\n</tr>`;
    const html = `<table>${[
      linha('Placa', d.placaTexto), linha('Modelo', modelo), linha('Fabricante', fabricante),
      linha('Chassis', chassiFalso(p.get('id'))), linha('Motor', '2.0'), linha('Ano fabricação', '2019'),
      linha('Ano modelo', '2020'), linha('Combustível', 'Gasolina'), linha('Câmbio', 'Automático'),
      linha('Direção', 'Elétrica'), linha('Ar', 'Digital'), linha('Cor', 'Preto'), linha('Portas', '4'),
    ].join('\n')}</table>`;
    return { status: 200, url: caminho, html: JSON.stringify({ success: true, time: 0.1, html }) };
  }
}

module.exports = { OnmotorMock, chassiFalso };
