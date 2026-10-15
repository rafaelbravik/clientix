# Fronteira entre runtime do cliente e Control Plane

## Termos e escopo

CUSTOMER_RUNTIME é a aplicação instalada e operada pelo cliente: CRM, canais, runtime de IA, administração tenant-local, verificação local de licença e entitlements.

VENDOR_CONTROL_PLANE é a operação global do fornecedor: gestão de clientes comerciais, emissão e mutação de licenças, registry de instalações, dashboards globais e suporte entre instalações.

SHARED_LIBRARY contém contratos e funções necessárias nos dois builds sem acesso ao banco central. BUILD_TIME_ONLY monta e valida o artefato customer. Os componentes release-críticos estão classificados abaixo; nenhum fica UNKNOWN.

## Classificação por caminhos

| Classificação | Caminhos e responsabilidade |
|---|---|
| CUSTOMER_RUNTIME | app/api/v1/system/license/route.ts e lib/licensing/**: identidade da instalação, verificação Ed25519, estado local, entitlements e limites. app/app/settings/team/** e app/api/v1/team/**: administração dos usuários da organização ativa. app/api/v1/health/route.ts: sondas de Supabase, Redis e WAHA locais. |
| VENDOR_CONTROL_PLANE | app/admin/**, app/api/v1/admin/**, app/api/v1/auth/support/**, app/support-ended/**, components/admin/**, components/app/ImpersonateBanner.tsx e lib/impersonate/**: painel de plataforma, operações globais de tenants, identidade platform_admin e suporte/impersonação. control-plane/** e scripts/licensing/**: banco central, emissão e ferramentas de autoridade. |
| SHARED_LIBRARY | lib/auth/**, lib/api/**, lib/supabase/** e lib/licensing/**: autenticação tenant-local, contratos HTTP, acesso ao banco de instalação e verificação local. `lib/auth/support-context.ts` contém apenas o contrato compartilhado; o build customer substitui `support-context-provider.ts` por `support-context-provider.customer.ts`, que retorna null sem RPC. O build vendor usa o provider padrão, ligado a `lib/impersonate/support.ts`. |
| BUILD_TIME_ONLY | scripts/customer-build-policy.ts, scripts/build-customer.ts e os estágios build-customer/build-vendor no Dockerfile. O build customer filtra a árvore antes de compilar e valida rotas, referências proibidas e a presença da rota local de licença. |

### Licenciamento global

Todas as rotas em app/api/v1/admin/licensing/** usam a autoridade central e são VENDOR_CONTROL_PLANE.

Leituras: licenças, clientes comerciais, instalações registradas e auditoria central.

Escritas: emissão e renovação, suspensão, reativação e revogação de licença ou instalação; criação e revogação de códigos de ativação; criação e alteração de clientes comerciais.

As telas Gemini sob app/admin/(protected)/licensing/** e seus componentes permanecem no repositório e no build vendor. O alvo runner customer exclui todo o painel global e todas as APIs em app/api/v1/admin/**.

### Administração global e suporte

app/api/v1/admin/tenants/** e app/admin/(protected)/tenants/** administram organizações fora do escopo de uma organização ativa e usam identidade platform_admin. São VENDOR_CONTROL_PLANE. A administração tenant-local disponível ao cliente continua sob app/app/settings/team/** e app/api/v1/team/**, com RBAC e escopo da organização.

O fluxo de suporte usa app/api/v1/admin/tenants/[id]/impersonate/route.ts para iniciar sessões, app/api/v1/admin/impersonate/end/route.ts para encerrá-las, app/api/v1/auth/support/route.ts para consultar o contexto, lib/impersonate/** para cookies e validação, e app/support-ended/** para sessões encerradas. Mesmo que o banco público limite uma sessão a uma instalação e a um auth.session_id, o ator é platform_admin e o fluxo concede acesso a outra organização; o fluxo completo fica no build vendor. No build customer, as rotas e a interface ficam ausentes, o staging troca o provider antes de compilar e a autenticação não executa fn_support_context nem depende de public.platform_support_sessions. O proxy também não processa cookie de suporte.

requireSupportWrite permanece presente como ponto de guarda nas rotas de negócio compartilhadas. A implementação de customer não pode carregar uma sessão de suporte e retorna sem bloqueio para usuários tenant normais. A identidade de OAuth continua vinculada ao session_id autenticado, sem consultar tabelas de suporte. Os testes de suporte_readonly e de negação de escrita continuam cobrindo a implementação vendor original.

IMPERSONATE_COOKIE_SECRET é VENDOR_ONLY. O segredo saiu do parser global de ambiente, é lido apenas pela implementação vendor e deixou de ser gerado pelo instalador HostGator e pelo instalador Ubuntu local. A ausência do segredo no customer não interfere em health, login, licença ou entitlements.

## Banco e dados

control-plane/migrations/0001_initial_control_plane.sql é central e nunca deve rodar no banco do cliente. Ela cria control_plane.schema_migrations e as tabelas globais de clientes, licenças, códigos, instalações, nonces e eventos.

O cliente não precisa do schema control_plane. O provider vendor exige CONTROL_PLANE_DATABASE_URL e CONTROL_PLANE_PEPPER, usa um pool separado e recusa a combinação host/porta/database de SUPABASE_DB_URL. Não há fallback para LICENSE_PEPPER nem valor padrão.

O baseline público existente ainda contém a tabela platform_admins e as tabelas históricas de suporte. O build customer não consulta a identidade platform_admin nem resolve sessões de suporte. Esta alteração não remove tabelas do baseline e não adiciona tabelas control_plane a supabase/migrations/ ou supabase/baseline.sql.

## Contrato de ambiente

| Nome | Classificação | Regra |
|---|---|---|
| CONTROL_PLANE_DATABASE_URL | VENDOR_ONLY | Obrigatória para as rotas centrais; nunca passa ao build customer. |
| CONTROL_PLANE_PEPPER | VENDOR_ONLY | Obrigatório, mínimo 32 caracteres; sem fallback para credencial de cliente ou valor padrão. |
| chave privada de assinatura de licença | VENDOR_ONLY | Usada pelo signer no ambiente seguro do fornecedor; não é argumento de build nem parte do artefato customer. |
| IMPERSONATE_COOKIE_SECRET | VENDOR_ONLY | Lido apenas pelo código vendor; não é requerido nem gerado pelo instalador customer. |
| trust root pública Ed25519 | CUSTOMER_RUNTIME | Distribuída para verificar licenças locais; não permite emitir licenças. |
| credencial do banco central | VENDOR_ONLY | Nunca substitui SUPABASE_DB_URL e não é herdada pelo build customer. |

O script build:customer usa uma allowlist de ambiente e placeholders públicos; não herda credenciais do shell nem lê arquivos .env. O alvo padrão do Docker é runner customer; --target vendor compila o app integrado.

## Artefatos e comportamento

| Item | runner customer | build vendor |
|---|---|---|
| /admin/** e /api/v1/admin/** | Ausentes do manifesto | Preservados |
| /api/v1/auth/support e /support-ended | Ausentes do manifesto | Preservados |
| lib/impersonate e chamadas de sessão de suporte | Fonte vendor excluída; stubs customer sem leitura de banco, cookie ou segredo | Implementação completa |
| /api/v1/system/license e lib/licensing/** | Preservados; status local, verificação e entitlements | Preservados |
| identidade platform_admin | Consulta ausente no build customer; usuário é avaliado por suas memberships | Preservada |
| control-plane/** e chamadas control_plane.* | Fora da árvore Next e do standalone | Preservados |
| health | Consulta apenas Supabase, Redis e WAHA locais | Igual; não consulta banco central |
| configuração de banco/pepper vendor | Ausente do ambiente de build customer | Exigida nas rotas vendor |

pnpm build:customer filtra os caminhos de CUSTOMER_BUILD_EXCLUDED_PATHS, instala dependências offline na cópia temporária e compila o Next isolado. A validação recusa o artefato se restar rota administrativa ou suporte, se faltar a rota local de licença ou se houver marcador de schema, credencial central ou impersonação. O artefato contém standalone/, static/ e public/.

docker build produz runner customer. docker build --target vendor mantém a aplicação integrada interna. A imagem vendor não é publicada por este trabalho.

## Verificações G1.3 e G1.4

A smoke G1.3 em GET /api/v1/admin/licensing/licenses atingiu uma rota vendor presente no build monolítico antigo. Ela consultou o pool SUPABASE_DB_URL do cliente e devolveu 500 porque aquele banco corretamente não tinha control_plane.licensing_licenses. No runner, a rota global não é compilada; no provider vendor, a conexão é separada.

O 503 de suporte observado na G1.3 ocorreu porque IMPERSONATE_COOKIE_SECRET estava ausente no fluxo antigo. No customer, o fluxo inteiro não está disponível: as rotas de início e encerramento e a consulta de contexto são removidas ou substituídas por stubs sem acesso a tabelas de suporte. O health check é independente e continua sondando somente Supabase, Redis e WAHA.

As chaves privadas de assinatura permanecem externas. O artefato customer recebe apenas a trust root pública existente.

## Living System Checklist

- Entrada e saída: cliente consulta e instala licença local; fornecedor administra licenças e instalações globais no build vendor.
- Evento e auditoria: rotas vendor preservam recordAdminEvent; o customer mantém audit tenant-local sem contexto de impersonação.
- Tela e porta: o customer não tem painel global nem suporte impersonado; páginas Gemini continuam no vendor.
- Anti-morte: ausência do Control Plane ou do segredo de suporte não afeta health, licença local ou entitlements.
- Configuração: o instalador customer não solicita nem gera credenciais vendor.
- Continuidade IA e humano: sem alteração no fluxo do agente.
- Laço de retorno: política de exclusão, manifesto standalone, scanner de artefato e testes de boundary cobrem o alvo customer; testes de suporte mantêm a implementação vendor.
