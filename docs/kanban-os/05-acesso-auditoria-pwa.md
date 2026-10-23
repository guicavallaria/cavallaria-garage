# Kanban de OS — perfis, auditoria, PWA e segurança (Etapa 7)

## Login individual

A senha única do app (`APP_PASSWORD`) deu lugar a um usuário por pessoa ou setor. Cada usuário entra com **usuário + senha**.

| Perfil | Agenda e pátio | Pós-vendas | Kanban | Ações de gestor no kanban | Administração | Exportar/importar agenda |
|---|---|---|---|---|---|---|
| Gerência | ✔ | ✔ | ✔ | ✔ | ✔ | ✔ |
| Recepção | ✔ | ✔ | ✔ | ✔ | — | ✔ |
| Compras | ✔ | — | ✔ | ✔ | — | — |
| Pátio | ✔ | — | ✔ | ✔ | — | — |
| Mecânico | — | — | ✔ | — | — | — |

- **Ações de gestor:** arquivar e desarquivar card, vincular e desvincular relatório Launch, criar link do PDF para o cliente, ver e cancelar links enviados.
- **Administração** (`/kanban/admin.html`): usuários, lista de mecânicos do kanban, modelos de checklist e auditoria.
- **Mecânico:** abre direto no kanban. Tudo o que ele registra sai com o nome dele, e o servidor ignora o operador que o aparelho mandar. As contas de setor (Recepção, Compras, Pátio, Gerência) são usadas por mais de uma pessoa e continuam perguntando "Quem é você?".
- O servidor confere cada permissão. Esconder botões na tela é só conforto.

### Senhas

- Ficam guardadas só como hash bcrypt.
- Senha nova ou provisória: 3 grupos de 4 caracteres sem letras ambíguas (ex.: `k7mq-2xpa-9dvt`). Aparece **uma vez só**, na tela de Usuários.
- No primeiro acesso, ou depois de uma senha provisória, a pessoa só consegue trocar a senha. Regras: pelo menos 8 caracteres, sem o nome de usuário.
- Esqueceu a senha? A Gerência gera uma provisória na tela de Usuários.
- Desativar um usuário derruba a sessão dele na hora, em todos os aparelhos. Não dá para desativar o próprio usuário nem a última Gerência.
- 5 senhas erradas em 15 minutos, do mesmo IP para o mesmo usuário, bloqueiam novas tentativas por 15 minutos. A mensagem de erro não diz se o usuário existe.

### Primeiro acesso depois do deploy (acesso inicial)

Enquanto não existe nenhum usuário ativo, a senha antiga (`APP_PASSWORD`) entra como Gerência, **só para criar as contas**. O acesso abre direto na tela de Usuários, onde o botão **"Criar estas contas"** cria as contas combinadas:

`recepcao`, `compras`, `patio`, `gerencia`, `edson`, `iago`, `ronaldy`, `matheus`, `luiz`

Depois que existe um usuário ativo, a senha antiga para de funcionar. Em produção, sem `APP_PASSWORD` definida, não há acesso inicial nenhum: o app nunca usa a senha padrão de desenvolvimento.

### Sessões

As sessões ficam no SQLite (tabela `sessoes`), não mais na memória: **deploy e reinício não deslogam ninguém**. A sessão expira depois de 12 h sem uso. O cookie `cavallaria.sid` é `httpOnly`, `SameSite=Lax` e, em produção, só trafega em HTTPS.

## Auditoria

A tabela `auditoria` registra quem fez o quê, em qual card e quando:

- **Acesso:** login, login que falhou (só o usuário digitado, nunca a senha), logout, troca de senha.
- **Administração:** usuário criado, desativado ou reativado; senha provisória gerada; mecânicos; modelos de checklist.
- **Kanban:** card criado pelo sync (operador "Sistema"); mudança de fase; arquivar e desarquivar; mecânico do card; textos e mídias; checklist iniciado, respondido, editado e finalizado; avarias; peças; comentários; PDF gerado.
- **Downloads e links:** **download de PDF** (os PDFs agora abrem por `/api/kanban/midias/:id/abrir`, que registra e redireciona para a URL assinada de 15 min); link do cliente criado e cancelado; **link público aberto pelo cliente**.

O conteúdo nunca vai para a auditoria: nada de texto do registro, nome ou telefone do cliente. Ficam só ids, códigos, a rota e o IP. A Gerência consulta tudo em **Administração → Auditoria**, com filtro por OS e por usuário.

## PWA

