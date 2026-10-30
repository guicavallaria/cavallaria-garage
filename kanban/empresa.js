// Cabeçalho dos documentos de cada empresa. O PDF sai com os dados da empresa da OS.
// Cavallaria: igual ao das folhas atuais ("check basico" e "check completo", recebidas em 23/10/2026).
// AWDYNA: mesmos dados do gerador de termos (termos-cavallaria/config.json).
const EMPRESAS = {
  cavallaria: {
    id: 'cavallaria',
    rotulo: 'Cavallaria',
    nome: 'Cavallaria Garage',
    slogan: 'Oficina Mecânica Especializada em Veículos Importados',
    endereco: 'Avenida Tupi 268, Bortot - Pato Branco 85504-000',
    telefone: '(46) 2604-0612',
    email: 'guilhermecavallaria@gmail.com',
    cnpj: '07.954.296/0001-29',
    logo: 'public/kanban/img/logo-cavallaria-garage.webp',
    logoMime: 'image/webp',
  },
  awdyna: {
    id: 'awdyna',
    rotulo: 'AWDYNA',
    nome: 'AWDyna Performance',
    slogan: 'Cavallaria Garage by Armada Performance',
    endereco: 'Avenida Tupi 268, Bortot - Pato Branco 85504-000',
    telefone: '(46) 2604-0612',
    email: 'awdynaperformance@gmail.com',
    cnpj: '47.494.536/0001-74',
    logo: 'public/kanban/img/logo-awdyna.png',
    logoMime: 'image/png',
  },
};

const dadosEmpresa = (id) => EMPRESAS[id] || EMPRESAS.cavallaria;

module.exports = { EMPRESAS, dadosEmpresa };
