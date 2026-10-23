// Kanban de OS — Etapa 4: checklists (modelos no banco, não na tela) + execução,
// respostas item a item com histórico, comentários, avarias e peças defeituosas.
// Semeia o modelo "Vistoria de entrada" (seção 7 do prompt), na ordem exata.
//
// `componentes` de cada item (JSON) diz o que a tela pede: foto obrigatória, medida,
// estado, opções etc. A tela de administração (Etapa 5) edita só os modelos; cada
// execução guarda o modelo_id da versão usada, então editar o modelo não muda o passado.

const REGIOES_AVARIA = [
  'Para-choque dianteiro', 'Capô', 'Para-lama DE', 'Para-lama DD', 'Porta DE', 'Porta DD', 'Porta TE', 'Porta TD',
  'Lateral', 'Teto', 'Tampa traseira', 'Para-choque traseiro', 'Rodas', 'Vidros', 'Interior', 'Outro',
];

const FOTO = [{ tipo: 'foto', obrigatorio: true }];

const VISTORIA_ENTRADA = {
  codigo: 'entrada',
  nome: 'Vistoria de entrada',
  secoes: [
    {
      titulo: 'Fotos do veículo',
      tipo: 'fotos_obrigatorias',
      itens: [
        ['e_01_painel', 'Painel com motor ligado mostrando odômetro',
          'Ligue o motor. Enquadre o painel inteiro, com o odômetro legível e as luzes de advertência visíveis. Depois digite o KM lido.',
          [{ tipo: 'foto', obrigatorio: true }, { tipo: 'medida', rotulo: 'KM', unidade: 'km', obrigatorio: true, inteiro: true, min: 0, max: 2000000 }]],
        ['e_02_bancos_dianteiros', 'Bancos dianteiros',
          'Com a porta do motorista aberta, enquadre os dois bancos dianteiros, o volante e o console.', FOTO],
        ['e_03_bancos_traseiros', 'Bancos traseiros',
          'Com uma porta traseira aberta, enquadre o banco traseiro inteiro e os tapetes.', FOTO],
        ['e_04_porta_malas', 'Porta-malas',
          'Porta-malas aberto. Foto de cima, mostrando todo o interior.', FOTO],
        ['e_05_cofre_motor', 'Cofre do motor',
          'Capô aberto. Foto de frente, pegando o motor inteiro.', FOTO],
        ['e_06_frente', 'Frente do veículo',
          'De frente, a uns 3 metros. Carro inteiro no quadro e placa legível.', FOTO],
        ['e_07_quina_dianteira_esquerda', 'Quina dianteira esquerda',
          'Na diagonal, pegando a frente e a lateral do lado do motorista.', FOTO],
        ['e_08_quina_dianteira_direita', 'Quina dianteira direita',
          'Na diagonal, pegando a frente e a lateral do lado do passageiro.', FOTO],
        ['e_09_lateral_esquerda', 'Lateral esquerda',
          'Lateral inteira do lado do motorista, de para-choque a para-choque.', FOTO],
        ['e_10_lateral_direita', 'Lateral direita',
          'Lateral inteira do lado do passageiro, de para-choque a para-choque.', FOTO],
        ['e_11_quina_traseira_esquerda', 'Quina traseira esquerda',
          'Na diagonal, pegando a traseira e a lateral do lado do motorista.', FOTO],
        ['e_12_quina_traseira_direita', 'Quina traseira direita',
          'Na diagonal, pegando a traseira e a lateral do lado do passageiro.', FOTO],
        ['e_13_traseira', 'Traseira',
          'De trás, a uns 3 metros. Carro inteiro no quadro e placa legível.', FOTO],
      ],
    },
    {
      titulo: 'Avarias',
      tipo: 'avarias',
      itens: [
        ['e_avarias', 'Identificou alguma avaria?',
          'Ao responder Sim, a câmera abre para fotografar a avaria; depois informe a região e uma descrição curta.',
          [{ tipo: 'sim_nao', obrigatorio: true }, { tipo: 'avarias', regioes: REGIOES_AVARIA }]],
      ],
    },
    {
      titulo: 'Combustível e itens presentes',
      tipo: 'itens',
      itens: [
        ['e_combustivel', 'Nível de combustível', 'Veja o marcador no painel.',
          [{ tipo: 'opcoes', obrigatorio: true, opcoes: ['Reserva', '1/4', '1/2', '3/4', 'Cheio'] }]],
        ['e_itens_presentes', 'Itens presentes no veículo', 'Marque o que está no carro.',
          [{ tipo: 'multipla', opcoes: ['Estepe', 'Macaco', 'Chave de roda', 'Triângulo', 'Documento', 'Tapetes'] }]],
      ],
    },
  ],
};

