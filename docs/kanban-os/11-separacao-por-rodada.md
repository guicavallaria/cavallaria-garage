# Separação de peças por rodada (18/11/2026)

## Por quê

Às vezes um card volta da Separação/Aquisição de peças para o Orçamento. Isso acontece, por exemplo, quando aparece uma demanda nova no meio do serviço.

O problema: até agora, esse card continuava mostrando as "peças a separar" na fase de Orçamento.

## Como ficou

**Cada entrada em Separação/Aquisição abre uma lista nova.**
- As listas são numeradas por card: Separação nº 1, 2, 3…
- A janela da passagem dá só duas opções:
  - **Migrar peças da OS:** lê as peças lançadas na OS do Onmotor novo (`work_order.service_parts`, pela rota `GET /api/kanban/cards/:id/pecas-da-os`) e mostra cada uma com uma caixa para marcar ou desmarcar.
    - Peça não aprovada na OS vem desmarcada.
    - Peça que já esteve numa separação anterior também vem desmarcada.
    - Se o Onmotor não puder ser lido, a lista vem do PDF do orçamento aprovado ou, sem PDF, do pedido de orçamento. Isso vale para a AWDYNA, que segue no sistema antigo, para OS com id antigo e para Onmotor fora do ar.
  - **Informar manualmente:** digitar as peças. A lista pode ficar vazia, para serviço sem peça.
- **Voltar de Aguardando Peças para Separação** continua na mesma lista, porque os pedidos estão em andamento.

**Voltar para Entrada, Diagnóstico, Orçamento ou Aprovação encerra a lista aberta.**
- O card deixa de mostrar as peças a separar ou para pedir.
- A lista encerrada fica no painel do card, em "Separações anteriores", com cada peça na situação em que estava.
- Fica também um registro na linha do tempo.

**Pedido feito que ainda não chegou continua valendo:**
- aparece em "Aguardando chegada";
- no card, aparece como "📦 a chegar";
- entra sozinho na próxima lista.

**Voltar de Separação em diante para o Orçamento** pergunta o que fazer com o orçamento:
- **Manter o orçamento mais recente:** não cria pedido novo.
- **Novo pedido de orçamento:** pede as peças a orçar, com o botão "Trazer do orçamento anterior".

Quem pode mover continua igual: só a movimentação total move um card de Separação para Orçamento.

## Banco

A migração `020_separacoes.js` cria a tabela `kb_separacoes` e a coluna `kb_pecas.separacao_id`.
- **Tabela `kb_separacoes`:** número, modo (`os`, `manual` ou `anterior`), quem abriu e quando, quem encerrou, quando e por quê.
- **Coluna `itens_json`:** guarda como a lista estava ao ser encerrada.
- **Peças que já existiam** viraram a "Separação nº 1" de cada card. Cards que estavam em Entrada, Diagnóstico, Orçamento ou Aprovação tiveram essa lista encerrada na própria migração.

## Testes

`test/kanban_separacoes.test.js`
