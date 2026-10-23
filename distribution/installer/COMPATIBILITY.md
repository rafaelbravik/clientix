# Contrato de compatibilidade do instalador

O `release-manifest.json` é a autoridade assinada para a versão mínima do
instalador, o alvo de schema e a faixa de origens suportadas. O instalador só
usa esses campos depois de validar a assinatura Ed25519.

## Versões do instalador

`distribution/installer/VERSION` é a fonte canônica da versão do instalador. A
comparação com `min_installer_version` segue a precedência SemVer 2.0.0:
versões estáveis têm precedência sobre pré-lançamentos, identificadores
numéricos de pré-lançamento comparam numericamente e metadados de build não
alteram a precedência.

## Schema

- `schema_target` é o baseline cumulativo de destino declarado pelo
  `supabase/manifest.json` incluído na imagem de migrador referenciada pelo
  manifesto assinado. O status do migrador precisa declarar o mesmo alvo antes
  de qualquer alteração no banco.
- `compatibility.min_schema` e `compatibility.max_schema` são limites
  inclusivos da versão de origem suportada para atualização direta. Os valores
  são sequências numéricas de schema com pelo menos quatro dígitos, não
  versões lexicais.
- O schema atual vem do ledger `public.clientix_schema_migrations` lido pelo
  migrador. O marcador `baseline:NNNN` fornece a sequência do baseline; linhas
  incrementais conhecidas são mapeadas pelo migrador para suas sequências no
  próprio `supabase/manifest.json`. O schema atual é a maior sequência
  comprovada por esse ledger. Linha desconhecida, marcador ausente/ambíguo ou
  evidência inconsistente torna o schema indisponível e bloqueia a operação.
- Em banco `FRESH_DATABASE`, ainda não existe schema de origem. O instalador
  permite somente o caminho `install` do baseline, desde que o alvo interno do
  migrador coincida com `schema_target`.
- Banco `EXISTING_UNTRACKED_INSTALLATION` não tem evidência versionada
  suficiente para a faixa de compatibilidade e falha fechado antes da adoção.
- Em uma atualização rastreada, origem abaixo do mínimo ou acima do máximo é
  recusada. Um alvo abaixo do schema atual também é recusado; o instalador não
  executa downgrade de banco.

## Ingress público

- CLIENTIX_ACME_CHALLENGE=direct é o padrão e usa HTTP-01/TLS-ALPN do Caddy;
  exige TCP 80/443 acessíveis pela CA. Para redes com CGNAT, firewall ou bloqueio
  do provedor, selecione explicitamente CLIENTIX_ACME_CHALLENGE=dns e
  CLIENTIX_ACME_DNS_PROVIDER=cloudflare. DNS-01 não exige A/AAAA público nem
  conexão de entrada da CA. O manifesto de release assinado precisa incluir
  images.caddy com digest e um dos modos explícitos de segredo abaixo. DNS-01
  nunca troca automaticamente para HTTP-01 ou TLS-ALPN.
- `CLIENTIX_ACME_SECRET_MODE=external` é o modo recomendado para produção e
  operação unattended. `CLIENTIX_CLOUDFLARE_TOKEN_FILE` contém somente um
  caminho absoluto canônico fora de `INSTALL_DIR`. No Linux, o arquivo precisa
  ser regular, root-owned (ou corresponder ao UID explicitamente definido em
  `CLIENTIX_CLOUDFLARE_TOKEN_OWNER_UID`), sem hard links, com modo `0400` ou `0600`, e nenhum
  bit de grupo/outros. O instalador verifica metadados sem ler o conteúdo, não
  corrige permissões, não copia e não faz backup do arquivo. O Caddy recebe
  apenas um bind mount read-only. Configure o caminho no `.env` ou passe
  `clientix-installer install --cloudflare-token-file /caminho/externo`; o valor
  do token nunca é argumento, variável de ambiente, Compose, log ou estado.
- `CLIENTIX_ACME_SECRET_MODE=ephemeral` é manual e indicado para laboratório.
  Passe o segredo ocultando a entrada por `clientix-installer install
  --cloudflare-token-stdin` ou `clientix-installer update
  --cloudflare-token-stdin`. O Caddy aguarda o arquivo no tmpfs do próprio
  container; o instalador envia stdin por `docker compose exec`, sem env ou
  argumento com o valor. O segredo desaparece quando o container para. Após
  restart/reboot, reinjete com `clientix-installer secret inject --stdin`.
  Certificados continuam no volume persistente, mas nova emissão/renovação DNS-01
  depende da reinjeção. Produção não muda para esse modo automaticamente.
- No modo externo, faça rotação criando um novo arquivo root-owned (ou com UID
  explicitamente permitido) `0400`/`0600`
  e substituindo o caminho atomicamente. Depois execute
  `clientix-installer ingress reload` para recriar somente o Caddy e validar o
  HTTPS. Um bind mount existente pode continuar apontando para o inode antigo;
  por isso o reload recria o container. No modo efêmero, `ingress reload
  --cloudflare-token-stdin` recria o Caddy e solicita nova reinjeção oculta.
- O instalador gera somente backup lógico do banco; não arquiva `$INSTALL_DIR`,
  o caminho externo nem o tmpfs. Restore de instalação DNS-01 exige provisionar
  novamente o arquivo externo e executar `clientix-installer ingress reload` (que
  revalida existência, localização e permissões), ou reinjetar stdin no modo
  efêmero. O instalador não inventa nem recupera segredo ausente. Em instalações
  antigas, o arquivo legado dentro de `state/secrets` deixa de ser usado e é
  removido somente após o novo ingress ficar saudável; faça rotação do token
  legado, pois backups externos antigos podem tê-lo capturado.
- O token Cloudflare deve ter apenas Zone / DNS / Edit e Zone / Zone / Read,
  restrito à zona necessária. Não o coloque no repositório nem em logs.

- O instalador comercial exige `DOMAIN` como hostname DNS público sem esquema,
  porta ou caminho, `ACME_EMAIL` e as origens públicas `NEXT_PUBLIC_APP_URL`,
  `NEXT_PUBLIC_ADMIN_URL` e `WAHA_WEBHOOK_BASE_URL` exatamente como
  `https://DOMAIN`. Se `META_WEBHOOK_BASE_URL` for definida, ela pode usar um
  hostname dedicado, mas precisa ser uma origem HTTPS pública sem porta ou caminho.
- O Caddy do instalador publica TCP 80 e 443, redireciona HTTP para HTTPS,
  provisiona/renova certificados ACME e persiste o estado em `caddy-data` e
  `caddy-config`. HSTS é `max-age=31536000`, sem subdomínios ou preload.
- O app continua escutando internamente em `PORT=3000`, sem porta publicada no
  host. O healthcheck do app permanece interno; o instalador só marca a
  instalação saudável após validar TLS, certificado, HSTS e `/api/v1/health` na
  origem HTTPS configurada.
- `PORT` legado em um `.env` de instalação existente é ignorado. Ambos os modos
  exigem que as portas locais 80/443 estejam disponíveis para o Caddy. O modo
  direto também exige DNS público apontado ao host e conectividade externa;
  DNS-01 usa a API Cloudflare e não exige entrada pública nas portas. Falha de
  emissão mantém a instalação não pronta e nunca libera HTTP nem troca para
  outro método ACME.
- HTTP local só é aceito com `CLIENTIX_INGRESS_MODE=local`,
  `CLIENTIX_ALLOW_INSECURE_HTTP=true` e origem de loopback. O instalador
  comercial fixa production e não oferece esse modo.
