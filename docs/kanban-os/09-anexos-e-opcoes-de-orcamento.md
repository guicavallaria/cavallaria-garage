# Anexos de qualquer formato e orçamento com opções (12/11/2026)

## 📎 Anexo de arquivo no card

O card aberto agora tem o botão **📎 Arquivo** ao lado de Foto, Vídeo, Áudio e Galeria. Ele aceita qualquer formato: PDF, XML de nota, planilha, .zip e outros.
- O arquivo vai como está, sem conversão, e guarda o **nome original**. Na linha do tempo aparece "📎 nome.xml (tamanho)" com o botão **⬇ Baixar**. O download sai com o mesmo nome, mantendo acento e espaço.
- O limite é **50 MB** por arquivo, e dá para escolher vários de uma vez.
- O anexo vai direto no card. Itens de checklist continuam aceitando só foto e vídeo.
- Quem tem permissão pode remover o anexo da linha do tempo, como acontece com as fotos.
- Assim como as outras mídias, o arquivo fica no bucket (R2), e nunca no volume do Railway.
- No banco: `kb_midias.tipo = 'arquivo'` e `kb_midias.nome_arquivo`; o evento é do tipo `arquivo` (migração 019). O mime vem do navegador; se não for válido, vira `application/octet-stream`. A extensão vem do nome; sem extensão, fica `.bin`.

## Orçamento com opções de escolha pelo cliente

Serve para quando o cliente recebe mais de um orçamento para escolher, por exemplo amortecedor novo ou recondicionado.

**No envio para a Aprovação (Orçamento → Aprovação)**
- A janela mostra "Orçamento 1 em PDF" e o botão **+ Adicionar Orçamento 2** (depois 3, 4 e 5, no máximo 5).
- Cada opção é um PDF separado, e o ✕ tira uma opção.
- A linha do tempo registra a mudança de fase com o Orçamento 1 e mais um registro com o PDF de cada opção seguinte.

**Depois do envio, com o orçamento ainda sem decisão**
- No card aberto, a seção Orçamento mostra **+ Adicionar Orçamento N**.
- Esse botão aparece só para o compras e para quem tem movimentação total.

**Na fase Aprovação**
- O card mostra o aviso **"⚠ Orçamento com opções de escolha pelo cliente (N)"**, com um link para cada orçamento.
- No quadro geral aparece o selo "⚠ N opções".

**Na aprovação**
- **Integral:** o operador escolhe "Qual orçamento o cliente aprovou?" (Orçamento 1…N); sem essa escolha o card não passa. O registro diz "o cliente escolheu o Orçamento 2 (de 3 opções)" e leva o PDF escolhido. A separação de peças usa as peças lidas desse PDF.
- **Parcial:** igual a antes. O operador anexa o PDF aprovado pelo cliente, e não há escolha de opção.

**Depois de decidido**
- O card mostra "Opções apresentadas ao cliente (N): escolhido o Orçamento X", e o escolhido fica marcado com ✅.
- "Abrir orçamento aprovado pelo cliente" abre o PDF escolhido.

**Detalhes técnicos**
- Banco: `kb_orcamentos.opcoes` guarda o JSON com os ids das mídias em ordem, e o primeiro é o próprio `pdf_midia_id`. `kb_orcamentos.opcao_aprovada` guarda o número escolhido. Um orçamento sem opções fica com `opcoes` NULL.
- Rotas:
  - `mover` aceita `pdf_midia_ids` e `opcao_aprovada`.
  - `POST /api/kanban/orcamento-pdf?…&opcao=N` dá o nome `orcamento-N-os…pdf`.
  - `POST /api/kanban/cards/:id/orcamentos/:orcId/opcoes` `{pdf_midia_id, operador}` adiciona uma opção depois do envio.
- Código:
  - `kanban/acoes.js`: `aplicarExigencias` e `adicionarOpcaoOrcamento`.
  - `kanban/pecas.js`: `opcoesDoOrcamento` e `midiaAprovada`, este último usado na separação, em `pecas-sugeridas` e no `aprovado_url`.
- Nenhum PDF serve duas vezes, seja como orçamento, como via do cliente ou como opção.

## Migração 019

A migração 019 refaz as tabelas `kb_midias` e `kb_eventos` para aceitar o tipo `arquivo`, e adiciona `nome_arquivo`, `opcoes` e `opcao_aprovada`.
- Ela usa o novo `migrations/refazer-tabela.js` e roda com as chaves estrangeiras desligadas, conferindo `foreign_key_check` no fim (`exports.semChavesEstrangeiras`).
- O `down` só roda se não houver nenhum anexo do tipo `arquivo`.
