// Gera test/fixtures/novidades.html a partir de uma página REAL da aba Novidades,
// anonimizando dados pessoais e mantendo a estrutura exata (inclusive placas
// repetidas, que são o caso de teste da deduplicação).
//
// Uso: node test/fixtures/gerar-novidades.js <caminho/da/pagina-real.html>
// (a página real fica fora do repositório; só o resultado anonimizado é versionado)
const fs = require('fs');
const path = require('path');
const { parseLinhas } = require('../../patio/parser');

const origem = process.argv[2];
if (!origem) {
  console.error('uso: node test/fixtures/gerar-novidades.js <pagina-real.html>');
  process.exit(2);
}

let html = fs.readFileSync(origem, 'utf8');

// 1) enxuga o que não interessa (scripts, estilos, head, comentários)
html = html
  .replace(/<head>[\s\S]*?<\/head>/i, '<head><title>Onmotor</title></head>')
  .replace(/<script\b[\s\S]*?<\/script>/gi, '')
  .replace(/<style\b[\s\S]*?<\/style>/gi, '')
  .replace(/<!--[\s\S]*?-->/g, '');

// 2) anonimiza com mapeamentos determinísticos (mesmo valor real → mesmo valor falso)
const linhas = parseLinhas(html);
const mapa = new Map();
let n = 0;
const falso = (chave, gerar) => {
  if (!mapa.has(chave)) mapa.set(chave, gerar(++n));
  return mapa.get(chave);
};
const substituirTudo = (s, de, para) => s.split(de).join(para);

for (const l of linhas) {
  if (l.proprietario) html = substituirTudo(html, l.proprietario, falso('nome:' + l.proprietario, (i) => `Cliente Teste ${i}`));
  if (l.telefone) html = substituirTudo(html, l.telefone, falso('tel:' + l.telefone, (i) => `(46)9${String(1000 + i).slice(-4)}-0000`));
  if (l.placaTexto) {
    html = substituirTudo(html, l.placaTexto, falso('placa:' + l.placa, (i) => {
      const letras = String.fromCharCode(65 + Math.floor(i / 26) % 26) + String.fromCharCode(65 + (i % 26)) + 'Z';
      const mercosul = /^[A-Z]{3}\d[A-Z]\d{2}$/.test(l.placa || '');
      const corpo = mercosul ? `${i % 10}T${String(10 + i).slice(-2)}` : String(1000 + i).slice(-4);
      return /-/.test(l.placaTexto) ? `${letras}-${corpo}` : `${letras}${corpo}`;
    }));
  }
}
html = html
  .replace(/href="\/clientes\/visualizar\/\d+"/g, 'href="/clientes/visualizar/1"')
  .replace(/data-token="[^"]*"/g, 'data-token="t"')
  .replace(/data-rand="[^"]*"/g, 'data-rand="r"')
  .replace(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}/g, '00.000.000/0000-00');

const destino = path.join(__dirname, 'novidades.html');
fs.writeFileSync(destino, html);
console.log(`fixture gravado em ${destino} (${(html.length / 1024).toFixed(0)} KB, ${linhas.length} linhas de OS)`);
