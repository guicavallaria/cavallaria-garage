// Edições no fixture da Novidades (formato real, anonimizado) para simular o que o
// Onmotor faz entre duas leituras: OS nova, OS alterada, OS finalizada, OS que some.
const fs = require('fs');
const path = require('path');
const { parseLinhas } = require('../../patio/parser');

const FIXTURE = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'novidades.html'), 'utf8');
const RX_TR = /<tr class="tr-servico-bg[12]"[\s\S]*?<\/tr>/g;

const linhas = (html = FIXTURE) => parseLinhas(html);

function trDa(html, osId) {
  const tr = (html.match(RX_TR) || []).find((t) => t.includes(`data-id="${osId}"`));
  if (!tr) throw new Error(`OS ${osId} não está no HTML`);
  return tr;
}

function editarLinha(html, osId, fn) {
  const tr = trDa(html, osId);
  return html.replace(tr, fn(tr));
}

// Finaliza a OS: ícone "Finalizado" com valor 1 e data no tooltip ("23/10/26 às 10:30").
function finalizar(html, osId, quando = '23/10/26 às 10:30') {
  return editarLinha(html, osId, (tr) => tr
    .replace(/(data-field="data_de_finalizacao"\s+data-value=")0(")/, '$11$2')
    .replace(/(data-field="data_de_finalizacao"[\s\S]*?title=")Finalizado(")/, `$1Finalizado<br>${quando}$2`));
}

function trocarCliente(html, osId, novoNome) {
  const atual = linhas(trDa(html, osId))[0].proprietario;
  return editarLinha(html, osId, (tr) => tr.split(atual).join(novoNome));
}

function remover(html, osId) {
  return html.replace(trDa(html, osId), '');
}

// Copia uma linha como uma OS nova (outro id interno e outro número).
function novaOS(html, { baseOsId, osId, osNumero }) {
  const tr = trDa(html, baseOsId);
  const base = linhas(tr)[0];
  const copia = tr.split(`data-id="${base.osId}"`).join(`data-id="${osId}"`)
    .split(`>${base.osNumber}<`).join(`>${osNumero}<`)
    .split(` ${base.osNumber} `).join(` ${osNumero} `);
  return html.replace(tr, tr + '\n' + copia);
}

module.exports = { FIXTURE, linhas, trDa, editarLinha, finalizar, trocarCliente, remover, novaOS };
