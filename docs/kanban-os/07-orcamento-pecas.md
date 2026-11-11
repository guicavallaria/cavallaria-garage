# Kanban de OS — setor de orçamento e peças e aprovação de orçamento

Pedido do Guilherme em 11/11/2026. Código: `kanban/fluxo.js` (regras), `kanban/acoes.js` (`moverCard` + exigências),
`public/kanban/fluxo.js` (telas e janelas), migração `014_orcamento_pecas.js`. Testes: `test/kanban_fluxo.test.js`.

## Fase nova

**Aguardando Peças** (id 10), entre Aquisição de Peças e Aguardando Agendamento. A ordem na tela vem de
`kb_fases.ordem`; a numeração mostrada (1 a 10) segue essa ordem, não o id.

## Quem move cards — "Papel no kanban" (Administração → Usuários)

| Papel | Quem | Pode mover |
|---|---|---|
| Movimentação total | Guilherme, Lucas, Vanilton | qualquer card para qualquer fase (com as mesmas exigências) |
| Orçamento e peças | Cauã | Orçamento → Aprovação · Aquisição → Aguardando Peças ou Agendamento · Aguardando Peças → Agendamento ou Aquisição |
| Aprovação de orçamento | Luan | Aprovação → Aquisição (integral/parcial) ou de volta ao Orçamento |
| Só registros | todos os demais (mecânicos inclusive) | não movem; registram texto, fotos, checklists |

O papel é do **login** (lido do banco a cada ação; mudou na Administração, vale na hora). Conta usada por várias
pessoas dá o mesmo papel a todas — para a regra valer por pessoa, cada um precisa de login próprio.
Papel inicial da migração — contas de setor (Guilherme, 11/11/2026): `compras` (Cauã) → orçamento e peças,
`patio` (Vanilton) → total, `recepcao` (Luan) → aprovação, `gerencia` (Guilherme e Lucas) → total.
Logins individuais pelo primeiro nome (Guilherme/Lucas/Vanilton → total, Cauã → orçamento, Luan → aprovação);
o resto (mecânicos inclusive) fica "Só registros".

## O que cada passagem exige (para todos os papéis)

| Passagem | Exigência | Cancelou? |
|---|---|---|
| qualquer → Orçamento | lista de peças (trazidas do checklist e/ou digitadas) — vira uma solicitação em `kb_orcamentos` | card fica onde está |
| qualquer → Aprovação | PDF do orçamento (sobe por `POST /cards/:id/orcamento-pdf?tipo=orcamento`) | idem |
| Aprovação → Aquisição | aprovado **integral** (nada a anexar) ou **parcial** (PDF da nova via do cliente); observação opcional | idem |
| Aprovação → Orçamento | motivo (obrigatório) + peças (vêm as da solicitação anterior) | idem |
| qualquer → Aguardando Peças | prazo em dias (1–365) → `kb_cards.pecas_prazo_em`; sair da fase limpa o prazo | idem |

O PDF entra na linha do tempo junto com o evento de mudança de fase (com "Abrir PDF" e "⬇ Baixar").

## Telas

- **Orçamento e peças** (padrão do Cauã): painel de controle (quantos cards em cada fase) + alertas em destaque
  — prazo de peças vencido, sem movimentação entre fases (+1 dia em Orçamento/Aquisição), sem evolução
  (nenhum registro há +24 h) — e as três fases com cards grandes, do mais antigo na fase para o mais novo,
  tempo na fase em dias-horas-minutos e botões de ação direto no card.
- **Aprovação de orçamento** (padrão do Luan): só a fase de aprovação, cards grandes com as peças e o link do PDF,
  botões Aprovado integral / parcial / Devolver. Card com +1 h pisca e acende o aviso vermelho no topo, o número
  no título da aba e, se o aparelho permitir, notificação.
- "⤢ Ver kanban completo" leva ao quadro geral; "↩ Minha tela" volta.
- **Quadro geral**: Orçamento, Aquisição e Aguardando Peças ficam num grupo só ("Orçamento e Peças") — clicar
  abre a tela do setor; o ⤢ da coluna Aprovação abre a tela da aprovação. Arrastar um card para o grupo = mandar
  para Orçamento.

## Piscar em vermelho (todas as telas)

- Aguardando Peças com prazo vencido
- Aprovação de Orçamento há mais de 1 h
- Orçamento ou Aquisição de Peças há mais de 1 dia
