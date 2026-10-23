# Kanban de OS — proposta de esquema e dúvidas (antes da Etapa 1)

Data: 23/10/2026 · Base: `main` @ 6145cf9 do repositório `guicavallaria/cavallaria-garage`.

O prompt pede que, antes de implementar, eu liste as dúvidas sobre o código existente e proponha o esquema de banco. Este documento faz as duas coisas.

## Respostas do Guilherme (23/10/2026)

| Dúvida | Decisão |
|---|---|
| Banco | Sem resposta explícita → segue a recomendação: **SQLite** no volume. |
| Carga inicial | **Importar todas as OS abertas.** Ele arquiva à mão as desnecessárias. Depois disso, toda OS nova da Novidades vira card. |
| AWDYNA | **Fora.** |
| Logins | **Recepção** (acesso total) · **Compras** (tudo menos pós-vendas) · **Pátio** (tudo menos pós-vendas) · **Gerência** (acesso total) · **Mecânicos** Edson, Iago, Ronaldy, Matheus e Luiz (**só kanban**). Contas criadas só antes do deploy, como manda o prompt. |
| Mecânico pré-elevador / elevador | **Sempre o mesmo mecânico** faz o checklist inteiro. Pergunta o nome uma vez, no início. |
| Cabeçalho dos PDFs | Folhas "check basico" e "check completo" e logo Cavallaria Garage recebidas. Logo salva em `public/kanban/img/`. |
| Janela do job | **Segunda a sexta, 07:00–19:00**, a cada 2 min. |
| Gmail do Launch | **launchcavallaria@gmail.com** |
| Mecânico responsável do card | Sem resposta → segue a recomendação: reaproveitar a atribuição do pátio, com troca manual. |
| Storage local | Sem resposta → segue a recomendação: MinIO como executável do Windows. |

Consequência para o esquema: `usuarios.perfil` deixa de ser operador/gestor e vira permissões por área (`acesso_agenda`, `acesso_posvendas`, `acesso_kanban`, `gestor_kanban`). Recepção, Compras, Pátio e Gerência são gestores no kanban; mecânicos são operadores. Como Recepção, Compras e Pátio são logins compartilhados, a pergunta "quem está postando?" no aparelho continua necessária.

---

## 1. O que o código existente realmente é (e onde diverge do prompt)

| Tema | Prompt supõe | O que existe hoje |
|---|---|---|
| Banco | "o mesmo **Postgres** do agendamento" | **SQLite** (`better-sqlite3`) num arquivo no volume `/data` do Railway. Não há Postgres. |
| Migrações | versionadas | Já existe runner próprio `migrations/index.js` (up/down, tabela `schema_migrations`), aplicado no boot. Reaproveito. |
| Login | "reaproveitar a autenticação" com perfis | **Senha única compartilhada** (`APP_PASSWORD`), sem usuários. Sessão em memória: todo deploy desloga todo mundo. |
| Leitor da Novidades | reaproveitar | `patio/onmotor.js` (login HTTP + cookie persistido, sem navegador) e `patio/parser.js` (regex na tabela). Lê as 3 seções e as etapas de cada OS. Reaproveito os dois. |
| Chassi | "disponível em toda OS" | **Não aparece na Novidades** nem no texto do veículo da OS. Fica no modal "Informações do veículo" da OS (aba Cadastro, rótulo "Chassis"), carregado por `POST /services` com `method=open-page`, `page=oficina/structure/body/servicos/mais_info_veiculo`, o `id` do veículo (`#ipt_id_veiculo`) e o `token`/`rand` que vêm na própria página da OS. Verificado em 23/10/2026 numa OS real. São 2 requisições por OS nova: a página da OS e o modal. |
| Ano / marca | na OS | Ano só na página da OS. Marca não vem separada: o Onmotor traz "BMW M3", a marca sai da 1ª palavra. |
| Gerar PDF | Playwright ou lib do projeto | O container já tem **Chrome for Testing** e `puppeteer-core` (via whatsapp-web.js). Uso isso, sem dependência nova pesada. |
| Ambiente local | Postgres + MinIO em Docker | Esta máquina **não tem Docker nem Postgres**. |
| Deploy | só no fim | Push na `main` publica sozinho. Todo o trabalho fica na branch `feature/kanban-os` até sua aprovação. |

