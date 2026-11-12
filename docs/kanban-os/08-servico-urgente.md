# Serviço urgente (12/11/2026)

O botão **🚨 SERVIÇO URGENTE** fica no card aberto, ao lado de "Mover para…" e "Arquivar". Qualquer login pode usá-lo, inclusive quem só registra.

- **Ligado:** o card vai para o topo da coluna, em qualquer fase, por cima da ordem do sistema (normalmente o mais antigo na fase vem primeiro). Ele fica com fundo vermelho e o selo "🚨 SERVIÇO URGENTE". A urgência acompanha o card quando ele muda de fase.
  - Com vários urgentes na mesma coluna, o último marcado aparece primeiro.
  - No quadro geral, a coluna agrupada "Orçamento e Peças" mostra os urgentes num bloco "🚨 Urgentes" acima das subfases, com o nome da subfase escrito no card.
  - O alerta piscante de atraso não aparece no card urgente, porque o vermelho já o destaca.
- **Desligado** ("URGENTE — desativar"): o card volta à cor normal e à ordem do sistema.
- Cada troca vira um registro automático na linha do tempo, que não pode ser editado nem removido: "🚨 Marcado como SERVIÇO URGENTE." ou "Urgência desativada…".
- Banco: `kb_cards.urgente_em` / `urgente_por` (migração 017). Rota: `PUT /api/kanban/cards/:id/urgente` `{urgente, operador}` (`kanban/acoes.js` → `definirUrgente`). A ordem vem do `/estado`: `ORDER BY (urgente_em IS NULL), urgente_em DESC, fase_desde ASC`.

## Recepção com movimentação total (12/11/2026)

O login da recepção é `luan` (perfil recepção). Em 12/11/2026 ele já estava com *Movimentação total* em produção (trocado em Administração → Usuários, registrado na auditoria), sem migração. Com isso, a recepção move cards para qualquer fase e também separa peças e marca pedidos.
