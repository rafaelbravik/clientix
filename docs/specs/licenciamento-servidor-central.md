# LIC-02 — Servidor central de licenças

## Objetivo e fronteira

O License Server é uma superfície vendor separada do artefato self-hosted do cliente. Ele mantém o banco `control_plane`, a chave privada Ed25519 de emissão e as operações administrativas comerciais. O build customer remove o Control Plane, suas rotas administrativas e os endpoints centrais; preserva as APIs locais do LIC-01 e somente a superfície mínima `/owner` com os endpoints de tenants e usuários necessários ao primeiro Platform Owner. Esses endpoints não emitem licença nem acessam o banco Vendor.

O banco do Control Plane é configurado por `CONTROL_PLANE_DATABASE_URL` e não pode apontar para o mesmo banco que `SUPABASE_DB_URL`. `CONTROL_PLANE_PEPPER` é exclusivo do servidor central. A chave privada é entregue ao runtime vendor pelo secret manager ou ambiente protegido; nunca é armazenada no banco nem incluída no pacote do cliente. Esta implementação não cria uma chave oficial.

## Modelo e estados

As tabelas `control_plane.licensing_customers`, `licensing_licenses`, `licensing_installations`, `licensing_events` e `licensing_signer_keys` formam o modelo central. A migração `control-plane/migrations/0002_commercial_license_lifecycle.sql` acrescenta serial único, produto, deployment, plano comercial, suspensão/expiração, política de validação offline, ator de auditoria, limites de ativação, idempotência e operações transacionais. Ela pertence exclusivamente ao banco vendor.

Estados comerciais do servidor: `DRAFT`, `ACTIVE`, `EXPIRED`, `SUSPENDED` e `REVOKED`. A licença assinada continua sendo interpretada localmente pelo LIC-01, que calcula `ACTIVE`, `GRACE`, `EXPIRED`, `REVOKED` ou `INVALID`. O plano comercial da instalação é metadado de autorização global e não substitui os planos por tenant.

Serial é um identificador amigável, não um segredo nem credencial. A identidade de autorização é o ID interno da licença; a identidade de uma instalação é o `installation_id` persistente criado no LIC-01.

## Emissão e assinatura

`LicenseIssuer` canonicaliza o payload pelo formato JCS usado pelo LIC-01, assina os bytes canônicos com Ed25519 e verifica o documento emitido contra a chave pública registrada para seu `key_id`. Chaves antigas podem continuar no conjunto confiável para validar documentos existentes; apenas a chave ativa selecionada pelo Control Plane assina documentos novos. O servidor recusa configuração sem uma única chave ativa correspondente e recusa pares público/privado divergentes.

O `key_id` e as chaves públicas são metadados versionados no Control Plane. O cliente contém somente a trust root pública. A rotação de uma nova chave pública de cliente exige que ela seja distribuída antes de o servidor começar a assinar com o novo `key_id`. As chaves de teste são efêmeras e identificadas como desenvolvimento; nenhuma chave privada oficial é criada nesta etapa.

## Ativação e validação

`POST /api/v1/licensing/activate` recebe um código de ativação de uso limitado, `installation_id`, versão e chave pública da instalação. O servidor aplica rate limit, valida a licença e o código, bloqueia a linha da licença durante a contagem e registra a instalação e os eventos dentro de uma transação. A resposta contém a licença e o envelope online assinados; o código não é serial nem autentica operações depois de ativado.

O vínculo `license_installations.activation_code_id` torna retries da mesma instalação idempotentes mesmo quando chegam em paralelo: a transação bloqueia o código e verifica novamente a instalação antes de consumir outro uso. Ativações distintas também serializam na licença para não ultrapassar `max_installations`.

`POST /api/v1/licensing/validate` mantém compatibilidade com o LIC-02 anterior. O fluxo LIC-02C usa `POST /api/v1/licensing/challenge` e `POST /api/v1/licensing/validate-attestation`: ambos exigem assinatura Ed25519 da instalação, nonce/timestamp e vínculo com a licença. O License Server gera desafio CSPRNG de 256 bits, armazena somente SHA-256 por 60 segundos e consome-o uma vez. O payload do desafio também é assinado pelo vendor; a resposta de validação inclui `instance_session_id`, `clone_status` e a licença assinada.

Falhas de validação usam resposta genérica para não permitir enumeração. A ativação e a validação têm respostas sem cache e rate limit distribuído; somente digests HMAC de chaves de rate limit são persistidos. O servidor não recebe credenciais Auth, conteúdo de tenant, banco do cliente ou mensagens.

## Operação administrativa

As APIs sob `/api/v1/admin/licenses` e `/api/v1/admin/customers` exigem Platform Admin, o guard de escrita nos métodos mutantes e bloqueio de escrita durante suporte somente leitura. A interface vendor está em `/admin/licenses`, com criação, detalhe, emissão, renovação, suspensão, reativação, revogação, transferência e eventos.