---

## 2. Dúvidas (as marcadas ⛔ travam a Etapa 1)

1. ⛔ **Banco: SQLite ou Postgres?**
   - **Recomendo manter o SQLite** no mesmo volume. Os dados do kanban são só metadados (texto, respostas, chaves de objeto); toda mídia vai para o bucket, então o volume de 5 GB não é problema. Não cria serviço novo e não mexe na agenda nem no pátio.
   - A alternativa é migrar o app inteiro para Postgres do Railway. Dá mais folga para o futuro, mas obriga a reescrever as consultas da agenda, do pátio e do pós-vendas (better-sqlite3 é síncrono) e a migrar os dados atuais.
   - O esquema abaixo usa tipos portáveis, para a migração futura ficar barata se você escolher SQLite agora.

2. ⛔ **Carga inicial: o que fazer com as OS que já estão abertas no dia em que ligar?** Hoje a Novidades tem cerca de 37 OS abertas na Cavallaria, algumas de 2023–2025.
   - **Recomendo importar todas**, posicionando pela etapa do Onmotor só nessa primeira vez: sem entrada → fase 1; orçamento → fase 3; aguardando peça → fase 5; em andamento → fase 7. Depois disso a fase só muda à mão.
   - Alternativa: criar card só para OS criadas depois de ligar.

3. ⛔ **AWDYNA entra no kanban?** O pátio já lê as duas empresas.
   - **Recomendo só Cavallaria agora.** O esquema já usa a chave (empresa, número da OS), porque os números se repetem entre as duas (ex.: OS 733).

4. ✅ **Onde fica o chassi na página da OS?** Resolvido em 23/10/2026 (ver tabela da seção 1). Falta só confirmar na Etapa 1, com o fixture anonimizado, que o formato do corpo do `POST /services` funciona pelo cliente HTTP do app.

5. **Login individual.** Os perfis Operador/Gestor exigem um login por pessoa.
   - A agenda e o pós-vendas passam a usar esse mesmo login individual? A TV do pátio continua com um login fixo, tipo "TV Pátio"?
   - **Recomendo:** login individual para tudo, e a senha única antiga desativada no deploy. Sessão passa a ser gravada no banco, para o deploy não deslogar ninguém.
   - O prompt diz para criar as contas só no fim; mantenho isso.

6. **"Nome do operador" em cada postagem.** Com login individual, o nome viria do próprio login.
   - O prompt pede para perguntar o nome e lembrar no aparelho, o que sugere celulares compartilhados.
   - **Recomendo:** usar o nome do login por padrão, com a opção "Trocar operador" para aparelho compartilhado (lista dos usuários + campo livre).

7. **Mecânico responsável do card.** O pátio já atribui mecânico por placa (vindo da agenda de hoje ou manual).
   - **Recomendo reaproveitar** essa atribuição no filtro do kanban, com troca manual pelo Vanilton dentro do card.
   - Alternativa: campo próprio do kanban, independente do pátio.
   - O prompt fala em 4 mecânicos. No cadastro estão Edson, Matheus, Luiz Paulo, Iago, Ronaldy e Caio. Confirme quem preenche checklist.

8. **Mecânico do pré-elevador e do elevador.** Nas folhas, cada parte pergunta o mecânico responsável. Podem ser duas pessoas diferentes na mesma revisão?
   - **Recomendo:** perguntar no início de cada parte, já sugerindo o mesmo nome da parte anterior.

