# Assinatura comercial por tenant

**Status:** primeira versão manual, conforme [ADR-0005](../adr/0005-cloud-direto-e-assinatura-por-tenant.md).

## Modelo de produto

- **Cloud direto:** uma instalação Customer operada pelo projeto contém os tenants das empresas contratantes; cada tenant recebe seu próprio plano e período.
- **Self-host/partner:** a licença `ACT_...` continua autorizando a instalação inteira. O dono da instalação pode usar a mesma assinatura por tenant para cobrar suas empresas ou manter tenants sem assinatura.
- A licença `ACT_...` e a assinatura do tenant são objetos diferentes e ficam em bancos diferentes: licença no Control Plane Vendor; assinatura em Customer.

## Dados

`public.tenant_plan_subscriptions` armazena `organization_id`, `plan_slug`, estado, ciclo, preço opcional em centavos, moeda ISO, início/fim do período, fim de teste, cancelamento ao fim do período e ator/timestamps. Há no máximo uma assinatura corrente por organização (`trialing`, `active`, `past_due` ou `suspended`). Os estados terminais podem permanecer como registros anteriores quando uma assinatura nova começar.

`plan_slug` referencia `platform_plan_catalog`. `organizations.settings.plan` é mantido como espelho para compatibilidade com leitores existentes. Os overrides de limites da organização continuam válidos conforme a implementação atual do catálogo.

RLS fica habilitada sem leitura ou escrita direta por `anon` e `authenticated`; a tabela só recebe SELECT/INSERT/UPDATE pelo `service_role`. As funções SECURITY DEFINER verificam a existência de um Platform Owner ativo e têm `EXECUTE` somente para `service_role`.

## Criação e administração

1. O formulário do Platform Owner em `/owner` recebe nome, identificador, administrador inicial, plano e período da primeira assinatura.
2. `POST /api/v1/admin/tenants` valida o corpo com Zod, exige papel global `owner` para criar assinatura e chama a RPC que cria organização e assinatura na mesma transação.
3. `/owner` permite selecionar uma empresa e administrar o estado e os termos em `PUT /api/v1/owner/tenants/{id}/subscription`. A rota exige Platform Owner e MFA/scope de escrita quando configurados.
4. GET/PUT são auditados. Nenhuma credencial de pagamento é recebida ou enviada.
5. Alterar o plano no painel antigo de limites é recusado para uma empresa com assinatura corrente; o proprietário deve usar o painel de assinatura para manter plano, limites e preço coerentes.

Para operar o Cloud direto com venda manual, configure a política da instalação em `so_convite`. O projeto cria o tenant e sua assinatura pelo painel do Owner e depois envia o convite ao administrador da empresa. O modo de cadastro aberto existente pode provisionar tenant sem assinatura e deve permanecer apenas onde a instalação decidiu aceitar organizações sem cobrança.

## Aplicação das regras

O resolvedor canônico consulta a assinatura por `organization_id`, aplica o plano associado e calcula se o estado e as datas permitem uso. O mesmo resolvedor alimenta os guards existentes para:

- criar ou convidar usuários;
- conectar canais;
- utilizar módulos que já têm entitlement no catálogo: campanhas, chamadas de voz e comment-to-DM.

`active` e `past_due` permitem uso dentro do período. `trialing` exige um fim de teste futuro e também respeita o fim do período. `canceled`, `suspended` e `expired` não permitem as operações acima. Um tenant sem registro continua legado/isento para manter compatibilidade.

A política não bloqueia login, leitura do CRM nem acesso aos dados existentes. Ela também não altera `organizations.status`, que representa suspensão administrativa diferente da assinatura comercial.

## Limites da primeira versão

Preço e status são registrados manualmente pelo Platform Owner. Não há gateway, cobrança automática, checkout, fatura ou carência adicional. O fim do período é a fonte temporal de validade; nenhum cron é necessário para bloquear as quotas após o vencimento.

Os entitlements se limitam às features já presentes no catálogo. Uma política comercial para módulos que ainda não possuem quota central precisa de uma implementação e teste próprios antes de ser vendida como limite do plano.