function semearModelo(db, modelo, { versao = 1, agora = new Date().toISOString() } = {}) {
  const modeloId = db.prepare(`INSERT INTO kb_checklist_modelos (codigo, versao, nome, ativo, criado_em, criado_por)
    VALUES (?, ?, ?, 1, ?, 'migração')`).run(modelo.codigo, versao, modelo.nome, agora).lastInsertRowid;
  const insSecao = db.prepare(`INSERT INTO kb_checklist_secoes (modelo_id, ordem, titulo, pede_responsavel, tipo)
    VALUES (?, ?, ?, ?, ?)`);
  const insItem = db.prepare(`INSERT INTO kb_checklist_itens (secao_id, ordem, codigo, texto, instrucao, componentes)
    VALUES (?, ?, ?, ?, ?, ?)`);
  modelo.secoes.forEach((s, i) => {
    const secaoId = insSecao.run(modeloId, i + 1, s.titulo, s.pede_responsavel ? 1 : 0, s.tipo || 'itens').lastInsertRowid;
    s.itens.forEach(([codigo, texto, instrucao, componentes], j) => {
      insItem.run(secaoId, j + 1, codigo, texto, instrucao || null, JSON.stringify(componentes));
    });
  });
  return modeloId;
}

exports.REGIOES_AVARIA = REGIOES_AVARIA;
exports.VISTORIA_ENTRADA = VISTORIA_ENTRADA;
exports.semearModelo = semearModelo;

