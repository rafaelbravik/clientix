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

## Atualização e rollback

- O manifesto assinado é validado antes de qualquer pull: estrutura, versão do
  instalador, `keyId`, compatibilidade, estratégia e IDs de migration,
  repositórios permitidos e digests `sha256`. A chave de release aceita em
  produção continua fixa em `trust/release-manifest`; a chave de licença não é
  aceita para releases. Tag é metadado, nunca autoridade de imagem.
- `clientix-installer update --dry-run` valida manifesto, estado, schema,
  digests locais e compatibilidade sem criar journal, backup, pull ou reiniciar
  serviços. A execução normal adquire `flock`, grava `state/update-journal.json`,
  salva configuração/release/imagens em `backups/releases/<transaction-id>/`,
  cria e verifica o backup lógico do PostgreSQL com o migrador atualmente
  instalado e só então baixa cada referência `imagem@sha256:...`. O digest local
  é comparado ao manifesto antes de alterar configuração ou executar migration.
- O journal mantém o histórico sanitizado de estados, timestamps, códigos de
  saída/erro, IDs de release, digests e schema antes/depois. As transições são
  revalidadas na leitura; divergência de identidade ou histórico adulterado
  bloqueia a recuperação. Ele não contém valores de segredo nem conteúdo de
  `.env`. Um lock do sistema
  operacional impede dois updates/rollbacks simultâneos; lock ativo nunca é
  removido por idade. Metadados de processo deixados por processo morto são
  substituídos somente depois que `flock` confirma que o lock está livre.
- Depois da migration, o instalador exige o schema exato assinado, sobe os
  serviços e valida app, worker, scheduler, Caddy, conectividade de banco e
  dependências externas, rota HTTPS, certificado e HSTS. O estado da release só
  passa a apontar para os novos digests depois desses gates. Um update já
  aplicado e saudável é idempotente.
- `migration.ids` contém os nomes exatos das migrations pendentes apresentados
  por `clientix-migrator status --json`. Antes de executar migration, o updater
  compara as duas listas sem permitir itens extras, ausentes ou duplicados.
  Esses IDs são metadados; nenhum campo do manifesto é executado como comando.
- `migration.strategy` aceita `none`, `expand`, `contract` ou `irreversible`.
  `none`/`expand` só permitem rollback automático quando o manifesto assinado
  declara aplicação/configuração compatíveis, `database_strategy:
  preserve_schema` e a versão anterior na lista de compatibilidade. `contract` e
  `irreversible` exigem `database_strategy: operator` e confirmação explícita
  `--confirm-irreversible <release_id>`; falha pós-migration não reverte banco
  automaticamente.
- `clientix-installer rollback` restaura configuração, manifesto e digests
  anteriores se eles ainda estiverem presentes localmente e o schema atual
  estiver dentro da faixa assinada. Ele preserva o schema e nunca inventa
  migration reversa ou restaura o dump automaticamente. Se schema, backup,
  assinatura ou compatibilidade não puderem ser comprovados, o journal fica em
  `MANUAL_RECOVERY_REQUIRED` e a intervenção do operador é necessária.
- Estado legado produzido por versões anteriores do instalador não guardava o
  manifesto nem os digests no `release.json`. No primeiro update, o instalador
  aceita essa origem somente se não houver manifesto parcial, a versão e o
  schema do estado coincidirem com o banco, os seis digests estiverem presentes
  nos repositórios permitidos e cada imagem estiver disponível localmente com o
  mesmo `RepoDigest`. A versão antiga também precisa estar nas listas assinadas
  de compatibilidade/rollback do destino. O journal marca
  `legacy_digest_pinned`; isso não afirma que o predecessor tinha assinatura
  persistida. Após o primeiro update concluído, a nova release e seus digests
  passam a ter manifesto assinado persistido.
- Se o processo for interrompido, não inicie outro update sobre journal não
  terminal. Execute `clientix-installer rollback`: ele valida novamente os
  manifestos/checkpoint e retoma a restauração segura quando possível. Um estado
  `MANUAL_RECOVERY_REQUIRED` não é limpo nem retomado automaticamente.

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
  `https://DOMAIN`. O Compose entrega `NEXT_PUBLIC_ADMIN_URL` também como
  `CLIENTIX_ADMIN_ORIGIN` server-only em runtime, para que o guard same-origin não
  dependa do valor `NEXT_PUBLIC_*` embutido durante o build. Se `META_WEBHOOK_BASE_URL`
  for definida, ela pode usar um hostname dedicado, mas precisa ser uma origem HTTPS
  pública sem porta ou caminho.
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

## Servidor de licenças

- Uma instalação comercial nova exige `CLIENTIX_LICENSE_SERVER_URL` como URL
  base HTTPS pública do Vendor, sem credenciais, query ou fragmento. O cliente
  usa esse endereço para ativação e validações online; o prefixo de caminho é
  permitido quando o Vendor está atrás de um proxy. A URL é configuração
  pública, não uma chave privada. O artefato Customer recebe apenas essa URL e
  a chave pública confiável do emissor.
- Atualizações aceitam `.env` legado sem essa variável para não bloquear a
  migração, mas a ausência impede ativação e atualização online da licença até
  que a URL seja configurada. A licença local assinada continua sendo aplicada
  conforme o contrato LIC-01 e sua tolerância offline.

## Acesso às imagens do GHCR

As imagens de produção são privadas. Antes de instalar ou atualizar, autentique o Docker com
uma conta GitHub que recebeu permissão **Read** nos seis pacotes e um PAT clássico com
`read:packages`. Rode o login e o instalador com o mesmo usuário e a mesma configuração
Docker. Se usar `sudo`, faça ambos com `sudo`. Assim, os pulls por digest do manifesto assinado
e as atualizações futuras reutilizam a credencial do Docker sem gravá-la no `.env`.

Passo a passo para o operador: [runbook de acesso privado ao GHCR](../../docs/runbooks/ghcr-privado.md).