9. **Storage no desenvolvimento.** Sem Docker, as opções são:
   - **MinIO como executável do Windows** (um arquivo `.exe`, sem Docker). Recomendo este.
   - Ou um bucket de desenvolvimento no Cloudflare R2 (plano gratuito, exige sua conta).
   - Para produção (Railway Buckets ou R2), decidimos antes do deploy, como o prompt manda.

10. **Cabeçalho dos PDFs.** Já tenho do projeto de termos: razão social, CNPJ 07.954.296/0001-29, Av. Tupi 268, telefone (46) 2604-0612 e e-mail. Preciso de:
    - uma cópia das **folhas atuais** de checklist (PDF ou foto), para copiar o layout do cabeçalho e a ordem dos itens;
    - o **arquivo da logo Cavallaria Garage**. A pasta de vetores tem só a Cavallaria Detail.

11. **Gmail do Launch (só na Etapa 6, não trava agora).** Qual caixa recebe os relatórios? Vai ser preciso criar um projeto no Google Cloud com cliente OAuth; eu passo o passo a passo quando chegar lá.

12. **Janela do job do Onmotor.** O pátio roda seg–sex, 07:30–19:00. **Proponho para o kanban seg–sáb, 07:00–19:00, a cada 2 min**, para pegar OS criadas no sábado. Confirme.

---

## 3. Decisões de projeto que tomei (diga se discorda)

- **Uma leitura da Novidades a cada 2 min** pelo mesmo cliente HTTP e mesmo cookie do pátio. O pátio continua no seu ritmo de 30 min.
- **A Novidades é uma foto, não uma lista de eventos.** "OS criada / alterada / finalizada" sai da comparação com o estado anterior de cada OS. Em `onmotor_eventos` gravo uma linha só quando algo da OS mudou (hash), senão seriam ~10 mil linhas por dia.
- **Chassi:** a página da OS e o modal do veículo são lidos uma vez por OS nova (e de novo se o veículo da OS mudar), com limite por rodada, como o pátio já faz. Card sem chassi ainda é criado normalmente e o chassi entra na rodada seguinte.
- **OS que some da Novidades:** a seção "finalizados" só guarda OS por um tempo. Se um card ativo some da página (ex.: o job ficou parado), leio a página da OS para confirmar se foi finalizada, em vez de supor.
- **Falha de leitura nunca altera cards.** Mostra o banner "Sincronização com Onmotor parada desde hh:mm" e registra o erro.
- **Links de PDF para o cliente (7 dias, revogáveis):** URL assinada do S3 não pode ser revogada. O link enviado ao cliente aponta para o app (`/p/<token>`), que confere validade e revogação e só então redireciona para uma URL assinada de 15 min.
- **Datas** gravadas em UTC (ISO 8601) e exibidas em `America/Sao_Paulo`, formato dd/mm/aaaa hh:mm.
- **Vídeo de 2 min:** o `<input capture>` não limita a gravação. O app lê a duração depois de gravar e recusa acima de 2 min, com aviso de tamanho.
- **Uploads:** linha `pendente` no banco → PUT direto no bucket → confirmação no servidor (HEAD no objeto) → `enviado`. Fila local no navegador (IndexedDB) com retentativa.
- **Modelos de checklist versionados:** cada execução guarda a versão do modelo usada. Editar o modelo depois não altera checklists já feitos.

---

## 4. Esquema proposto

Convenções: tabelas novas com prefixo `kb_` para não colidir com agenda e pátio. `id INTEGER PRIMARY KEY` (vira `BIGSERIAL` se for Postgres). Datas em `TEXT` ISO UTC. JSON em `TEXT`. Nada é apagado: registros têm `removido_em`/`removido_por`.

### 4.1 Usuários e sessão (Etapa 7, mas o desenho influencia tudo)

