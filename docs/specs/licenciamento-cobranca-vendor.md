# LIC-04 — Cobrança do Control Plane Vendor

## Escopo e separação

A cobrança comercial pertence somente ao banco `control_plane` e ao build Vendor. O Customer Runtime não recebe páginas ou rotas administrativas de billing, credenciais de provedor, fila comercial ou banco do Vendor. A migration `0005_billing_automation.sql` não faz parte do baseline Supabase self-host.

Este contrato cobre a licença comercial da instalação `ACT_...` e a operação de emissão/renovação do parceiro. Ele não processa cobranças das empresas que usam uma instalação multi-tenant. A assinatura de cada tenant Cloud ou self-hosted é registrada no Customer conforme [`assinatura-por-tenant.md`](assinatura-por-tenant.md), sem gateway nesta fase.

Nesta wave, `MANUAL` é o único provedor habilitado. Stripe e Mercado Pago permanecem desabilitados em código e no estado comercial, mesmo que alguém configure metadata ou segredo por engano; não há conexão externa, conta, webhook live ou credencial de sandbox. O envelope webhook normalizado continua presente como estrutura futura, mas a rota externa falha fechada até LIC-05 entregar adapters nativos e validação própria de cada provedor.

## Dados e invariantes

- `billing_subscriptions` guarda ciclo, moeda, preço em centavos, datas e política de inadimplência.
- `billing_invoices` identifica o período cobrado, vencimento e estado financeiro.
- `billing_payments` não armazena cartão, token ou credencial do provedor.
- `billing_events` é append-only para o papel de runtime do Control Plane.
- Notificações são registros internos; não enviam e-mail, WhatsApp ou SMS.
- O framework de webhook normalizado tem limites de corpo e idempotência, mas a rota de gateway externo permanece desabilitada; não há adapter nativo, sandbox ou webhook de Stripe/Mercado Pago nesta wave.
- Confirmação do pagamento, renovação, avanço do período, eventos e criação do registro de outbox pendente para cada instalação ativa são uma transação PostgreSQL. A chave privada nunca sai do processo Vendor nem vai para o banco.
- Logo após a confirmação, o issuer do License Server assina a revisão pendente e persiste documento, `license_revision`, `key_id`, `issued_at`, expiração e hashes do payload/artefato. A gravação do artefato e do evento de assinatura é atômica. Falha de assinatura deixa o pagamento e renovação registrados com artefato `PENDING`, backoff e lease recuperáveis pelo scheduler; a resposta administrativa sinaliza `PENDING` em vez de declarar a reemissão completa.
- A unicidade de `(license_id, installation_id, license_revision)` e da chave de idempotência impede segunda emissão lógica para o mesmo evento. Revisões antigas ficam preservadas para auditoria.
- A validação online retorna o documento assinado da revisão atual armazenada. LIC-01 verifica assinatura e `installation_id`, então faz a substituição local atômica. O servidor não assina no caminho de entrega.
- Política padrão: `ALLOW_NATURAL_EXPIRATION`, tolerância financeira de 7 dias. Ela é separada do grace period incluído na licença.
- Renovar sem cobrança exige motivo, chave de idempotência e nenhuma assinatura aberta para aquela licença.
- Refund registra estado financeiro e não revoga automaticamente a licença.
- Reconciliação registra divergências para inspeção; não altera estados silenciosamente.

## Operação

`pnpm control-plane:billing-scheduler` inicia um processo durável somente no deployment privado do Vendor. O intervalo vem de `CONTROL_PLANE_BILLING_SCHEDULER_INTERVAL_MS` (default `900000`, mínimo um minuto). O processo roda um ciclo imediatamente e agenda o seguinte após a conclusão. O lock PostgreSQL `pg_try_advisory_lock` evita ciclos simultâneos entre réplicas; lock perdido/erro não é logado com payload, segredo ou PII, e o próximo ciclo tenta novamente. Cada execução processa vencimentos, `PAST_DUE`, billing grace, política de inadimplência, alertas deduplicados, emissão de invoice e reconciliação. O comando one-shot `pnpm control-plane:billing-maintenance` continua disponível e também adquire o mesmo lock.

Operações mutáveis de navegador exigem Platform Admin com scope `full`, MFA quando exigido, same-origin e guard contra escrita em impersonação read-only. Confirmações de pagamento, cancelamento e refund são explícitas. A listagem de faturas é paginada.

## Limites conhecidos