- `/kanban/manifest.webmanifest` declara o app "Kanban OS" com `start_url` `/kanban/`, modo standalone e ícones gerados a partir do emblema da logo (`public/kanban/icons/`).
- `/kanban/sw.js` serve a "casca" do app (HTML, CSS, JS, ícones) com prioridade para a rede, o que ajuda com o sinal ruim do pátio. **`/api` e mídias nunca passam pelo cache.** Uma resposta de login, vinda de redirecionamento, nunca é guardada.
- **Instalar no celular:**
  - **Android/Chrome:** menu ⋮ → "Instalar app" ou "Adicionar à tela inicial".
  - **iPhone/Safari:** Compartilhar → "Adicionar à Tela de Início".
- O manifest, os ícones e a logo são públicos, porque o navegador busca o manifest sem cookie. Esses arquivos não têm dado nenhum.

## Segurança

- `trust proxy`: o IP real e o HTTPS vêm dos cabeçalhos do proxy do Railway.
- Em produção (`RAILWAY_ENVIRONMENT` ou `NODE_ENV=production`):
  - HTTP vira HTTPS com redirecionamento 301;
  - o cookie sai com `Secure`;
  - o servidor manda o cabeçalho HSTS.
- Cabeçalhos em todas as respostas: `X-Content-Type-Options: nosniff`, `X-Frame-Options: SAMEORIGIN`, `Referrer-Policy: same-origin`. O `Permissions-Policy` libera câmera e microfone só para o próprio app. O cabeçalho `X-Powered-By` foi removido.
- `SESSION_SECRET` precisa ter 32 caracteres ou mais. Em produção, sem ela, o app gera um segredo temporário e avisa no log: funciona, mas todos saem a cada reinício.

---

# Checklist de deploy (Railway)

> Nada disto foi feito ainda. O deploy só acontece com a sua aprovação: merge da `feature/kanban-os` na `main` e push.

## 1. Bucket de mídia (antes de tudo)

- [ ] Criar o bucket privado: Cloudflare R2 (recomendado, sem custo de saída) ou Railway Buckets.
- [ ] Ligar o versionamento e a retenção, se o provedor oferecer.
- [ ] Configurar o CORS para `https://cavallaria-garage-production.up.railway.app`, com `PUT`, `GET` e `HEAD`, o header `content-type` e expondo `ETag`. O modelo está em `01-armazenamento-de-midia.md`.
- [ ] Criar uma chave de acesso **só para este bucket**.
- [ ] Testar o CORS com um envio real antes de liberar para a oficina.

## 2. Variáveis de ambiente no Railway (nunca no código)

| Variável | Valor |
|---|---|
| `SESSION_SECRET` | 64 caracteres aleatórios (novo) |
| `APP_PASSWORD` | manter a atual: é o acesso inicial para criar os usuários |
| `APP_PUBLIC_URL` | `https://cavallaria-garage-production.up.railway.app` (links `/m/…` dos QR e do PDF do cliente) |
| `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY`, `STORAGE_SECRET_KEY`, `STORAGE_REGION` | do bucket (R2: região `auto`) |
| `ONMOTOR_USER`, `ONMOTOR_PASS` | já existem (pátio) |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET`, `GMAIL_REFRESH_TOKEN` | do `tools/gmail-autorizar.js`, com a conta launchcavallaria@gmail.com e o app OAuth publicado "Em produção" |
| `LAUNCH_FONTE` | `gmail` |
| `KANBAN_CHROME_PATH` | `/usr/local/bin/chrome-stable` (conferir no container) |
| `TZ` | `America/Sao_Paulo` (opcional: o código já usa SP fixo) |

Não definir em produção: `KANBAN_FONTE=mock`, `KANBAN_MOCK_NOVIDADES`, `KANBAN_LAUNCH_MOCK_DIR`, `STORAGE_PATH_STYLE`.

## 3. Banco e backup

- [ ] **Fazer backup** de `/data/agendamentos.db` antes do deploy.
- [ ] As migrations 003 a 010 rodam sozinhas na subida. O log mostra "migrations aplicadas: …".
- [ ] A primeira leitura do Onmotor importa todas as OS abertas. Arquivar à mão as que não interessam.

## 4. Depois do deploy

- [ ] Todos saem uma vez (sessão nova). Entrar com a senha antiga → tela de Usuários → **"Criar estas contas"** → anotar as senhas provisórias e entregar a cada pessoa.
- [ ] Entrar como `gerencia` e trocar a senha. A partir daí, a senha antiga não entra mais.
- [ ] Testar no celular:
  - instalar o PWA;
  - vistoria de entrada com fotos;
  - revisão com vídeo e QR;
  - link do PDF para o cliente;
  - Launch;
  - auditoria.
- [ ] Conferir no log se não aparece o aviso de `SESSION_SECRET`.
- [ ] TV/painel da recepção: entrar com a conta `recepcao` ou `patio` uma vez. A sessão dura enquanto a tela for usada, e expira com 12 h sem uso.