```sql
CREATE TABLE usuarios (
  id INTEGER PRIMARY KEY,
  nome TEXT NOT NULL,
  login TEXT NOT NULL UNIQUE,
  senha_hash TEXT NOT NULL,              -- bcryptjs (já é dependência)
  perfil TEXT NOT NULL CHECK (perfil IN ('operador','gestor')),
  mecanico_id INTEGER REFERENCES mecanicos(id),   -- liga ao cadastro da agenda, se for mecânico
  ativo INTEGER NOT NULL DEFAULT 1,
  criado_em TEXT NOT NULL
);

CREATE TABLE sessoes (                    -- store do express-session no banco
  sid TEXT PRIMARY KEY,
  dados TEXT NOT NULL,
  expira_em TEXT NOT NULL
);
```

### 4.2 Veículos, cards e fases

```sql
CREATE TABLE kb_fases (
  id INTEGER PRIMARY KEY,                -- 1..9 fixos
  nome TEXT NOT NULL,
  ordem INTEGER NOT NULL UNIQUE
);
-- seed: 1 Aguardando Entrada · 2 Avaliação/Diagnóstico · 3 Orçamento · 4 Aprovação de Orçamento
--       5 Aquisição de Peças · 6 Aguardando Agendamento · 7 Execução de Serviço · 8 Teste do Veículo
--       9 Veículo Pronto / Aguardando Retirada

CREATE TABLE veiculos (                   -- placa ↔ chassi, alimentada ao longo do uso
  id INTEGER PRIMARY KEY,
  chassi TEXT NOT NULL UNIQUE CHECK (length(chassi) = 17),   -- sempre maiúsculas
  placa_normalizada TEXT,
  marca TEXT, modelo TEXT, ano TEXT,
  primeiro_visto_em TEXT NOT NULL,
  ultimo_visto_em TEXT NOT NULL
);
CREATE INDEX ix_veiculos_placa ON veiculos(placa_normalizada);

CREATE TABLE kb_cards (
  id INTEGER PRIMARY KEY,
  empresa TEXT NOT NULL DEFAULT 'cavallaria',
  os_numero TEXT NOT NULL,
  os_id_interno TEXT,                     -- id da URL /servicos/visualizar/{id}
  veiculo_id INTEGER REFERENCES veiculos(id),
  -- espelho somente leitura do Onmotor
  placa TEXT, placa_normalizada TEXT, marca TEXT, modelo TEXT, ano TEXT, chassi TEXT,
  cliente_nome TEXT, cliente_telefone TEXT,
  os_entrada_em TEXT,                     -- data/hora de entrada no Onmotor
  os_etapas TEXT,                         -- JSON das etapas lidas (orçamento, peça, andamento…)
  os_finalizada_em TEXT,                  -- preenchido quando o Onmotor finaliza
  onmotor_atualizado_em TEXT,
  -- andamento (fonte da verdade = kanban)
  fase_id INTEGER NOT NULL REFERENCES kb_fases(id),
  fase_desde TEXT NOT NULL,
  mecanico_id INTEGER REFERENCES mecanicos(id),
  arquivado_em TEXT,                      -- NULL = ativo
  arquivado_por TEXT,                     -- nome do operador ou 'automático'
  arquivado_motivo TEXT CHECK (arquivado_motivo IN ('manual','automatico')),
  criado_em TEXT NOT NULL,
  UNIQUE (empresa, os_numero)             -- idempotência do sync
);
CREATE INDEX ix_kb_cards_ativos ON kb_cards(arquivado_em, fase_id);
CREATE INDEX ix_kb_cards_chassi ON kb_cards(chassi);
CREATE INDEX ix_kb_cards_placa  ON kb_cards(placa_normalizada);
```

Desarquivar limpa `arquivado_*`. O card volta à `fase_id` em que estava, porque a fase não muda ao arquivar.

### 4.3 Linha do tempo e mídias

