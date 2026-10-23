// Kanban de OS — Etapa 5: modelos "Revisão básica" e "Revisão completa" (seções 8 e 9 do
// prompt, na ordem exata das folhas "check basico" e "check completo") e links públicos
// com validade (vídeo no PDF via QR code; PDF enviado ao cliente — 7 dias, revogáveis).
//
// Tipos das folhas → componentes:
//   E  = estado Bom / Regular / Necessita troca
//   R  = estado Bom / Regular / Necessita reparo (+ descrição obrigatória, que vai para "Peças defeituosas")
//   S  = sim/não ("feito" = Feito / Não feito)       M = medida numérica       F = foto obrigatória
//   NT = opção "Não tem"
const { semearModelo } = require('./005_checklists');

const E = (extra = {}) => ({ tipo: 'estado', escala: 'troca', obrigatorio: true, ...extra });
const R = () => ({ tipo: 'estado', escala: 'reparo', obrigatorio: true, descricao_se_reparo: true });
const S = (extra = {}) => ({ tipo: 'sim_nao', obrigatorio: true, ...extra });
const FEITO = (extra = {}) => S({ rotulos: ['Feito', 'Não feito'], ...extra });
const M = (rotulo, unidade, obrigatorio = false, extra = {}) => ({ tipo: 'medida', rotulo, unidade, obrigatorio, min: 0, ...extra });
const F = (rotulo) => ({ tipo: 'foto', obrigatorio: true, rotulo });
const T = (rotulo, obrigatorio = true) => ({ tipo: 'texto', rotulo, obrigatorio });
const NT = { nao_tem: true };
// Medida do pneu (ex.: 225/45R18) em três campos numéricos.
const MEDIDA_PNEU = [M('Largura', 'mm', true, { inteiro: true }), M('Perfil', '%', true, { inteiro: true }), M('Aro', 'pol', true)];

const LAUNCH = 'Fotografe a tela do scanner LAUNCH com o resultado dos sulcos (substitui o "enviar no Trello").';

function freios(prefixo, lado, medidas) {
  const itens = [];
  if (medidas) {
    itens.push([`${prefixo}_disco_${medidas[0].toLowerCase()}`, `Medida disco ${medidas[0]}`, null, [M('Espessura', 'mm', false)]]);
    itens.push([`${prefixo}_disco_${medidas[1].toLowerCase()}`, `Medida disco ${medidas[1]}`, null, [M('Espessura', 'mm', false)]]);
  }
  itens.push([`${prefixo}_pastilhas`, 'Trocar pastilhas', null, [S({ gera_peca: true })]]);
  itens.push([`${prefixo}_discos`, 'Trocar discos', null, [S({ gera_peca: true })]]);
  itens.push([`${prefixo}_procut`, 'Pro Cut', null, [S()]]);
  return { titulo: `Freios ${lado}`, tipo: 'itens', itens };
}

const FREIO_MAO = (p) => ({
  titulo: 'Freio de mão',
  tipo: 'itens',
  itens: [
    [`${p}_fm_eletronico`, 'Freio de mão eletrônico', 'Assinale Sim se for eletrônico.', [S()]],
    [`${p}_fm_rosca`, 'Freio de mão com retração tipo rosca', null, [S()]],
  ],
});

const PECAS = { titulo: 'Peças defeituosas', tipo: 'pecas_defeituosas', itens: [] };

