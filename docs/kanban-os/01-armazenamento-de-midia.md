# Kanban de OS — armazenamento de mídia (Etapa 3)

Fotos, vídeos, áudios e PDFs **nunca** vão para o disco do serviço nem para o volume do Railway. Ficam num bucket compatível com S3, sempre privado.

## Como funciona

1. O aparelho prepara o arquivo. A foto é comprimida para no máximo 1920 px no lado maior, em JPEG ~80%, e ganha uma miniatura de 400 px. O vídeo é recusado se passar de 2 min, com aviso acima de 80 MB. O áudio é gravado na página ou escolhido de arquivo.
2. O aparelho pede o envio: `POST /api/kanban/cards/:id/midias`. O servidor grava a mídia como `pendente` e devolve uma URL assinada de PUT, válida por 1 h.
3. O aparelho manda o arquivo **direto ao bucket**.
4. O aparelho confirma: `POST /api/kanban/midias/:id/confirmar`. O servidor confere no bucket se o objeto existe e tem o tamanho certo, e só então publica na linha do tempo.
5. Para ver, a linha do tempo recebe URLs assinadas de GET, válidas por 15 min. Com o card aberto, a tela renova a cada 10 min.

Os envios ficam numa fila no aparelho (IndexedDB) até a confirmação. Se a rede cair, a aba fechar ou o celular reiniciar, o envio continua sozinho depois, com tentativas espaçadas. O mesmo identificador de envio impede registro duplicado.

## Variáveis de ambiente

| Variável | Exemplo | Observação |
|---|---|---|
| `STORAGE_ENDPOINT` | `https://<conta>.r2.cloudflarestorage.com` | Endpoint S3 do provedor |
| `STORAGE_BUCKET` | `cavallaria-kanban` | |
| `STORAGE_ACCESS_KEY` | | Só no Railway, nunca no código |
| `STORAGE_SECRET_KEY` | | Só no Railway, nunca no código |
| `STORAGE_PUBLIC_URL` | | Opcional. Endereço do bucket visto pelo navegador, se for diferente do endpoint usado pelo servidor |
| `STORAGE_REGION` | `auto` | `auto` para R2; `us-east-1` para MinIO |
| `STORAGE_PATH_STYLE` | `true` | Endereço `/bucket/chave`. Necessário no MinIO e no emulador local |

Sem essas variáveis o kanban funciona normalmente, mas os botões Foto, Vídeo, Áudio e Galeria ficam desligados com um aviso.

## CORS do bucket (obrigatório antes do deploy)

O navegador envia direto ao bucket. O bucket precisa aceitar a origem do app:

```json
[
  {
    "AllowedOrigins": ["https://cavallaria-garage-production.up.railway.app"],
    "AllowedMethods": ["PUT", "GET", "HEAD"],
    "AllowedHeaders": ["content-type"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3600
  }
]
```

Também é preciso ligar o versionamento e a retenção no bucket, como pede a seção 12 do prompt.

## Desenvolvimento local

Esta máquina não tem Docker, então o MinIO foi trocado por um emulador próprio em `tools/s3-dev.js`. Ele confere a assinatura e a validade das URLs como um bucket real, mas serve **só para desenvolvimento**.

```bash
npm run s3-dev
```

Ele usa a porta 9000, o bucket `kanban-dev` e as chaves `devkey` / `devsecret`. Os arquivos ficam na pasta `.s3-dev/`, que está no `.gitignore`.

Para testar pelo celular na rede local, use `STORAGE_PUBLIC_URL=http://<IP do PC>:9000`. Senão as URLs apontam para `localhost`, que no celular é o próprio celular.

O botão **Gravar áudio** só funciona em HTTPS ou em `localhost`, uma exigência dos navegadores para usar o microfone. Pelo IP da rede local, a tela cai automaticamente na escolha de arquivo de áudio. No Railway, que usa HTTPS, a gravação funciona.

## Limitação conhecida

O iPhone grava vídeo em `.mov`, e às vezes em HEVC. O Chrome do PC pode não tocar HEVC. O arquivo fica guardado intacto, e o link "Abrir vídeo em outra aba" permite baixá-lo. Converter vídeo exigiria ffmpeg no servidor, o que não foi pedido.