```sql
CREATE TABLE kb_midias (
  id INTEGER PRIMARY KEY,
  chave_objeto TEXT NOT NULL UNIQUE,     -- ex.: cards/{card}/{uuid}.jpg
  tipo TEXT NOT NULL CHECK (tipo IN ('foto','video','audio','pdf')),
  mime TEXT NOT NULL,
  tamanho_bytes INTEGER,
  duracao_s REAL, largura INTEGER, altura INTEGER,
  card_id INTEGER NOT NULL REFERENCES kb_cards(id),
  checklist_execucao_id INTEGER REFERENCES kb_checklist_execucoes(id),
  checklist_item_id INTEGER REFERENCES kb_checklist_itens(id),   -- mídia de item nunca fica solta
  avaria_id INTEGER REFERENCES kb_checklist_avarias(id),
  status TEXT NOT NULL DEFAULT 'pendente' CHECK (status IN ('pendente','enviado','falhou')),
  autor_nome TEXT NOT NULL, usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL, enviado_em TEXT,
  removido_em TEXT, removido_por TEXT
);

CREATE TABLE kb_eventos (                 -- a linha do tempo do card
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES kb_cards(id),
  tipo TEXT NOT NULL CHECK (tipo IN (
    'criado','texto','foto','video','audio','fase',
    'checklist_iniciado','checklist_finalizado','checklist_editado',
    'pdf','launch','arquivado','desarquivado','os_finalizada_onmotor','os_alterada_onmotor')),
  texto TEXT,                              -- texto atual (editável)
  dados TEXT,                              -- JSON: {de, para}, {execucao_id}, {pdf_id}…
  midia_id INTEGER REFERENCES kb_midias(id),
  operador_nome TEXT NOT NULL,             -- 'Sistema' nos automáticos
  usuario_id INTEGER REFERENCES usuarios(id),
  criado_em TEXT NOT NULL,
  editado_em TEXT,
  removido_em TEXT, removido_por TEXT      -- oculto, mas auditável
);
CREATE INDEX ix_kb_eventos_card ON kb_eventos(card_id, criado_em DESC);

CREATE TABLE kb_eventos_versoes (          -- histórico das edições de texto
  id INTEGER PRIMARY KEY,
  evento_id INTEGER NOT NULL REFERENCES kb_eventos(id),
  texto_anterior TEXT,
  editado_por TEXT NOT NULL,
  editado_em TEXT NOT NULL
);
```

### 4.4 Checklists (modelo)

Cada item tem uma lista de **componentes** de resposta. Isso cobre as combinações das folhas (E + M + F, E + NT, S + texto obrigatório…) sem um tipo novo para cada caso, e a tela de administração edita só isso.

```sql
CREATE TABLE kb_checklist_modelos (
  id INTEGER PRIMARY KEY,
  codigo TEXT NOT NULL,                    -- 'entrada' | 'revisao_basica' | 'revisao_completa'
  versao INTEGER NOT NULL,
  nome TEXT NOT NULL,
  ativo INTEGER NOT NULL DEFAULT 1,        -- só uma versão ativa por código
  criado_em TEXT NOT NULL, criado_por TEXT,
  UNIQUE (codigo, versao)
);

CREATE TABLE kb_checklist_secoes (
  id INTEGER PRIMARY KEY,
  modelo_id INTEGER NOT NULL REFERENCES kb_checklist_modelos(id),
  ordem INTEGER NOT NULL,
  titulo TEXT NOT NULL,                    -- 'Inspeção pré-elevador', 'Elevador', 'Freios dianteiros'…
  pede_responsavel INTEGER NOT NULL DEFAULT 0,
  tipo TEXT NOT NULL DEFAULT 'itens' CHECK (tipo IN ('itens','fotos_obrigatorias','avarias','pecas_defeituosas'))
);

CREATE TABLE kb_checklist_itens (
  id INTEGER PRIMARY KEY,
  secao_id INTEGER NOT NULL REFERENCES kb_checklist_secoes(id),
  ordem INTEGER NOT NULL,
  codigo TEXT NOT NULL,                    -- estável entre versões, ex.: 'rc_25_velas'
  texto TEXT NOT NULL,
  instrucao TEXT,                          -- texto de enquadramento da foto (vistoria)
  componentes TEXT NOT NULL                -- JSON, ver exemplos abaixo
);
```

