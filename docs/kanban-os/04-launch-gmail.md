# Kanban de OS — relatórios Launch pelo Gmail (Etapa 6)

## Como funciona

1. **A cada 5 minutos, todos os dias,** o app lê a caixa **launchcavallaria@gmail.com** pela API oficial do Gmail.
   - A permissão é **só de leitura**.
   - O scanner manda de `diagnostic_report@cnlaunch.com`, **sem anexo**: o e-mail traz um **link** para o PDF no servidor da Launch (`…dbscar.com/ait_report/….pdf`), e o assunto é o nome do arquivo. O app baixa o PDF por esse link, só de servidores da Launch (`dbscar.com`, `cnlaunch.com`, `x431.com`) e por HTTPS.
   - Também entram e-mails com "launch" no assunto e PDF anexo, encaminhados à mão.
   - O mesmo relatório em dois e-mails entra uma vez só: o nome do arquivo já traz data e hora.
   - Cada e-mail é processado uma vez só, controlado pelo `message_id` em `launch_emails`.
2. **Leitura do nome do arquivo:** a marca e o chassi saem do nome. Exemplo: `BMW_WBAGL61002DM57925_AllSystems.pdf` dá BMW e o chassi WBAGL61002DM57925.
3. **Armazenamento:** o PDF vai para o bucket, com a data e hora do e-mail.
4. **Vínculo:** o relatório vai para o card **ativo** do mesmo chassi, por comparação exata dos 17 caracteres. O chassi do card vem do cadastro do veículo no Onmotor.
   - Se o card ainda não tem chassi, vale o chassi já conhecido daquela placa na tabela `veiculos`.
5. **Período da OS:** vai de **3 dias antes da entrada**, porque às vezes o escaneamento é feito antes de abrir a OS, até a finalização da OS. Se a OS não foi finalizada, o período segue aberto.
6. **Principal:** o relatório com data mais próxima da entrada da OS, antes ou depois. Os outros do mesmo chassi no período ficam como **adicionais**, em ordem.
7. **Sem card correspondente:** o relatório vai para **"🔬 Launch"** no topo do kanban, com o número de pendentes.
   - Lá, a Gerência vincula à mão. Na Etapa 7, só o login da Gerência poderá fazer isso.
   - Quando um card ganha o chassi de um relatório pendente, o vínculo acontece sozinho.
8. **Linha do tempo:** cada vínculo gera o registro "Relatório Launch anexado — dd/mm/aaaa hh:mm" e o ícone 🔬 no card.
9. **Envio manual:** no card, "Relatórios Launch → Anexar PDF" permite que o operador envie um PDF de escaneamento.

## Configurar o Gmail (uma vez, antes do deploy)

Estes passos usam a sua conta Google e precisam ser feitos por você. Leva uns 15 minutos.

1. **Criar o projeto:** acesse https://console.cloud.google.com, logado com **launchcavallaria@gmail.com**, e crie um projeto chamado "Kanban Cavallaria".
2. **Ativar a API:** em "APIs e serviços → Biblioteca", ative a **Gmail API**.
3. **Tela de consentimento:** em "APIs e serviços → Tela de consentimento OAuth", escolha o tipo **Externo** e preencha o nome do app e o e-mail.
   - Em "Escopos", adicione `https://www.googleapis.com/auth/gmail.readonly`.
   - Em "Usuários de teste", adicione `launchcavallaria@gmail.com`.
4. **Publicar o app:** na mesma tela, clique em **"Publicar app"** para passar a "Em produção".
   - ⚠️ Em modo **"Teste"**, o Google invalida a autorização a cada **7 dias**, e a leitura pararia toda semana.
   - Publicado, o Google mostra o aviso "app não verificado" na hora de autorizar. Isso é normal para uso interno: clique em "Avançado → Acessar".
5. **Criar a credencial:** em "Credenciais → Criar credenciais → ID do cliente OAuth", escolha o tipo **"App para computador"**. Anote o **ID do cliente** e a **chave secreta**.
6. **Gerar a autorização:** no PC, na pasta do agendamento, rode no PowerShell:
   ```powershell
   $env:GMAIL_CLIENT_ID="cole-o-id"; $env:GMAIL_CLIENT_SECRET="cole-a-chave"; node tools/gmail-autorizar.js
   ```
   - O navegador abre a tela do Google. Entre com launchcavallaria@gmail.com e autorize a leitura.
   - O terminal mostra o **refresh token**.
7. **Configurar o Railway:** coloque as três variáveis no serviço:

| Variável | Valor |
|---|---|
| `GMAIL_CLIENT_ID` | ID do cliente |
| `GMAIL_CLIENT_SECRET` | Chave secreta |
| `GMAIL_REFRESH_TOKEN` | Valor mostrado no passo 6 |

Com essas variáveis o app liga a leitura sozinho. Sem elas, a leitura fica desligada e o kanban avisa na página "🔬 Launch".

**Variáveis opcionais:**

| Variável | Para que serve |
|---|---|
| `LAUNCH_INTERVAL_MIN` | Muda o intervalo, que é 5 minutos por padrão |
| `LAUNCH_GMAIL_BUSCA` | Troca a busca do Gmail. A padrão é `(from:cnlaunch.com OR from:dbscar.com OR (subject:launch has:attachment filename:pdf)) newer_than:30d` |

**Se o Google invalidar a autorização** (senha da conta trocada, acesso revogado), a página "🔬 Launch" mostra o erro "A autorização do Gmail expirou ou foi revogada". Nesse caso, rode o passo 6 de novo e troque o `GMAIL_REFRESH_TOKEN` no Railway.

## Desenvolvimento

Com `LAUNCH_FONTE=mock`, o app lê os PDFs de uma pasta, definida em `KANBAN_LAUNCH_MOCK_DIR`, como se fossem e-mails. Cada PDF vira um e-mail, com a data do arquivo como data do e-mail. A configuração `kanban-dev` já vem assim.