const REVISAO_BASICA = {
  codigo: 'revisao_basica',
  nome: 'Checklist de Revisão Básica',
  secoes: [
    {
      titulo: 'Inspeção pré-elevador',
      itens: [
        ['rb_01', 'Verificação das palhetas do limpador', null, [E()]],
        ['rb_02', 'Verificação e teste das lâmpadas do veículo', null, [E()]],
        ['rb_03', 'Verificação do filtro de cabine / filtro de ar condicionado', null, [E()]],
        ['rb_04', 'Verificar necessidade de troca óleo motor e filtro de óleo', null, [E()]],
        ['rb_05', 'Verificação do nível de água do lavador do para-brisa e aplicação de pastilha', null, [FEITO()]],
      ],
    },
    {
      titulo: 'Elevador',
      itens: [
        ['rb_06', 'Teste de folga de suspensão dianteira', null, [R()]],
        ['rb_07', 'Teste de folga de suspensão traseira', null, [R()]],
        ['rb_08', 'Teste dos sulcos dos pneus via ferramenta LAUNCH', LAUNCH, [F('Foto da tela do Launch')]],
        ['rb_09', 'Avaliação dos pneus dianteiros', null, [E(), M('Sulco', 'mm')]],
        ['rb_10', 'Avaliação dos pneus traseiros', null, [E(), M('Sulco', 'mm')]],
        ['rb_11', 'Necessita alinhamento e geometria', null, [S()]],
        ['rb_12', 'Necessita rodízio (avaliar se é possível pelas medidas)', null, [S()]],
        ['rb_13', 'Vazamentos de óleo no motor', null, [R()]],
        ['rb_14', 'Vazamento de óleo no sistema de transmissão', null, [R()]],
        ['rb_15', 'Vazamento no sistema de arrefecimento', null, [R()]],
        ['rb_16', 'Verificação do filtro de ar do motor', null, [E()]],
        ['rb_17', 'Verificação da correia de acessórios', null, [E()]],
        ['rb_18', 'Verificação do fluido de freio', null, [E()]],
        ['rb_19', 'Verificação do filtro de combustível', null, [E(NT)]],
      ],
    },
    freios('rb_fd', 'dianteiros', null),
    freios('rb_ft', 'traseiros', null),
    FREIO_MAO('rb'),
    PECAS,
  ],
};

const REVISAO_COMPLETA = {
  codigo: 'revisao_completa',
  nome: 'Checklist de Revisão Completa',
  secoes: [
    {
      titulo: 'Inspeção pré-elevador',
      itens: [
        ['rc_01', 'Teste da bateria', 'Fotografe a tela do testador com o resultado.',
          [E(), M('Tensão', 'V'), M('CCA', 'A', false, { inteiro: true }), F('Foto do testador')]],
        ['rc_02', 'Verificação das palhetas do limpador do para-brisa', null, [E()]],
        ['rc_03', 'Verificação e teste das lâmpadas do veículo', null, [E()]],
        ['rc_04', 'Verificação do filtro de cabine / filtro de ar condicionado', null, [E()]],
        ['rc_05', 'Calibragem dos pneus', null, [FEITO(), M('Pressão aplicada', 'psi')]],
        ['rc_06', 'Calibragem do estepe', null, [FEITO(NT)]],
        ['rc_07', 'Verificar necessidade de troca óleo motor e filtro de óleo', null, [E()]],
        ['rc_08', 'Verificação do nível de água do lavador do para-brisa e aplicação de pastilha', null, [FEITO()]],
      ],
    },
    {
      titulo: 'Elevador',
      itens: [
        ['rc_09', 'Verificação da suspensão dianteira', null, [R()]],
        ['rc_10', 'Verificação da suspensão traseira', null, [R()]],
        ['rc_11', 'Coxim/suportes do motor', null, [R()]],
        ['rc_12', 'Coxim/suportes do câmbio', null, [R()]],
        ['rc_13', 'Teste de folga na caixa de direção', null, [R()]],
        ['rc_14', 'Teste dos sulcos dos pneus via ferramenta LAUNCH', LAUNCH, [F('Foto da tela do Launch')]],
        ['rc_15', 'Remoção das rodas do veículo', null, [FEITO()]],
        ['rc_16', 'Pneus dianteiros — marca', null, [T('Marca')]],
        ['rc_17', 'Pneus dianteiros — medida', 'Ex.: 225/45R18 → largura 225, perfil 45, aro 18.', [...MEDIDA_PNEU, E()]],
        ['rc_18', 'Pneus traseiros — marca', null, [T('Marca')]],
        ['rc_19', 'Pneus traseiros — medida', 'Ex.: 225/45R18 → largura 225, perfil 45, aro 18.', [...MEDIDA_PNEU, E()]],
        ['rc_20', 'Necessita alinhamento e geometria', null, [S()]],
        ['rc_21', 'Necessita rodízio (avaliar se é possível pelas medidas)', null, [S()]],
        ['rc_22', 'Verificar diluição do fluido de arrefecimento', null, [E(), M('Proteção', '°C', false, { min: -80 })]],
        ['rc_23', 'Pressurização do sistema de arrefecimento', null, [{ tipo: 'opcoes', obrigatorio: true, opcoes: ['Tem vazamento', 'Sem vazamento'] }]],
        ['rc_24', 'Verificação do filtro de ar do motor', null, [E()]],
        ['rc_25', 'Verificação das velas de ignição', null, [E(), M('GAP', 'mm', true)]],
        ['rc_26', 'Verificação da membrana PCV', null, [E(NT)]],
        ['rc_27', 'Verificação da correia dentada ou corrente e tensores', null, [E()]],
        ['rc_28', 'Verificação da correia de acessórios', null, [E()]],
        ['rc_29', 'Verificação do fluido de freio (ferramenta)', null, [E(), M('Umidade', '%', false, { max: 100 })]],
        ['rc_30', 'Verificação do óleo de transmissão', null, [E()]],
        ['rc_31', 'Verificação do filtro de combustível', null, [E(NT)]],
        ['rc_32', 'Verificação do fluido de direção', null, [E(NT)]],
        ['rc_33', 'Verificação do óleo da caixa de transferência', null, [E(NT)]],
        ['rc_34', 'Verificação do óleo do diferencial dianteiro', null, [E(NT)]],
        ['rc_35', 'Verificação do óleo do Haldex', null, [E(NT)]],
        ['rc_36', 'Verificação do óleo do diferencial traseiro', null, [E(NT)]],
        ['rc_37', 'Verificar vazamentos (motor, arrefecimento, transmissão, direção, diferencial)',
          'Se houver vazamento, detalhe onde.', [S({ texto_se_sim: true })]],
      ],
    },
    freios('rc_fd', 'dianteiros', ['DE', 'DD']),
    freios('rc_ft', 'traseiros', ['TE', 'TD']),
    FREIO_MAO('rc'),
    PECAS,
  ],
};