Exemplos de `componentes`:

```jsonc
// RC 25 — velas: E + M (GAP em mm, obrigatório)
[{"tipo":"estado","escala":"troca"},
 {"tipo":"medida","rotulo":"GAP","unidade":"mm","obrigatorio":true}]

// RB 6 — folga suspensão dianteira: R (descrição obrigatória se "Necessita reparo")
[{"tipo":"estado","escala":"reparo","descricao_se_reparo":true}]

// RC 31 — filtro de combustível: E + NT
[{"tipo":"estado","escala":"troca","nao_tem":true}]

// RC 1 — bateria: E + M (V, CCA, opcionais) + F (foto do testador)
[{"tipo":"estado","escala":"troca"},
 {"tipo":"medida","rotulo":"Tensão","unidade":"V"},{"tipo":"medida","rotulo":"CCA","unidade":"A"},
 {"tipo":"foto","obrigatorio":true,"rotulo":"Foto do testador"}]

// RC 23 — pressurização
[{"tipo":"opcoes","opcoes":["Tem vazamento","Sem vazamento"]}]

// RC 37 — vazamentos: S + texto obrigatório se Sim
[{"tipo":"sim_nao","texto_se_sim":true}]

// Vistoria 1 — painel/odômetro: foto obrigatória + KM digitado
[{"tipo":"foto","obrigatorio":true},{"tipo":"medida","rotulo":"KM","unidade":"km","obrigatorio":true,"inteiro":true}]
```

Tipos de componente: `estado` (escala `troca` = Bom/Regular/Necessita troca, `reparo` = Bom/Regular/Necessita reparo), `sim_nao`, `feito`, `medida`, `texto`, `foto`, `opcoes`, mais as flags `nao_tem`, `descricao_se_reparo`, `texto_se_sim`, `obrigatorio`. Medidas de disco, GAP e pneus são campos numéricos.

Os três modelos entram por migração, na ordem exata das seções 7, 8 e 9 do prompt.

### 4.5 Checklists (execução)

```sql
CREATE TABLE kb_checklist_execucoes (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES kb_cards(id),
  modelo_id INTEGER NOT NULL REFERENCES kb_checklist_modelos(id),   -- versão congelada
  status TEXT NOT NULL CHECK (status IN ('em_andamento','finalizado')),
  feito_por TEXT NOT NULL,                 -- "Quem está fazendo este checklist?"
  responsaveis TEXT,                       -- JSON {secao_id: nome} (pré-elevador / elevador)
  iniciado_em TEXT NOT NULL,
  finalizado_em TEXT,
  ultimo_item_id INTEGER                   -- para retomar de onde parou
);

CREATE TABLE kb_checklist_respostas (      -- salva item a item, nunca só no final
  id INTEGER PRIMARY KEY,
  execucao_id INTEGER NOT NULL REFERENCES kb_checklist_execucoes(id),
  item_id INTEGER NOT NULL REFERENCES kb_checklist_itens(id),
  valor TEXT NOT NULL,                     -- JSON {estado, medidas:{GAP:0.8}, sim_nao, texto, nao_tem, descricao}
  respondido_por TEXT NOT NULL,
  respondido_em TEXT NOT NULL,
  versao INTEGER NOT NULL DEFAULT 1,
  UNIQUE (execucao_id, item_id)
);

CREATE TABLE kb_checklist_respostas_hist ( -- toda edição guarda a versão anterior
  id INTEGER PRIMARY KEY,
  resposta_id INTEGER NOT NULL REFERENCES kb_checklist_respostas(id),
  versao INTEGER NOT NULL,
  valor_anterior TEXT NOT NULL,
  alterado_por TEXT NOT NULL,
  alterado_em TEXT NOT NULL
);

CREATE TABLE kb_checklist_comentarios (    -- comentários por item, em ordem cronológica
  id INTEGER PRIMARY KEY,
  execucao_id INTEGER NOT NULL REFERENCES kb_checklist_execucoes(id),
  item_id INTEGER NOT NULL REFERENCES kb_checklist_itens(id),
  texto TEXT NOT NULL,
  autor_nome TEXT NOT NULL, criado_em TEXT NOT NULL,
  removido_em TEXT, removido_por TEXT
);

CREATE TABLE kb_checklist_avarias (        -- vistoria de entrada: laço "Tem outra avaria?"
  id INTEGER PRIMARY KEY,
  execucao_id INTEGER NOT NULL REFERENCES kb_checklist_execucoes(id),
  ordem INTEGER NOT NULL,
  regiao TEXT NOT NULL,                    -- lista fixa do prompt + 'outro'
  descricao TEXT NOT NULL,
  criado_por TEXT NOT NULL, criado_em TEXT NOT NULL,
  removido_em TEXT, removido_por TEXT
);
-- a foto da avaria é uma kb_midias com avaria_id

CREATE TABLE kb_checklist_pecas (          -- "Peças defeituosas — descrição — tempo de troca"
  id INTEGER PRIMARY KEY,
  execucao_id INTEGER NOT NULL REFERENCES kb_checklist_execucoes(id),
  item_id INTEGER REFERENCES kb_checklist_itens(id),   -- NULL = linha manual
  origem TEXT NOT NULL CHECK (origem IN ('automatica','manual')),
  descricao TEXT,
  tempo_troca_horas REAL,
  ordem INTEGER NOT NULL,
  atualizado_por TEXT, atualizado_em TEXT,
  removido_em TEXT, removido_por TEXT
);
```

