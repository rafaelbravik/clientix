# Fronteira entre runtime do cliente e Control Plane

## Termos e escopo

CUSTOMER_RUNTIME é a aplicação instalada e operada pelo cliente: CRM, canais, runtime de IA, administração tenant-local, verificação local de licença e entitlements. A chave Ed25519 da instalação é gerada e persistida localmente; somente a chave pública é registrada no vendor.

VENDOR_CONTROL_PLANE é a operação global do fornecedor: gestão de clientes comerciais, emissão e mutação de licenças, registry de instalações, dashboards globais e suporte entre instalações.

SHARED_LIBRARY contém contratos e funções necessárias nos dois builds sem acesso ao banco central. BUILD_TIME_ONLY monta e valida o artefato customer. Os componentes release-críticos estão classificados abaixo; nenhum fica UNKNOWN.

## Classificação por caminhos

| Classificação        | Caminhos e responsabilidade                                                                                                                                                                                                                                                                                                                                                                                                                  |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CUSTOMER_RUNTIME     | app/api/v1/system/license/route.ts e lib/licensing/**: identidade da instalação, verificação Ed25519, estado local, entitlements e limites. app/app/settings/team/** e app/api/v1/team/**: administração dos usuários da organização ativa. app/api/v1/health/route.ts: sondas de Supabase, Redis e WAHA locais.                                                                                                                             |
| VENDOR_CONTROL_PLANE | app/admin/**, app/api/v1/admin/**, app/api/v1/auth/support/**, app/support-ended/**, components/admin/**, components/app/ImpersonateBanner.tsx e lib/impersonate/**: painel de plataforma, operações globais de tenants, identidade platform_admin e suporte/impersonação. control-plane/** e scripts/licensing/**: banco central, emissão e ferramentas de autoridade.                                                                      |
| SHARED_LIBRARY       | lib/auth/**, lib/api/**, lib/supabase/** e lib/licensing/**: autenticação tenant-local, contratos HTTP, acesso ao banco de instalação e verificação local. `lib/auth/support-context.ts` contém apenas o contrato compartilhado; o build customer substitui `support-context-provider.ts` por `support-context-provider.customer.ts`, que retorna null sem RPC. O build vendor usa o provider padrão, ligado a `lib/impersonate/support.ts`. |
| BUILD_TIME_ONLY      | scripts/customer-build-policy.ts, scripts/build-customer.ts e os estágios build-customer/build-vendor no Dockerfile. O build customer filtra a árvore antes de compilar e valida rotas, referências proibidas e a presença da rota local de licença.                                                                                                                                                                                         |

### Licenciamento global

Todas as rotas em app/api/v1/admin/licensing/** usam a autoridade central e são VENDOR_CONTROL_PLANE.

Leituras: licenças, clientes comerciais, instalações registradas e auditoria central.

Escritas: emissão e renovação, suspensão, reativação e revogação de licença ou instalação; criação e revogação de códigos de ativação; criação e alteração de clientes comerciais.

As telas Gemini sob app/admin/(protected)/licensing/** e seus componentes permanecem no repositório e no build vendor. O alvo runner customer exclui o painel global e as APIs em app/api/v1/admin/**, exceto a superfície local LIC-01 de `/api/v1/admin/license/**` explicitamente allowlisted.

### Administração global e suporte

app/api/v1/admin/tenants/** e app/admin/(protected)/tenants/** administram organizações fora do escopo de uma organização ativa e usam identidade platform_admin. São VENDOR_CONTROL_PLANE. A administração tenant-local disponível ao cliente continua sob app/app/settings/team/** e app/api/v1/team/**, com RBAC e escopo da organização.

O fluxo de suporte usa app/api/v1/admin/tenants/[id]/impersonate/route.ts para iniciar sessões, app/api/v1/admin/impersonate/end/route.ts para encerrá-las, app/api/v1/auth/support/route.ts para consultar o contexto, lib/impersonate/** para cookies e validação, e app/support-ended/** para sessões encerradas. Mesmo que o banco público limite uma sessão a uma instalação e a um auth.session_id, o ator é platform_admin e o fluxo concede acesso a outra organização; o fluxo completo fica no build vendor. No build customer, as rotas e a interface ficam ausentes, o staging troca o provider antes de compilar e a autenticação não executa fn_support_context nem depende de public.platform_support_sessions. O proxy também não processa cookie de suporte.

requireSupportWrite permanece presente como ponto de guarda nas rotas de negócio compartilhadas. A implementação de customer não pode carregar uma sessão de suporte e retorna sem bloqueio para usuários tenant normais. A identidade de OAuth continua vinculada ao session_id autenticado, sem consultar tabelas de suporte. Os testes de suporte_readonly e de negação de escrita continuam cobrindo a implementação vendor original.

IMPERSONATE_COOKIE_SECRET é VENDOR_ONLY. O segredo saiu do parser global de ambiente, é lido apenas pela implementação vendor e deixou de ser gerado pelo instalador HostGator e pelo instalador Ubuntu local. A ausência do segredo no customer não interfere em health, login, licença ou entitlements.

## Banco e dados

control-plane/migrations/0001_initial_control_plane.sql é central e nunca deve rodar no banco do cliente. Ela cria control_plane.schema_migrations e as tabelas globais de clientes, licenças, códigos, instalações, nonces e eventos.

O cliente não precisa do schema control_plane. O provider vendor exige CONTROL_PLANE_DATABASE_URL e CONTROL_PLANE_PEPPER, usa um pool separado e recusa a combinação host/porta/database de SUPABASE_DB_URL. Não há fallback para LICENSE_PEPPER nem valor padrão.

### LIC-02B: autoridade de assinatura

O `LicenseIssuer`, acesso à chave privada Ed25519 de emissão, ciclo comercial, rotas globais e banco `control_plane` pertencem somente ao VENDOR_CONTROL_PLANE. O CUSTOMER_RUNTIME recebe a trust root pública e o verificador LIC-01; conhecer o serial, `installation_id`, licença assinada ou código customer não fornece autoridade para emitir, renovar, revogar ou transferir uma licença.

O LIC-01 também mantém uma chave privada de identidade por instalação para prova de posse nas chamadas online. Essa chave não assina licenças, não é a chave de emissão do vendor e não é embutida como valor no artefato: o runtime a cria/carrega no armazenamento local persistente. A classificação de “sem chave privada no customer artifact” refere-se ao material criptográfico de emissão. A presença do código de identidade LIC-01 é necessária para vincular validação online à instalação e não deve ser confundida com capacidade comercial de emissão.

O baseline público existente ainda contém a tabela platform_admins e as tabelas históricas de suporte. O build customer não consulta a identidade platform_admin nem resolve sessões de suporte. Esta alteração não remove tabelas do baseline e não adiciona tabelas control_plane a supabase/migrations/ ou supabase/baseline.sql.

### LIC-02C: atestação e detecção de clone

O customer cria uma sessão efêmera `sess_<UUIDv4>` por processo Node iniciado e envia heartbeat de atestação em intervalo configurável (300 segundos por padrão). Cada validação obtém um desafio aleatório assinado pelo License Server, vinculado à instalação, licença, sessão e nonce. O desafio é armazenado somente como SHA-256, expira em 60 segundos e só pode ser consumido uma vez. A resposta de validação é assinada pelo vendor e inclui o estado resumido do conflito.

O Control Plane considera apenas sessões com heartbeat nos últimos 15 minutos. Uma primeira sobreposição marca `SUSPECTED_CLONE`; a confirmação exige que outra sessão envie um novo heartbeat depois do primeiro conflito. Assim, um processo antigo parado após restart pode gerar suspeita temporária, mas não confirma clone sem atividade simultânea. Heartbeat ausente torna a sessão velha para contagem e nunca marca clone por si só. `CLONE_CONFIRMED` entra em restricted mode local pela resposta assinada; `SUSPECTED_CLONE` mantém operação e exibe aviso ao Platform Admin.

A recuperação requer ação explícita vendor. O Control Plane grava apenas HMAC do código aleatório e o motivo/ator; o código de uso único expira em 24 horas, encerra sessões existentes e marca `TRANSFER_PENDING`. A instalação gera nova chave local, prova posse da chave candidata, troca a chave registrada com autorização válida e só substitui o arquivo privado local depois de verificar a resposta Ed25519 do vendor. A chave privada não é enviada. Transferências e mudanças de status também encerram as sessões. `control-plane/migrations/0003_installation_clone_attestation.sql` pertence somente ao banco vendor.

O build customer preserva somente `/api/v1/admin/license/recover`, a ação local autenticada que encaminha o código de recuperação ao License Server. Os endpoints centrais `/api/v1/licensing/challenge`, `/validate-attestation` e `/recover-installation` e todas as ações administrativas permanecem fora do runner customer. O `installation_id` e a chave privada continuam clonáveis por cópia integral do volume; a proteção detecta sessões simultâneas, não diferencia duas cópias da mesma chave.

### LIC-03: administração comercial do Vendor

As telas `/admin/licenses`, `/admin/customers` e `/admin/installations` operam exclusivamente sobre `control_plane.*` pelo provider vendor. O layout de plataforma autentica a identidade `platform_admin`; rotas mutantes também exigem `scope=full`, quitação da política MFA, origem same-origin e validação Zod. O build customer continua removendo a árvore `/admin/**`, APIs globais e `control-plane/**`, mantendo somente a superfície local LIC-01 explicitamente allowlisted.

A migration `control-plane/migrations/0004_vendor_commercial_admin.sql` adiciona campos comerciais mínimos, request id de auditoria e operações atômicas/idempotentes de criação, emissão, renovação, transferência e autorização de recovery. Ela pertence somente ao banco de teste/produção do Control Plane e nunca ao banco `deskcomm-crm` nem ao baseline self-hosted. Documentos de cliente são guardados como HMAC; observações internas ficam no registro comercial e não se misturam aos dados operacionais do tenant.

O dashboard apresenta contagens e vencimentos por janela, com busca, filtros, ordenação, paginação e CSV limitado. A emissão produz apenas `license.json` assinado. Revogação, transferência, autorização de recovery e rotação de identidade exigem confirmação; alterações comerciais passam por trilha de eventos com ator, request id e motivo. O painel não integra cobrança, e-mail ou WhatsApp nesta fase.

## Contrato de ambiente

| Nome                                      | Classificação           | Regra                                                                                                         |
| ----------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------- |
| CONTROL_PLANE_DATABASE_URL                | VENDOR_ONLY             | Obrigatória para as rotas centrais; nunca passa ao build customer.                                            |
| CONTROL_PLANE_PEPPER                      | VENDOR_ONLY             | Obrigatório, mínimo 32 caracteres; sem fallback para credencial de cliente ou valor padrão.                   |
| chave privada de assinatura de licença    | VENDOR_ONLY             | Usada pelo signer no ambiente seguro do fornecedor; não é argumento de build nem parte do artefato customer.  |
| chave privada de identidade da instalação | CUSTOMER_RUNTIME        | Gerada localmente, persistida com permissão restrita e usada só para prova de posse; nunca enviada ao vendor. |
| código de recuperação da instalação       | VENDOR_ONLY → uso único | Mostrado uma vez; o banco central guarda apenas HMAC e expiração.                                             |
| IMPERSONATE_COOKIE_SECRET                 | VENDOR_ONLY             | Lido apenas pelo código vendor; não é requerido nem gerado pelo instalador customer.                          |
| trust root pública Ed25519                | CUSTOMER_RUNTIME        | Distribuída para verificar licenças locais; não permite emitir licenças.                                      |
| credencial do banco central               | VENDOR_ONLY             | Nunca substitui SUPABASE_DB_URL e não é herdada pelo build customer.                                          |

O script build:customer usa uma allowlist de ambiente e placeholders públicos; não herda credenciais do shell nem lê arquivos .env. O alvo padrão do Docker é runner customer; --target vendor compila o app integrado.

## Artefatos e comportamento

| Item                                            | runner customer                                                               | build vendor                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| /admin/** e /api/v1/admin/**                    | Ausentes, exceto `/admin/license` e suas APIs locais allowlisted              | Preservados                                |
| /api/v1/auth/support e /support-ended           | Ausentes do manifesto                                                         | Preservados                                |
| lib/impersonate e chamadas de sessão de suporte | Fonte vendor excluída; stubs customer sem leitura de banco, cookie ou segredo | Implementação completa                     |
| /api/v1/system/license e lib/licensing/**       | Preservados; status local, verificação e entitlements                         | Preservados                                |
| /api/v1/admin/license/recover                   | Preservado; Platform Admin encaminha código para rotação local autorizada     | Preservado                                 |
| /api/v1/licensing/** central                    | Ausente; o cliente consulta a URL HTTPS do vendor                             | Presente; desafio, atestação e recuperação |
| /api/v1/billing/** e cron Vendor                | Ausentes; sem cobrança comercial, webhook ou segredo de provedor              | Presentes somente no Control Plane Vendor  |
| identidade platform_admin                       | Consulta ausente no build customer; usuário é avaliado por suas memberships   | Preservada                                 |
| control-plane/** e chamadas control_plane.*     | Fora da árvore Next e do standalone                                           | Preservados                                |
| health                                          | Consulta apenas Supabase, Redis e WAHA locais                                 | Igual; não consulta banco central          |
| configuração de banco/pepper vendor             | Ausente do ambiente de build customer                                         | Exigida nas rotas vendor                   |

pnpm build:customer filtra os caminhos de CUSTOMER_BUILD_EXCLUDED_PATHS, instala dependências offline na cópia temporária, remove comandos de operador de `package.json` e compila o Next isolado. A validação recusa o artefato se restar rota administrativa ou suporte, se faltar a rota local de licença ou se houver marcador de issuer, Control Plane, credencial central, chave privada PEM, arquivo de chave privada ou impersonação. Ela também inspeciona nomes de caminhos no standalone, static e public. `.clientix-local` é excluído do contexto Docker, mantendo backups e runtime local fora de todas as etapas da imagem. O target customer desativa sourcemaps de browser, servidor e prerender e falha o build se restar mapa de aplicação; o target vendor mantém seu comportamento próprio. O artefato contém standalone/, static/ e public/.

docker build produz runner customer. docker build --target vendor mantém a aplicação integrada interna. A imagem vendor não é publicada por este trabalho.

## Verificações G1.3 e G1.4

A smoke G1.3 em GET /api/v1/admin/licensing/licenses atingiu uma rota vendor presente no build monolítico antigo. Ela consultou o pool SUPABASE_DB_URL do cliente e devolveu 500 porque aquele banco corretamente não tinha control_plane.licensing_licenses. No runner, a rota global não é compilada; no provider vendor, a conexão é separada.

O 503 de suporte observado na G1.3 ocorreu porque IMPERSONATE_COOKIE_SECRET estava ausente no fluxo antigo. No customer, o fluxo inteiro não está disponível: as rotas de início e encerramento e a consulta de contexto são removidas ou substituídas por stubs sem acesso a tabelas de suporte. O health check é independente e continua sondando somente Supabase, Redis e WAHA.

As chaves privadas de assinatura permanecem externas. O artefato customer recebe apenas a trust root pública existente.

## LIC-04 — Billing Vendor

O Control Plane inclui billing em banco separado. Nesta wave, `MANUAL` é o único provedor habilitado; Stripe e Mercado Pago são negados em código até LIC-05. A confirmação de pagamento, renovação, avanço do período e outbox da próxima revisão assinada são uma transação PostgreSQL. O License Server assina na hora pelo issuer Vendor, guarda o documento e hashes em `licensing_license_artifacts`, e grava o evento de assinatura na mesma instrução. Se falhar, o artefato segue `PENDING` com retry; a operação administrativa informa que a reemissão não terminou. A validação online só entrega a revisão persistida e o LIC-01 a verifica antes de substituir o arquivo local atomicamente.

O processo privado `pnpm control-plane:billing-scheduler` roda imediatamente e então a cada 15 minutos por padrão (`CONTROL_PLANE_BILLING_SCHEDULER_INTERVAL_MS`). Um advisory lock de sessão PostgreSQL serializa réplicas e também protege o comando one-shot. A rodada executa maintenance, reconciliação e retry da outbox. O deployment Vendor deve configurar somente esse processo e suas credenciais privadas. O customer build exclui as rotas de billing, páginas administrativas, scheduler, credenciais e `control-plane/**`.

## Living System Checklist

- Entrada e saída: cliente consulta e instala licença local; fornecedor administra licenças e instalações globais no build vendor.
- Evento e auditoria: rotas vendor preservam recordAdminEvent; o customer mantém audit tenant-local sem contexto de impersonação.
- Tela e porta: o customer não tem painel global nem suporte impersonado; páginas Gemini continuam no vendor.
- Anti-morte: ausência do Control Plane ou do segredo de suporte não afeta health, licença local ou entitlements.
- Configuração: o instalador customer não solicita nem gera credenciais vendor.
- Continuidade IA e humano: sem alteração no fluxo do agente.
- Laço de retorno: política de exclusão, manifesto standalone, scanner de artefato e testes de boundary cobrem o alvo customer; testes de suporte mantêm a implementação vendor.
- Atestação: heartbeats de baixa frequência criam sessões efêmeras; sessões antigas não contam como clone; sobreposição persistente gera evento e resposta assinada para restricted mode.
- Recuperação: somente o vendor autoriza; a chave candidata é gerada no cliente e a troca local ocorre depois de verificar a resposta assinada; nenhuma chave privada atravessa a rede.