exports.REVISAO_BASICA = REVISAO_BASICA;
exports.REVISAO_COMPLETA = REVISAO_COMPLETA;

exports.up = (db) => {
  semearModelo(db, REVISAO_BASICA);
  semearModelo(db, REVISAO_COMPLETA);
  db.exec(`
    -- Links públicos com validade (abrem sem login). O app confere validade e revogação
    -- e só então redireciona para uma URL assinada de 15 min do bucket.
    CREATE TABLE kb_links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT NOT NULL UNIQUE,
      midia_id INTEGER NOT NULL REFERENCES kb_midias(id),
      finalidade TEXT NOT NULL CHECK (finalidade IN ('video_pdf','pdf_cliente')),
      expira_em TEXT NOT NULL,
      revogado_em TEXT,
      revogado_por TEXT,
      criado_por TEXT NOT NULL,
      criado_em TEXT NOT NULL,
      acessos INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX ix_kb_links_midia ON kb_links(midia_id);
  `);
};

exports.down = (db) => {
  db.exec('DROP TABLE IF EXISTS kb_links;');
  for (const codigo of ['revisao_basica', 'revisao_completa']) {
    const ids = db.prepare('SELECT id FROM kb_checklist_modelos WHERE codigo = ?').all(codigo).map((r) => r.id);
    for (const id of ids) {
      if (db.prepare('SELECT 1 FROM kb_checklist_execucoes WHERE modelo_id = ? LIMIT 1').get(id)) {
        throw new Error(`não dá para reverter: já existem checklists feitos com o modelo ${codigo}`);
      }
      db.prepare('DELETE FROM kb_checklist_itens WHERE secao_id IN (SELECT id FROM kb_checklist_secoes WHERE modelo_id = ?)').run(id);
      db.prepare('DELETE FROM kb_checklist_secoes WHERE modelo_id = ?').run(id);
      db.prepare('DELETE FROM kb_checklist_modelos WHERE id = ?').run(id);
    }
  }
};
