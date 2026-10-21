# Agendamento — Cavallaria Garage

App de agendamento da oficina (Node.js + Express + SQLite, frontend em JS puro), em produção no Railway.
Inclui o portal de pós-vendas (`/posvendas`) e o **painel de pátio** (abaixo da agenda).

## Rodar localmente

```bash
npm install
cp .env.example .env   # ajuste APP_PASSWORD etc.
node server.js         # http://localhost:3000
npm test               # testes (node:test, sem dependência extra)
```

## Variáveis de ambiente

| Variável | Obrigatória | Para quê |
|---|---|---|
| `APP_PASSWORD` | sim | senha única de acesso ao app |
| `SESSION_SECRET` | sim | segredo das sessões |
| `DATA_DIR` | no Railway: `/data` | pasta do SQLite, da sessão do WhatsApp e dos relatórios do pós-vendas (volume) |
| `POSVENDAS_UPLOAD_TOKEN` | p/ pós-vendas | token do push dos relatórios semanais |
| `CHROME_PATH` | definido no Dockerfile | Chrome usado pelo WhatsApp |
| `ONMOTOR_USER` / `ONMOTOR_PASS` | p/ painel de pátio | conta do Onmotor usada pelo servidor (somente leitura da aba Novidades). **Nunca commitar.** |
| `ONMOTOR_BASE_URL` | não | padrão `https://cavallaria.onmotor.com.br` |
| `PATIO_SYNC_ENABLED` | não | `false` desliga o job automático (o botão "Sincronizar agora" continua) |
| `PATIO_SYNC_INTERVAL_MIN` | não | intervalo do job (padrão 30). A janela é fixa: **seg–sex, 07:30–19:00, America/Sao_Paulo** |
| `TZ` | recomendado | `America/Sao_Paulo` — o container do Railway roda em UTC |

## Painel de pátio

Mostra, numa TV no pátio e na mesma tela da agenda, **quais veículos estão em serviço e quem é o responsável**.

- **Fonte da verdade:** Onmotor → Serviços → Novidades. Veículo no pátio = OS com data de entrada e sem finalização
  (lido pelos ícones de etapa de cada linha, não pela seção da página).
- **Sincronização:** job in-process a cada 30 min, seg–sex 07:30–19:00 (SP), com lock em tabela para nunca rodar em
  paralelo; botão "Sincronizar agora" no painel. Login HTTP com a conta `ONMOTOR_USER`, cookie persistido em
  `DATA_DIR/onmotor-session.json`, re-login automático. Cada sincronização grava uma linha em `patio_sync_log`
  (`GET /api/patio/logs`). Se a leitura falhar ou a página mudar de layout, o painel **mantém o último estado** e
  mostra o aviso — nunca "zera" o pátio por erro.
- **Deduplicação por placa (regra absoluta):** 1 card por placa normalizada (antiga `ABC1234` ou Mercosul
  `ABC1D23`), OS vinculadas em `patio_vehicle_orders` (1:N). Índice único parcial no banco
  (`placa_normalizada WHERE status='ativo'`). O veículo só sai quando **todas** as OS saírem da Novidades; sai como
  `status='finalizado'` + `finished_at` (histórico), nunca é apagado.
- **Responsável:** select no card. A lista é exatamente a dos profissionais da agenda (`mecanicos` ativos, mesma ordem).
- **Concordância com a agenda (só HOJE):** match por **placa** no texto do veículo do agendamento; sem placa, pelo
  **número da OS**. Se o veículo está na agenda de hoje, a coluna da agenda **prevalece** (`origem_atribuicao='agenda'`)
  e o select do card fica travado com "definido pela agenda". Reavaliado a cada sync e imediatamente ao criar,
  editar, mover, excluir ou puxar um agendamento. Vários agendamentos do mesmo veículo em colunas diferentes →
  vale o mais recente (`atualizado_em`/`criado_em`) e fica um aviso no log. Se o agendamento some, o veículo mantém
  o mecânico mas volta a ser editável.
- **Círculos na agenda (só hoje):** ● verde = o veículo deu entrada (está no pátio, ou esteve e foi finalizado hoje —
  verde até 23:59 SP); ● vermelho = ainda não deu entrada. Outros dias não têm círculo.
- **Ano/cor** não vêm na listagem: são completados a partir da página da OS para veículos novos (até 15 por rodada).
- **Privacidade:** o painel não expõe telefone nem nome completo (só o primeiro nome).

### Por que o job roda dentro do próprio serviço
O banco é SQLite num volume do Railway, que **só um serviço pode montar**. Um cron/worker separado não enxergaria
os dados. Com uma réplica + lock em `patio_sync_lock` não há execução duplicada.

### Migrations
`migrations/` tem um runner mínimo com `up`/`down` (tabela `schema_migrations`), aplicado no boot pelo `db.js`.
Para reverter a última: `node -e "const db=require('./db');require('./migrations').reverter(db)"`.

### Deploy (Railway)
1. Configurar as variáveis acima no serviço (`ONMOTOR_USER`, `ONMOTOR_PASS`, `TZ=America/Sao_Paulo`).
2. Push na `main` → build pelo Dockerfile → a migration `001_patio` roda sozinha no boot.
3. Abrir a agenda; o painel aparece abaixo. Clicar em "Sincronizar agora" na primeira vez (ou esperar o job).
4. Na TV: abrir a agenda, clicar em ⛶ no painel para tela cheia só do pátio.
