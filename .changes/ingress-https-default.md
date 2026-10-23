---
impacto: exige_acao
secao: alterado
titulo: O instalador comercial exige ingresso público HTTPS
---

Instalações do pacote comercial agora usam Caddy para emitir e renovar certificados automaticamente; o app deixa de publicar sua porta diretamente no host. HTTP simples fica restrito ao modo local explícito.

## Requer atenção

Antes de atualizar uma instalação do instalador comercial, aponte o DNS público para o servidor, libere TCP 80/443 e configure `DOMAIN`, `ACME_EMAIL`, `NEXT_PUBLIC_APP_URL`, `NEXT_PUBLIC_ADMIN_URL` e `WAHA_WEBHOOK_BASE_URL`. As três origens do app devem ser `https://DOMAIN`; o atualizador valida tudo antes de executar migrations.
