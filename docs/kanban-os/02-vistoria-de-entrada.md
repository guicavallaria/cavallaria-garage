# Kanban de OS — vistoria de entrada e PDF (Etapa 4)

## Fluxo no celular

1. No card, **📋 Vistoria de entrada → Fazer vistoria**.
2. "Quem está fazendo este checklist?": lista de nomes ou campo livre.
3. **13 fotos obrigatórias**, uma por tela, na ordem do prompt. Cada tela traz a instrução de enquadramento. O **Próximo** só libera com a foto, e no painel também com o KM digitado. Depois de cada foto, o Próximo já abre a câmera do passo seguinte.
   - Depois do KM a câmera não abre sozinha. O KM é salvo no servidor antes de avançar, e os navegadores só deixam abrir a câmera direto a partir de um toque.
4. **"Identificou alguma avaria?"** Sim abre a câmera. Depois da foto, o mecânico escolhe a região na lista do prompt e escreve uma descrição curta. Em seguida vem "Tem outra avaria?", até responder Não.
5. **Combustível**, em quartos, e **itens presentes**, numa lista de checagem rápida.
6. **Conferir e finalizar**. Fotos ainda na fila de envio não contam como pendência. Se o envio não terminou, a vistoria finaliza sozinha quando a última foto chegar.

Cada resposta é salva na hora. Dá para sair no meio e continuar depois, inclusive em outro aparelho, a partir do primeiro passo que falta. O "voltar" do Android e o gesto de voltar do iPhone fecham a vistoria e depois o card, sem sair do kanban.

## Regras

- **Uma vistoria de entrada por card.** Iniciar de novo abre a mesma vistoria.
- **Fotos presas ao item.** Ficam em `kb_midias` com `checklist_item_id`, e as de avaria também com `avaria_id`. Elas não viram registros soltos na linha do tempo; a linha do tempo recebe "iniciada", "finalizada" e "PDF gerado".
- **Foto refeita.** Vale a mais recente, no PDF e na tela. As anteriores ficam guardadas.
- **O servidor só finaliza com tudo presente.** Precisa das 13 fotos no armazenamento, do KM, da resposta sobre avarias com foto de cada avaria e do combustível. Senão devolve a lista do que falta.
- **Editar depois de finalizar** fica na Etapa 5, junto com as revisões. O servidor já guarda a versão anterior de cada resposta alterada, mas a tela ainda não oferece a edição.

## PDF "Vistoria de Entrada"

- É gerado em segundo plano logo após finalizar. Em teste local, levou cerca de 2 s.
- **Exportar PDF de novo** cria uma nova versão; as anteriores continuam disponíveis.
- **Conteúdo:**
  - Cabeçalho igual ao das folhas atuais: logo, nome, slogan, endereço, telefone, e-mail e CNPJ.
  - Dados da OS, do veículo e do cliente, com KM, tanque e data de entrada.
  - Grade com as 13 fotos legendadas.
  - Avarias, cada uma com foto, região e descrição, ou "Nenhuma avaria identificada".
  - Combustível e itens presentes.
  - Texto de comprovação do estado de chegada e campos de assinatura.
  - Rodapé com a data de geração e o número da página.
- **Tamanho:** as fotos são recomprimidas pelo próprio Chrome antes de imprimir. Num teste com 13 fotos de ruído, o pior caso para compressão, o PDF ficou abaixo de 8 MB. A vistoria de teste com fotos normais deu 2,1 MB. Se passar de 8 MB, o sistema tenta de novo com fotos menores.
- **Chrome:** o PDF usa o Chrome headless por meio do puppeteer-core.
  - No Railway, o Chrome for Testing já está no container, em `CHROME_PATH`.
  - Na máquina local, a variável `KANBAN_CHROME_PATH` aponta para o Chrome instalado.
