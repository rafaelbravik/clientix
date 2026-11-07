# Preparação local do checkpoint Clientix — novembro de 2026

- **Data da validação:** 2026-11-07
- **Checkpoint solicitado:** `10c53d9e65ada082b7cb1e58b1722f9f8b4fa233`
- **Natureza:** validação local pré-publicação; não é release pública.

## Resultado

`READY_FOR_GITHUB_PUSH=NO`. O remote configurado não está acessível, a colisão de migrations não pôde ser verificada e a imagem Customer não inicia por causa de um link quebrado para `next`. O smoke Vendor iniciou, mas o health endpoint ficou indisponível sem um backend Supabase/PostgreSQL isolado.

## Integridade local

- `HEAD_BEFORE=10c53d9e65ada082b7cb1e58b1722f9f8b4fa233`
- O working tree estava limpo antes de gerar este relatório.
- `git diff --check` passou antes da documentação.
- As pastas de código, testes, scripts e documentação solicitadas estão presentes, assim como `hostgator-setup-kit/install-single-server.sh`.
- Migrations Control Plane presentes: `0001_initial_control_plane.sql` até `0006_signed_license_artifact_versions.sql`.
- Nenhuma migration foi aplicada nesta validação.

## Imagem Customer

- Build: `npm exec --offline --yes --package=pnpm@9.15.9 -- pnpm run build:customer` e build Docker no target `runner`; ambos concluíram.
- Tag local: `clientix-customer:2026.11-local-certified`.
- ID/digest local: `sha256:3fb8c583431146bc2bd42c5b085ade75fb0105dc622f16d6f73b210bb028bee6`.
- Tamanho: `1,545,275,218 bytes` (aprox. 1.44 GiB).
- Labels declaram a revisão solicitada, `source-dirty=false` e `release-eligible=false`.
- Scan da imagem: 54.766 arquivos, 32.366 arquivos de texto e 562 entradas de rotas; `/admin/license` e APIs locais de licença estão presentes. Nenhum caminho/código Vendor ou Control Plane, material de assinatura privada, `.git` ou source map da aplicação foi encontrado. A imagem não contém capacidade de emissão nem chave privada. Há mapas de terceiros em dependências (`node_modules`), mas nenhum mapa da aplicação.
- **Smoke runtime: falhou.** O processo encerrou com `Cannot find module 'next'`. Em `/app/node_modules/next`, o artefato contém um symlink cujo destino de staging não existe na imagem. O container de smoke foi removido sem `-v`; a imagem foi mantida.
- Resultado: `CUSTOMER_IMAGE_BUILD=PASS`, `CUSTOMER_BOUNDARY_FINAL=PASS`, `CUSTOMER_IMAGE_RUNTIME_SMOKE=FAIL`, `FINAL_CUSTOMER_IMAGE_READY=NO`.

## Imagem Vendor

- Build Docker no target `vendor`: concluído.
- Tag local: `clientix-vendor:2026.11-local-certified`.
- ID/digest local: `sha256:117ad4877713b9bcac8af5b10e0fd17467d8f93e22da27e14882e293286307f2`.
- Tamanho: `980,573,892 bytes` (aprox. 0.91 GiB).
- Labels declaram a revisão solicitada, `source-dirty=false` e `release-eligible=false`.
- Scan da imagem: 12.473 arquivos, 10.999 arquivos de texto; nenhum marcador/arquivo de chave privada, token JWT candidato, `.env` real ou `.git`. Não havia variável de ambiente sensível pré-configurada na imagem. A chave de assinatura não foi embutida.
- Manifesto do Next contém as páginas de licenças e billing, a rota de emissão/licenças, a lista de invoices e a rota de confirmação de pagamento manual.
- Smoke local com variáveis sintéticas e sem volumes: container iniciou sem restart; `/login` retornou `200`; páginas administrativas redirecionaram para autenticação (`307`); `POST /api/v1/licenses/validate` com body vazio retornou `400`; API Vendor de billing sem sessão retornou `401`. `/api/v1/health` retornou `503`, pois o smoke não tinha Supabase/PostgreSQL disponível. O container de smoke foi removido sem `-v`.
- Resultado: `VENDOR_IMAGE_BUILD=PASS`, `VENDOR_IMAGE_SECRET_SCAN=PASS`, `VENDOR_IMAGE_RUNTIME_SMOKE=PARTIAL`, `FINAL_VENDOR_IMAGE_READY=NO`.