Combustível (em quartos) e itens presentes da vistoria são itens comuns do modelo de entrada (`opcoes` e `feito`), sem tabela própria.

### 4.6 PDFs gerados

```sql
CREATE TABLE kb_pdfs (
  id INTEGER PRIMARY KEY,
  card_id INTEGER NOT NULL REFERENCES kb_cards(id),
  tipo TEXT NOT NULL CHECK (tipo IN ('vistoria_entrada','revisao_basica','revisao_completa')),
  execucao_id INTEGER REFERENCES kb_checklist_execucoes(id),
  versao INTEGER NOT NULL,                 -- gerar de novo cria versão nova; as antigas ficam
  midia_id INTEGER NOT NULL REFERENCES kb_midias(id),
  gerado_por TEXT NOT NULL, gerado_em TEXT NOT NULL,
  UNIQUE (execucao_id, versao)
);

CREATE TABLE kb_pdf_links (                -- link de 7 dias para o cliente, revogável
  id INTEGER PRIMARY KEY,
  pdf_id INTEGER NOT NULL REFERENCES kb_pdfs(id),
  token TEXT NOT NULL UNIQUE,              -- aleatório, 32+ bytes
  expira_em TEXT NOT NULL,
  revogado_em TEXT, revogado_por TEXT,
  criado_por TEXT NOT NULL, criado_em TEXT NOT NULL
);
```

### 4.7 Onmotor

```sql
CREATE TABLE onmotor_eventos (             -- payload bruto, auditoria e reprocessamento
  id INTEGER PRIMARY KEY,
  empresa TEXT NOT NULL,
  os_numero TEXT NOT NULL,
  os_id_interno TEXT,
  tipo TEXT NOT NULL CHECK (tipo IN ('criada','alterada','finalizada','sumiu','detalhe_os')),
  payload TEXT NOT NULL,                   -- linha da Novidades (ou trecho da OS) como lido
  hash TEXT NOT NULL,                      -- grava só quando muda
  lido_em TEXT NOT NULL,
  processado INTEGER NOT NULL DEFAULT 0,
  processado_em TEXT,
  erro TEXT
);
CREATE INDEX ix_onmotor_eventos_os ON onmotor_eventos(empresa, os_numero, lido_em);
CREATE INDEX ix_onmotor_eventos_pend ON onmotor_eventos(processado);

CREATE TABLE kb_sync_log (                  -- alimenta o banner "Sincronização parada desde…"
  id INTEGER PRIMARY KEY,
  iniciado_em TEXT NOT NULL, terminado_em TEXT,
  sucesso INTEGER NOT NULL DEFAULT 0,
  os_lidas INTEGER, cards_criados INTEGER, cards_atualizados INTEGER, cards_arquivados INTEGER,
  erro TEXT                                 -- sem dados de cliente
);
```