exports.up = (db) => {
  db.exec(`
    CREATE TABLE kb_checklist_modelos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      codigo TEXT NOT NULL,
      versao INTEGER NOT NULL,
      nome TEXT NOT NULL,
      ativo INTEGER NOT NULL DEFAULT 1,
      criado_em TEXT NOT NULL,
      criado_por TEXT,
      UNIQUE (codigo, versao)
    );

    CREATE TABLE kb_checklist_secoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      modelo_id INTEGER NOT NULL REFERENCES kb_checklist_modelos(id),
      ordem INTEGER NOT NULL,
      titulo TEXT NOT NULL,
      pede_responsavel INTEGER NOT NULL DEFAULT 0,
      tipo TEXT NOT NULL DEFAULT 'itens' CHECK (tipo IN ('itens','fotos_obrigatorias','avarias','pecas_defeituosas'))
    );

    CREATE TABLE kb_checklist_itens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      secao_id INTEGER NOT NULL REFERENCES kb_checklist_secoes(id),
      ordem INTEGER NOT NULL,
      codigo TEXT NOT NULL,
      texto TEXT NOT NULL,
      instrucao TEXT,
      componentes TEXT NOT NULL
    );

    CREATE TABLE kb_checklist_execucoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES kb_cards(id),
      modelo_id INTEGER NOT NULL REFERENCES kb_checklist_modelos(id),
      status TEXT NOT NULL CHECK (status IN ('em_andamento','finalizado')),
      feito_por TEXT NOT NULL,
      responsaveis TEXT,
      iniciado_em TEXT NOT NULL,
      iniciado_por TEXT NOT NULL,
      finalizado_em TEXT,
      ultimo_item_id INTEGER
    );
    CREATE INDEX ix_kb_exec_card ON kb_checklist_execucoes(card_id, status);

    CREATE TABLE kb_checklist_respostas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execucao_id INTEGER NOT NULL REFERENCES kb_checklist_execucoes(id),
      item_id INTEGER NOT NULL REFERENCES kb_checklist_itens(id),
      valor TEXT NOT NULL,
      respondido_por TEXT NOT NULL,
      respondido_em TEXT NOT NULL,
      versao INTEGER NOT NULL DEFAULT 1,
      UNIQUE (execucao_id, item_id)
    );

    CREATE TABLE kb_checklist_respostas_hist (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resposta_id INTEGER NOT NULL REFERENCES kb_checklist_respostas(id),
      versao INTEGER NOT NULL,
      valor_anterior TEXT NOT NULL,
      alterado_por TEXT NOT NULL,
      alterado_em TEXT NOT NULL
    );

    CREATE TABLE kb_checklist_comentarios (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execucao_id INTEGER NOT NULL REFERENCES kb_checklist_execucoes(id),
      item_id INTEGER NOT NULL REFERENCES kb_checklist_itens(id),
      texto TEXT NOT NULL,
      autor_nome TEXT NOT NULL,
      criado_em TEXT NOT NULL,
      removido_em TEXT,
      removido_por TEXT
    );

    CREATE TABLE kb_checklist_avarias (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execucao_id INTEGER NOT NULL REFERENCES kb_checklist_execucoes(id),
      ordem INTEGER NOT NULL,
      regiao TEXT NOT NULL,
      descricao TEXT NOT NULL,
      criado_por TEXT NOT NULL,
      criado_em TEXT NOT NULL,
      removido_em TEXT,
      removido_por TEXT
    );

    CREATE TABLE kb_checklist_pecas (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      execucao_id INTEGER NOT NULL REFERENCES kb_checklist_execucoes(id),
      item_id INTEGER REFERENCES kb_checklist_itens(id),
      origem TEXT NOT NULL CHECK (origem IN ('automatica','manual')),
      descricao TEXT,
      tempo_troca_horas REAL,
      ordem INTEGER NOT NULL,
      atualizado_por TEXT,
      atualizado_em TEXT,
      removido_em TEXT,
      removido_por TEXT
    );

    -- PDFs gerados (vistoria, revisões). Gerar de novo cria versão nova; as antigas ficam.
    CREATE TABLE kb_pdfs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES kb_cards(id),
      tipo TEXT NOT NULL CHECK (tipo IN ('vistoria_entrada','revisao_basica','revisao_completa')),
      execucao_id INTEGER REFERENCES kb_checklist_execucoes(id),
      versao INTEGER NOT NULL,
      midia_id INTEGER NOT NULL REFERENCES kb_midias(id),
      gerado_por TEXT NOT NULL,
      gerado_em TEXT NOT NULL,
      UNIQUE (execucao_id, versao)
    );
  `);
  semearModelo(db, VISTORIA_ENTRADA);
};

exports.down = (db) => {
  db.exec(`
    DROP TABLE IF EXISTS kb_pdfs;
    DROP TABLE IF EXISTS kb_checklist_pecas;
    DROP TABLE IF EXISTS kb_checklist_avarias;
    DROP TABLE IF EXISTS kb_checklist_comentarios;
    DROP TABLE IF EXISTS kb_checklist_respostas_hist;
    DROP TABLE IF EXISTS kb_checklist_respostas;
    DROP TABLE IF EXISTS kb_checklist_execucoes;
    DROP TABLE IF EXISTS kb_checklist_itens;
    DROP TABLE IF EXISTS kb_checklist_secoes;
    DROP TABLE IF EXISTS kb_checklist_modelos;
  `);
};