Não há gateway financeiro conectado, checkout, captura automática de pagamento, reembolso remoto, nota fiscal, automação de cobrança externa ou envio de notificações. `MANUAL` só registra um pagamento após confirmação administrativa por operador autorizado. Stripe e Mercado Pago ficam `DISABLED_PENDING_LIC05`; esta wave não valida segurança nativa deles. O Control Plane deve ser implantado e migrado no banco Vendor separado; nenhuma migration desta wave é aplicada a `deskcomm-crm`.

## Evidência LIC-04 closeout

- `ENABLED_BILLING_PROVIDERS=MANUAL`
- `DISABLED_BILLING_PROVIDERS=STRIPE,MERCADO_PAGO`
- Build Vendor: `PASS`, usando `npm exec --offline --yes --package=pnpm@9.15.9 -- pnpm build`; o build compilou, passou TypeScript e gerou as páginas estáticas.
- Testes focados do billing MANUAL e boundary: `32/32 PASS` em 6 arquivos, incluindo billing service, scheduler, provider gating, segurança de rotas e customer build boundary.
- Testes do banco descartável Docker: `15/15 PASS` aplicando Control Plane migrations `0001` a `0006`; cobrem pagamento MANUAL, renovação, artefato assinado/delivery LIC-01, retry idempotente, política de inadimplência, pagamento pós-suspensão e lock/repetição do scheduler. O banco usado foi descartável; nenhuma migration foi aplicada a `deskcomm-crm`.
- Typecheck: `PASS`. ESLint do escopo Billing/Vendor: `PASS`, zero erros e zero avisos; a carga inicial agora é agendada fora do corpo síncrono dos efeitos. Prettier do escopo: `PASS`.
- QA visual real em Chromium com identidade Vendor sintética e banco Control Plane descartável: a rodada final esperou o conteúdo assíncrono e validou `/admin/billing`, lista e detalhe de invoice, detalhe do customer, detalhe da licença e formulário de invoice. Desktop 1366×768 e 1920×1080 sem overflow; mobile 390×844 sem overflow na lista. Os dados sintéticos mostraram `PAST_DUE`/fatura `OVERDUE`, assinatura `SUSPENDED`, faturas `PAID`, `CANCELLED` e `OPEN`; também foram exercitados estados carregando, vazio e erro. Diálogos de pagamento manual, cancelamento de invoice, refund e renovação sem cobrança abriram; a confirmação de alteração de auto-renew foi interceptada antes da escrita.
- Evidências visuais locais: `.clientix-local/runtime/lic04-visual-qa-final4-20261106/` (screenshots; dados e autenticação sintéticos, sem dados de clientes reais).
- Falhas i18n pré-existentes: dois testes antigos de cobertura de traduções apontam strings ainda não traduzidas de licensing LIC-01/02/03. Nenhuma dessas telas/dicionários foi alterada nesta wave; não são regressões LIC-04. A suíte unitária ampla não está verde globalmente, então o resultado declarado para esta entrega é o conjunto focado do LIC-04 acima, não uma aprovação global do repositório.
- Build Customer: `PASS` com `npm exec --offline --yes --package=pnpm@9.15.9 -- pnpm build:customer`; compilação e TypeScript passaram, o manifesto foi validado e a varredura do artefato verificou 6.781 arquivos. Houve um aviso de dependência dinâmica em `lib/ai/rag/extractors/pdf.ts`, sem falha de build.
- Boundary do artefato Customer: `PASS`. Varreduras read-only do artefato gerado não encontraram código/rotas de Vendor billing, issuer/scheduler, marcadores de chave privada de assinatura, nem variáveis de credenciais Vendor/provider. O artefato entregue preserva somente o runtime Customer e `/admin/license` com suas APIs locais.
- Suite LIC-04 focada: `32/32 PASS`. A rodada de cobertura i18n ainda aponta duas falhas antigas de licensing (LIC-01/02/03), classificadas como `PREEXISTING_FAILURE`: o conjunto de traduções/telas dessas features não foi modificado pelo LIC-04. Uma rodada ampla do repositório também tem falhas herdadas fora do billing; não é declarada como suite global verde.
- Stripe e Mercado Pago não foram testados como provedores habilitados porque permanecem desabilitados e sem adapters/credenciais nesta wave; isso não bloqueia o gate LIC-04.
- Screenshots/estados de QA não autorizam considerar gateway externo habilitado: Stripe e Mercado Pago seguem desabilitados até LIC-05.
