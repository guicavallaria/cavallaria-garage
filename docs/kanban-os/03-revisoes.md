# Kanban de OS — revisões básica e completa (Etapa 5)

## Modelos

Os modelos estão em `migrations/006_revisoes.js`, na ordem exata das folhas "check basico" e "check completo":

| Checklist | Itens numerados | Depois |
|---|---|---|
| Revisão básica | 19 | Freios dianteiros, freios traseiros, freio de mão e peças defeituosas |
| Revisão completa | 37 | Freios dianteiros e traseiros com medida dos discos, freio de mão e peças defeituosas |

| Tipo da folha | Na tela |
|---|---|
| E | Bom · Regular · Necessita troca |
| R | Bom · Regular · Necessita reparo. A descrição é obrigatória e vai para "Peças defeituosas". |
| S | Sim/Não, ou Feito/Não feito |
| M | Campo numérico. A medida do pneu, como 225/45R18, vira três campos: largura, perfil e aro. |
| F | Foto obrigatória |
| NT | Botão "Não tem", que responde o item inteiro |

- **Mecânico:** o mesmo mecânico faz o checklist inteiro, então o nome é perguntado só uma vez, no início.
- **Peças defeituosas:** cada item marcado "Necessita troca/reparo", ou com "Trocar pastilhas/discos" = Sim, gera uma linha sozinho. Se a resposta voltar para Bom ou Regular, a linha sai. O mecânico informa a descrição e o tempo de troca em horas, e pode adicionar linhas. Para finalizar, cada linha precisa de descrição e tempo.
- **Anexos de cada item:** foto, vídeo e comentário, opcionais e sempre presos ao item.

## Edição depois de finalizar

Na tela "Ver" do checklist finalizado, cada item tem **editar**. Toda alteração guarda o valor anterior, quem alterou e quando, e entra na linha do tempo do card. Exemplo:

> "Verificação das velas de ignição" alterado por Vanilton: Bom · GAP 0,8 mm → Necessita troca · GAP 1,2 mm

O mesmo vale para:

- foto, vídeo e comentário adicionados ou removidos;
- peças adicionadas, alteradas ou removidas;
- avarias na vistoria de entrada.

O PDF não muda sozinho. Depois de editar, "Exportar PDF de novo" gera uma versão nova, e as anteriores continuam disponíveis.

## PDF de revisão

O PDF segue a seção 10 do prompt:

- cabeçalho e "Informações do cliente" como nas folhas. KM e tanque vêm da vistoria de entrada, quando existe.
- título, mecânico responsável, início e fim.
- itens nas mesmas seções e ordem, com o estado em cor: verde para Bom, amarelo para Regular e vermelho para troca ou reparo.
- medidas, "Não tem" e o texto do reparo.
- logo abaixo de cada item, em ordem cronológica, as fotos, os vídeos e os comentários. O vídeo aparece como quadro, QR code e link.
- a seção final "Peças defeituosas — descrição — tempo de troca em horas", com o total.
- rodapé com a data de geração e o número da página, em A4 e com alvo abaixo de 10 MB.

## Links públicos (QR do vídeo e PDF para o cliente)

- O endereço tem a forma `/m/<token>` e abre **sem login**. O link vale 7 dias e é revogável; a revogação pela tela entra na Etapa 7.
- O app confere a validade e redireciona para uma URL assinada de 15 minutos. A mídia nunca fica pública no bucket.
- Na tela "Ver", o botão **"📤 Link para o cliente (7 dias)"** gera e copia o link do PDF para mandar pelo WhatsApp.
- **Variável nova para o deploy:** `APP_PUBLIC_URL`, com o endereço do app no Railway, por exemplo `https://cavallaria-garage-production.up.railway.app`. Sem ela, os links e QR codes apontam para `localhost`.

## Administração dos modelos

A página fica em `/kanban/admin.html`, com o link "⚙️ Modelos" no kanban, só no PC. Ela permite:

- editar a pergunta, a instrução e os componentes de cada item, escritos em JSON e validados;
- mudar a ordem, adicionar e remover itens e seções.

Salvar cria uma **versão nova** do checklist, que passa a ser a usada. Os checklists já feitos continuam com a versão em que foram feitos. Dá para voltar a usar uma versão anterior. Na Etapa 7, só o perfil Gestor acessa.