O lock do job reaproveita o padrão do `patio_sync_lock` (uma linha com validade).

### 4.8 Launch

```sql
CREATE TABLE launch_emails (
  message_id TEXT PRIMARY KEY,             -- id do Gmail
  recebido_em TEXT NOT NULL,
  assunto TEXT, remetente TEXT,
  processado_em TEXT,
  status TEXT NOT NULL CHECK (status IN ('ok','sem_anexo','erro')),
  erro TEXT
);

CREATE TABLE launch_relatorios (
  id INTEGER PRIMARY KEY,
  origem TEXT NOT NULL CHECK (origem IN ('email','manual')),
  message_id TEXT REFERENCES launch_emails(message_id),
  nome_arquivo TEXT NOT NULL,
  marca TEXT, chassi TEXT,                 -- extraídos do nome do arquivo (VIN 17, maiúsculas)
  relatorio_em TEXT NOT NULL,              -- data/hora do e-mail (ou do upload manual)
  midia_id INTEGER NOT NULL,               -- PDF no bucket (sem card ainda: chave em launch/)
  card_id INTEGER REFERENCES kb_cards(id), -- NULL = "Relatórios não vinculados"
  principal INTEGER NOT NULL DEFAULT 0,    -- o mais próximo da entrada da OS
  vinculado_em TEXT, vinculado_por TEXT    -- 'automático' ou nome do gestor
);
CREATE INDEX ix_launch_chassi ON launch_relatorios(chassi);
CREATE INDEX ix_launch_card ON launch_relatorios(card_id);
```

Como o PDF do Launch pode existir antes do card, `kb_midias.card_id` precisa aceitar NULL nesse caso. Ajusto isso na migração: `card_id` fica opcional e uma regra no código exige card para foto/vídeo/áudio.

### 4.9 Auditoria

```sql
CREATE TABLE auditoria (
  id INTEGER PRIMARY KEY,
  quando TEXT NOT NULL,
  usuario_id INTEGER REFERENCES usuarios(id),
  usuario_nome TEXT NOT NULL,
  acao TEXT NOT NULL,                      -- card_criado, fase_alterada, checklist_editado, card_arquivado, pdf_baixado, link_revogado…
  card_id INTEGER REFERENCES kb_cards(id),
  entidade TEXT, entidade_id INTEGER,
  detalhes TEXT                            -- JSON sem dados pessoais do cliente
);
CREATE INDEX ix_auditoria_card ON auditoria(card_id, quando);
```

---

## 5. Plano de migrações

| Arquivo | Etapa | Conteúdo |
|---|---|---|
| `003_kanban_base.js` | 1 | `kb_fases` (seed), `veiculos`, `kb_cards`, `kb_eventos`, `kb_eventos_versoes`, `onmotor_eventos`, `kb_sync_log`, lock |
| `004_kanban_midias.js` | 3 | `kb_midias` |
| `005_checklists.js` | 4 e 5 | modelos, seções, itens, execuções, respostas, histórico, comentários, avarias, peças + seed dos 3 modelos |
| `006_pdfs.js` | 4 | `kb_pdfs`, `kb_pdf_links` |
| `007_launch.js` | 6 | `launch_emails`, `launch_relatorios` |
| `008_usuarios_auditoria.js` | 7 | `usuarios`, `sessoes`, `auditoria` |

Todas com `up` e `down`, no runner que já existe, com testes em `node:test` como o pátio.