Renovação usa `Idempotency-Key` e uma função transacional que bloqueia a licença, calcula a nova validade e grava `LICENSE_RENEWED` e `LICENSE_REISSUED` atomicamente. Revogação exige motivo; suspensão é reversível e não reativa licença revogada. Transferência exige confirmação e motivo, bloqueia a licença e a instalação de origem, encerra a origem e registra a nova instalação em uma transação; retry idempotente não cria outra instalação nem duplica eventos.

Eventos administrativos e de instalação não contêm chaves privadas, códigos de ativação ou credenciais. Operações concorrentes de ativação serializam na licença antes de consumir a vaga. A quantidade máxima de instalações é configurável por licença.

## Integração local LIC-01

O cliente LIC-01 continua usando validação local em cada decisão de autorização e não chama o servidor central por request. Ativação, validação explícita e heartbeat de processo chamam o License Server por HTTPS (HTTP somente em loopback fora de produção), recusam redirects e têm timeout. O heartbeat começa no runtime Node, é configurável entre 60 e 3600 segundos (300 por padrão) e é desativado quando não há licença ou URL configurada. Ausência de heartbeat não é indício de clone e o cache assinado/offline tolerance continua valendo.

O estado online assinado alimenta o LIC-01: revogação é autoritativa, suspensão entra em modo restrito e tolerância offline é distinta da carência comercial da licença. Se o servidor estiver indisponível, o runtime continua com o estado local até a tolerância configurada; não exige chamada online em cada request. O Bootstrap Token continua restrito ao first-run e não é usado neste protocolo.

### LIC-02C — sessão e recuperação de identidade

`lib/licensing/instance-session.ts` cria `sess_<UUIDv4>` e `boot_started_at` uma vez por processo; esses campos são efêmeros e não são gravados no volume. Duas sessões da mesma instalação contam como conflito somente se ambas tiveram heartbeat nos últimos 15 minutos (configurável no vendor por `CONTROL_PLANE_CLONE_SESSION_WINDOW_SECONDS`). A primeira sobreposição é `SUSPECTED_CLONE`; a confirmação exige um novo heartbeat da outra sessão após o conflito inicial, evitando confirmar um boot antigo que deixou de responder. Uma sessão que envelhece sai da contagem. Estado suspeito não restringe operação; estado confirmado entra em restricted mode por payload online assinado. O servidor não afirma distinguir criptograficamente máquinas que compartilham a mesma chave clonada.

O operador vendor pode emitir um código `REC_…` de uso único por `/api/v1/admin/licensing/installations/:id/recovery`, após informar motivo e confirmar. O código tem validade máxima de 24 horas; só o HMAC entra em `licensing_installation_recoveries`. A autorização marca `TRANSFER_PENDING` e encerra sessões ativas. O runtime customer cria chave candidata protegida no armazenamento local, envia apenas a chave pública e assina a requisição com a chave candidata. O License Server consome a autorização, troca o fingerprint, encerra sessões, registra `INSTALLATION_KEY_ROTATED` e `CLONE_CLEARED`, e devolve prova Ed25519 vinculada ao nonce e ao fingerprint. O runtime verifica a prova antes de substituir atomicamente a chave local. A resposta online subsequente confirma o novo estado.

Eventos de controle incluem `INSTALLATION_ATTESTED`, `INSTANCE_SESSION_STARTED`, `INSTANCE_SESSION_HEARTBEAT`, `INSTANCE_SESSION_ENDED`, `CLONE_SUSPECTED`, `CLONE_CONFIRMED`, `CLONE_CLEARED`, `INSTALLATION_KEY_ROTATED` e `INSTALLATION_RECOVERY_AUTHORIZED`. Os eventos não armazenam chave privada, nonce/challenge em claro, código de recuperação ou fingerprint de hardware.

## Migração e validação

As migrations do Control Plane são separadas de `supabase/migrations/` e do `baseline.sql` do cliente. `0003_installation_clone_attestation.sql` adiciona sessões, desafios, recuperação e função vendor de autorização somente ao Control Plane; não foi aplicada ao banco self-hosted persistente `deskcomm-crm`. Os testes unitários e de contrato cobrem estado de clone, sessão, assinatura, recovery e boundary customer. Os testes reais de banco exigem PostgreSQL descartável com o nome dedicado `clientix_license_server_test`; recusam hosts externos, banco com outro nome, schema já existente ou role de runtime preexistente e provam duas sessões sobrepostas, replay e recuperação autorizada.

Esta fase não inclui cobrança, pagamentos, portal público, renovação por pagamento nem revogação automática por gateway. `PUBLIC_RELEASE_READY` permanece `NO`.
