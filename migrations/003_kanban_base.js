// Kanban de OS — Etapa 1: fases, veículos (placa ↔ chassi), cards, linha do tempo,
// eventos brutos do Onmotor, log e lock da sincronização.
//
// Convenções do kanban (diferentes do pátio, que grava hora de SP):
//   - datas em TEXT ISO 8601 UTC ("2026-10-23T14:05:00.000Z"); a tela converte para SP;
//   - nada é apagado: registros têm removido_em / removido_por;
//   - chave do card = (empresa, os_numero) — a sincronização é idempotente.
const FASES = [
  [1, 'Aguardando Entrada'],
  [2, 'Avaliação/Diagnóstico'],
  [3, 'Orçamento'],
  [4, 'Aprovação de Orçamento'],
  [5, 'Aquisição de Peças'],
  [6, 'Aguardando Agendamento'],
  [7, 'Execução de Serviço'],
  [8, 'Teste do Veículo'],
  [9, 'Veículo Pronto / Aguardando Retirada'],
];

exports.FASES = FASES;

exports.up = (db) => {
  db.exec(`
    CREATE TABLE kb_fases (
      id INTEGER PRIMARY KEY,
      nome TEXT NOT NULL,
      ordem INTEGER NOT NULL UNIQUE
    );

    CREATE TABLE veiculos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      chassi TEXT NOT NULL UNIQUE CHECK (length(chassi) = 17 AND chassi = upper(chassi)),
      placa_normalizada TEXT,
      marca TEXT,
      modelo TEXT,
      ano TEXT,
      primeiro_visto_em TEXT NOT NULL,
      ultimo_visto_em TEXT NOT NULL
    );
    CREATE INDEX ix_veiculos_placa ON veiculos(placa_normalizada);

    CREATE TABLE kb_cards (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa TEXT NOT NULL DEFAULT 'cavallaria',
      os_numero TEXT NOT NULL,
      os_id_interno TEXT,
      veiculo_id INTEGER REFERENCES veiculos(id),

      -- espelho somente leitura do Onmotor
      placa TEXT,
      placa_normalizada TEXT,
      marca TEXT,
      modelo TEXT,
      ano TEXT,
      chassi TEXT,
      km TEXT,
      cliente_nome TEXT,
      cliente_telefone TEXT,
      veiculo_detalhes TEXT,              -- JSON do cadastro do veículo (motor, cor, portas…)
      os_entrada_em TEXT,
      os_etapas TEXT,                     -- JSON {entrada, orcamento, aguardandoPeca, emExecucao, finalizado, retirado}
      os_finalizada_em TEXT,              -- preenchido quando o Onmotor finaliza a OS
      os_hash TEXT,                       -- hash da última leitura (detecta "OS alterada")
      os_visto_em TEXT,                   -- última vez que apareceu na Novidades
      os_sumiu_em TEXT,                   -- saiu da Novidades sem estar finalizada
      os_verificada_em TEXT,              -- última conferência na página da OS (OS sumida)
      detalhes_ok INTEGER NOT NULL DEFAULT 0,
      detalhes_tentativas INTEGER NOT NULL DEFAULT 0,
      detalhes_erro TEXT,

      -- andamento (fonte da verdade = kanban)
      fase_id INTEGER NOT NULL REFERENCES kb_fases(id),
      fase_desde TEXT NOT NULL,
      mecanico_id INTEGER REFERENCES mecanicos(id),
      arquivado_em TEXT,                  -- NULL = ativo
      arquivado_por TEXT,
      arquivado_motivo TEXT CHECK (arquivado_motivo IN ('manual','automatico')),
      auto_arquivar_bloqueado INTEGER NOT NULL DEFAULT 0, -- desarquivado à mão: o sync não arquiva de novo
      origem TEXT NOT NULL DEFAULT 'sync' CHECK (origem IN ('carga_inicial','sync','manual')),
      criado_em TEXT NOT NULL,
      atualizado_em TEXT NOT NULL,
      UNIQUE (empresa, os_numero)
    );
    CREATE INDEX ix_kb_cards_ativos ON kb_cards(arquivado_em, fase_id);
    CREATE INDEX ix_kb_cards_chassi ON kb_cards(chassi);
    CREATE INDEX ix_kb_cards_placa ON kb_cards(placa_normalizada);

    CREATE TABLE kb_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      card_id INTEGER NOT NULL REFERENCES kb_cards(id),
      tipo TEXT NOT NULL CHECK (tipo IN (
        'criado','texto','foto','video','audio','fase',
        'checklist_iniciado','checklist_finalizado','checklist_editado',
        'pdf','launch','arquivado','desarquivado',
        'os_finalizada_onmotor','os_alterada_onmotor')),
      texto TEXT,
      dados TEXT,
      midia_id INTEGER,
      operador_nome TEXT NOT NULL,
      usuario_id INTEGER,
      criado_em TEXT NOT NULL,
      editado_em TEXT,
      removido_em TEXT,
      removido_por TEXT
    );
    CREATE INDEX ix_kb_eventos_card ON kb_eventos(card_id, criado_em);

    CREATE TABLE kb_eventos_versoes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      evento_id INTEGER NOT NULL REFERENCES kb_eventos(id),
      texto_anterior TEXT,
      editado_por TEXT NOT NULL,
      editado_em TEXT NOT NULL
    );

    CREATE TABLE onmotor_eventos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      empresa TEXT NOT NULL,
      os_numero TEXT NOT NULL,
      os_id_interno TEXT,
      tipo TEXT NOT NULL CHECK (tipo IN ('criada','alterada','finalizada','sumiu','ignorada','detalhe_os')),
      payload TEXT NOT NULL,
      hash TEXT NOT NULL,
      lido_em TEXT NOT NULL,
      processado INTEGER NOT NULL DEFAULT 0,
      processado_em TEXT,
      erro TEXT
    );
    CREATE INDEX ix_onmotor_eventos_os ON onmotor_eventos(empresa, os_numero, lido_em);
    CREATE INDEX ix_onmotor_eventos_pend ON onmotor_eventos(processado);

    CREATE TABLE kb_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      origem TEXT NOT NULL DEFAULT 'auto',
      iniciado_em TEXT NOT NULL,
      terminado_em TEXT,
      sucesso INTEGER NOT NULL DEFAULT 0,
      os_lidas INTEGER NOT NULL DEFAULT 0,
      cards_criados INTEGER NOT NULL DEFAULT 0,
      cards_atualizados INTEGER NOT NULL DEFAULT 0,
      cards_finalizados INTEGER NOT NULL DEFAULT 0,
      cards_arquivados INTEGER NOT NULL DEFAULT 0,
      detalhes_lidos INTEGER NOT NULL DEFAULT 0,
      avisos TEXT,
      erro TEXT                           -- sem dados de cliente
    );

    CREATE TABLE kb_sync_lock (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      ate TEXT NOT NULL,
      dono TEXT
    );

    CREATE TABLE kb_estado (
      chave TEXT PRIMARY KEY,
      valor TEXT NOT NULL
    );
  `);
  const ins = db.prepare('INSERT INTO kb_fases (id, nome, ordem) VALUES (?, ?, ?)');
  for (const [id, nome] of FASES) ins.run(id, nome, id);
};

exports.down = (db) => {
  db.exec(`
    DROP TABLE IF EXISTS kb_estado;
    DROP TABLE IF EXISTS kb_sync_lock;
    DROP TABLE IF EXISTS kb_sync_log;
    DROP TABLE IF EXISTS onmotor_eventos;
    DROP TABLE IF EXISTS kb_eventos_versoes;
    DROP TABLE IF EXISTS kb_eventos;
    DROP TABLE IF EXISTS kb_cards;
    DROP TABLE IF EXISTS veiculos;
    DROP TABLE IF EXISTS kb_fases;
  `);
};