As duas imagens foram construídas com os mesmos labels de revisão do checkpoint e `source-dirty=false`. Elas permanecem apenas no Docker local; não houve `docker push`, exportação ou publicação.

## Remote e migrations

- `origin` está configurado para `https://github.com/rafaelbravik/clientix-agencia.git`.
- `git ls-remote --symref origin HEAD refs/heads/main` e `git fetch --no-tags origin main` falharam com `Repository not found`.
- O remote oficial e sua branch default não puderam ser confirmados. Não foi alterado o remote.
- Sem a branch remota, a comparação de `control-plane/migrations/` e `supabase/migrations/` não é possível. Nenhuma colisão foi declarada como ausente: estado `UNKNOWN_FETCH_FAILED`.
- `COMMITS_LOCAL_AHEAD/BEHIND=N/A`; a base remota e o intervalo de um futuro push são desconhecidos.

## Varredura do snapshot local

- Nenhum marcador de chave privada, token GitHub, chave AWS ou credencial live de pagamento foi encontrado no conteúdo versionado em `HEAD`.
- O único PEM encontrado é `distribution/installer/trust/release-manifest/clientix-release-2026-01.pem`, identificado pelo cabeçalho como `PUBLIC KEY`.
- `.env.hostgator.example` e `.env.voip.example` são templates versionados, não `.env` reais.
- Não há `.clientix-local`, diretórios operacionais de backup/runtime na raiz, logs ou arquivos `.dump` versionados. `.clientix-local/` está ignorado.
- **Revisão de privacidade pendente:** os arquivos `evidence/triagem-15set-l10/883-preparo-google-do-dono.sql` e `evidence/triagem-15set-l11/897-preparo-google-do-dono.sql` contêm literais de endereços de e-mail em instruções `INSERT`; os domínios não são reservados de teste/exemplo. Os valores não são reproduzidos aqui. Como já pertencem ao snapshot local, devem ser revisados antes de qualquer publicação.
- A varredura cobre o snapshot local; a lista final de commits candidatos não pôde ser delimitada sem acesso ao remote.

## Decisão

| Gate                             | Resultado      | Evidência                                                                         |
| -------------------------------- | -------------- | --------------------------------------------------------------------------------- |
| Build Customer                   | PASS           | Imagem local construída no checkpoint solicitado                                  |
| Boundary Customer/Vendor         | PASS           | Scan da imagem sem Control Plane, código Vendor ou material de assinatura privada |
| Runtime Customer                 | FAIL           | Symlink `node_modules/next` aponta para staging ausente                           |
| Build Vendor                     | PASS           | Imagem local construída no checkpoint solicitado                                  |
| Segredos na imagem Vendor        | NO             | Scan estático sem chaves privadas ou credenciais reais                            |
| Runtime Vendor                   | PARCIAL        | Login e respostas de auth/rotas comprovados; health 503 sem backend isolado       |
| Remote oficial acessível         | NO             | GitHub respondeu `Repository not found`                                           |
| Colisão de migrations            | NÃO VERIFICADA | Branch oficial indisponível                                                       |
| Snapshot sem segredos conhecidos | PASS           | Marcadores e tokens conhecidos ausentes                                           |
| Snapshot sem dados para revisão  | NÃO            | Dois scripts SQL contêm e-mails não reservados                                    |
| Prontidão para push              | **NO**         | Gates acima permanecem pendentes                                                  |

Para reavaliar o push, é necessário corrigir o packaging Customer em uma alteração revisada e reconstruir/testar a imagem, validar o Vendor com backend descartável, confirmar o remote oficial e comparar as migrations, e revisar os dois scripts SQL e o histórico candidato.

## Limites da wave

Nenhum arquivo de código foi alterado. Nenhum commit/tag/push/release/imagem publicada foi criado. Produção e `deskcomm-crm` não foram tocados; nenhuma migration foi aplicada; nenhum volume foi removido.

## Revalidação corretiva — 2026-11-07

Este registro complementa os resultados iniciais acima. A falha de runtime Customer e o smoke parcial Vendor foram corrigidos/validados; os bloqueios de remote e comparação com a branch oficial continuam abertos.

### Customer

