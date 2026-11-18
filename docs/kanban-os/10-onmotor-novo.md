# Onmotor novo: kanban e painel de pátio lendo a API (18/11/2026)

## O que aconteceu

O Onmotor da Cavallaria foi refeito entre 17/11/2026 (por volta das 19h) e a manhã de 18/11.
- **Endereço novo:** `https://cavallaria.onmotor.com`, sem o ".br".
- **Telas trocadas:** não existem mais as telas antigas (`table-novidades`, `ipt_*`). Tudo vem de uma API JSON em `/api/v1`.
- **Novidades virou Pátio.**

Desde então, a sincronização do kanban da Cavallaria falhava com "tabela table-novidades não encontrada". A falha era segura: nenhum card foi mexido.

O Onmotor da AWDYNA (`awdyna.onmotor.com.br`) **continua no sistema antigo** e segue lido do jeito de antes.

## Como ficou

| | Cavallaria (novo) | AWDYNA (antigo) |
|---|---|---|
| Cliente | `patio/onmotor-api.js` | `patio/onmotor.js` |
| Login | `POST /api/v1/login`. O token e o device_code vão como cookies e ficam salvos em `DATA_DIR/onmotor-api-session.json` | formulário `/validate-login` |
| Lista de OS | `POST /api/v1/service/core/services-news` (Pátio) | HTML de `/servicos/novidades` |
| OS que saiu da lista | `GET /api/v1/service/core/<uid>` | página da OS |
| Dados do veículo | `vehicle` da OS (chassi, ano, cor…) | modal do cadastro do veículo |

**Quem escolhe o cliente:** `patio/fontes-onmotor.js`.
- O padrão é Cavallaria = `api` e AWDYNA = `html`.
- Para trocar, use `ONMOTOR_CAVALLARIA_TIPO` e `ONMOTOR_AWDYNA_TIPO`.
- **Quando a AWDYNA migrar,** é só pôr `ONMOTOR_AWDYNA_TIPO=api` no Railway, ou mudar o padrão no código.

**A tradução vive em `patio/patio-api.js`.** Ela converte a Pátio para o mesmo formato de linha que o parser antigo devolvia (`osId`, `osNumber`, `etapas`, `datas`, …). Por isso o kanban (`kanban/sync.js`) e o painel (`patio/sync.js`) não mudaram as regras, só a fonte.

| Etapa (antes) | Campo na API |
|---|---|
| entrada | `entry_date` |
| orçamento aprovado | `approved_budget_date` |
| aguardando peça | `awaiting_part_date` |
| em execução | `execution_date` |
| finalizado | `end_date` |
| retirado | `pickup_date` |

**Formatos que mudaram:**
- **Telefone:** chega como "+55(11)98888-7777" e vira "(11)98888-7777", como era antes. Assim o card não registra uma alteração falsa.
- **Id da OS:** era numérico e agora é o `uid` longo.
  - O id novo entra no card na primeira leitura, porque todo card ativo estava na Pátio.
  - Card que sair da Pátio ainda com o id antigo não é conferido nem arquivado; fica um aviso no log.
- **OS cancelada ou excluída:** fica fora da lista. Se ela tinha card, ele segue a regra de "OS inativada", que arquiva depois de 10 minutos.

## Datas sem o ano

A Pátio traz as datas como "18/11 08:59", sem o ano. Já a OS inteira traz "2026-11-18 08:59". Existem OS abertas desde 2024, então adivinhar o ano erraria.

**Como o cliente resolve:**
- Ele lê a OS inteira de cada linha e guarda em cache, por processo.
- A OS só é lida de novo quando o `updated_at` da Pátio muda.

**Onmotor lento:** em 18/11 ele levou cerca de 20 s para a Pátio e cerca de 10 s por OS. Por isso há dois limites:
- cada chamada tem limite de **60 s**;
- a leitura das OS fora do cache para depois de **2 min por rodada**. As que sobrarem entram sem datas nessa rodada, com aviso no log, e são completadas nas próximas.

## Login automático

- O login usa `ONMOTOR_USER`/`ONMOTOR_PASS`, a mesma conta de antes, nas variáveis do Railway.
- O `device_code` que o Onmotor devolve é guardado e mandado nos logins seguintes, como o navegador faz.
- **Se o Onmotor passar a pedir código de verificação (OTP):**
  - o log mostra "o Onmotor pediu código de verificação (OTP)…";
  - nesse caso, libere o login sem código para essa conta, ou informe `ONMOTOR_DEVICE_CODE`.
- Nunca vão para o log: senha, token ou device_code.

## Testes

- `test/onmotor_api.test.js`: login, sessão salva, relogin no 403, OTP, tradução da Pátio, ano das datas, cache, Onmotor lento, kanban e painel lendo pela API.
- `test/helpers/onmotor-api-falso.js`: o servidor falso, com dados inventados.