- Causa: o standalone carregava links PNPM para a árvore temporária de staging. O `cp -a` no Dockerfile também recriava links de `pdfjs-dist`/`canvas` para essa árvore.
- Correção: materializar os pacotes runtime em aliases convencionais, remover o `.pnpm` do standalone e falhar o build se restar qualquer symlink. O Dockerfile copia apenas o worker que o pdf.js procura junto ao chunk.
- Build e boundary scan passaram. A imagem foi inspecionada sem Control Plane, rotas administrativas Vendor, issuer ou material de assinatura privada.
- Smoke da imagem corrigida: processo estável; `/login` retornou `200`; `/admin/license` redirecionou para autenticação (`307`).

### Vendor e backend descartável

- Aplicadas e verificadas, em PostgreSQL descartável dedicado, as migrations Control Plane `0001` a `0006`. Nenhuma foi aplicada em `deskcomm-crm`.
- Backend descartável incluiu PostgreSQL Control Plane, Supabase local com o baseline da aplicação, Redis compatível com REST e WAHA local. Nenhum dado ou segredo de produção foi usado.
- Smoke da imagem Vendor: `/login=200`, `/api/v1/health=200`, páginas administrativas redirecionam para autenticação (`307`) e APIs administrativas sem sessão retornam `401`.
- O `supabase db reset` da cadeia histórica encontrou uma migration anterior que referencia `public.contacts` antes de essa relação existir. Para este smoke foi aplicado o baseline canônico no Supabase descartável; o health Vendor ficou saudável. Isso não alterou migrations nem o banco persistente.
- Scan da imagem Vendor: nenhum bloco PEM privado, `.env` real ou credencial live detectados. A chave de assinatura permanece fornecida somente em runtime.

### SQL de QA

- `evidence/triagem-15set-l10/883-preparo-google-do-dono.sql` e `evidence/triagem-15set-l11/897-preparo-google-do-dono.sql` são fixtures de QA local; seus comentários descrevem jornadas sintéticas sem Google real.
- Os domínios locais foram normalizados para `example.test`, preservando as contas sintéticas e removendo endereços com aparência de domínio operacional. Varredura dos endereços adicionados: `PUBLICATION_PII_SCAN=PASS`.

### Qualidade e segurança

- Typecheck: PASS. Lint: PASS (0 erros; 538 avisos já existentes). Prettier: PASS. `git diff --check`: PASS.
- Testes focados de packaging Customer, boundary e licensing/billing: `135/135` testes passaram em 16 arquivos.
- Uma varredura exploratória mais ampla também executou suites não alteradas de Control Plane e encontrou 18 falhas: 17 em `control-plane/tests/service.test.ts` por expectativa de serviço sem instalação ativa e 1 em `control-plane/tests/migrator.test.ts`, cuja expectativa ainda conta quatro migrations enquanto existem seis. Nenhum arquivo dessas suites ou dos serviços testados foi modificado nesta wave; essas falhas não foram mascaradas como sucesso.
- O scan do conteúdo candidato não encontrou bloco de chave privada nem credencial real. Os padrões `whsec_` da suite `graph-partner/route.test.ts` são valores sintéticos montados com `x.repeat()` e não credenciais.

### GitHub e migrations

- `origin` continua configurado como `https://github.com/rafaelbravik/clientix-agencia.git`; `git ls-remote` retorna `Repository not found`. Não foi possível determinar se o caminho está errado, se o repositório privado exige autenticação ou se foi movido. A CLI `gh` não está disponível nesta máquina.
- Nenhuma branch oficial foi obtida; portanto colisões em `control-plane/migrations/` e `supabase/migrations/` permanecem `UNKNOWN_NOT_CHECKED`. O remote não foi alterado.
- As tags de imagem Customer e Vendor permanecem locais e não foram publicadas. O smoke foi feito com artefatos derivados da árvore de trabalho desta correção; os IDs finais são informados no registro de execução desta wave.

### Decisão atualizada

`CUSTOMER_IMAGE_RUNTIME_SMOKE=PASS`, `CUSTOMER_BOUNDARY_FINAL=PASS`, `VENDOR_IMAGE_RUNTIME_SMOKE=PASS`, `VENDOR_HEALTH_STATUS=PASS`, `PUBLICATION_PII_SCAN=PASS` e os scans de segredos das imagens passaram. `READY_FOR_GITHUB_PUSH=NO`: remote oficial não verificado e collision check impossível sem acesso à branch oficial. Não houve push, publicação de imagem, uso de VPS, alteração de produção ou toque em `deskcomm-crm`.
