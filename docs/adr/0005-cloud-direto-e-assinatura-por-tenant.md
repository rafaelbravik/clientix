# ADR-0005 — Cloud direto e assinatura por tenant

- **Status:** aceito pelo proprietário do produto em 2026-11-17
- **Decisão:** uma instalação Cloud gerenciada pelo projeto atende empresas que compram diretamente; as instalações self-hosted de clientes e parceiros continuam autorizadas por licença de instalação `ACT_...`.
- **Escopo desta implementação:** registro e aplicação local da assinatura por tenant, com administração pelo Platform Owner. A cobrança é manual.
- **Decisão anterior relacionada:** [ADR-0004](0004-cobranca-do-revendedor.md), que continua definindo a cobrança opcional dos tenants pelo proprietário de uma instalação self-hosted.

## Contexto

O produto tem dois públicos comerciais. Uma empresa pode contratar o acesso a uma instalação Cloud operada pelo projeto. Um parceiro ou cliente também pode obter os artefatos de instalação e operar o produto na infraestrutura que controla, inclusive revendendo acesso a tenants próprios.

A licença de instalação `ACT_...` limita a instalação self-hosted inteira. Ela não identifica a assinatura mensal de cada empresa que usa uma instalação multi-tenant. O Control Plane Vendor é a origem da licença de instalação; não é o banco de cobrança das empresas Cloud.

## Decisão

1. O projeto opera uma instalação Customer multi-tenant para venda direta Cloud.
2. Cada empresa direta é um tenant dessa instalação e tem uma assinatura própria no banco Customer.
3. A tabela `tenant_plan_subscriptions` é a fonte da assinatura comercial do tenant. O plano e seus limites vêm do catálogo já existente `platform_plan_catalog`; os overrides autorizados em `organizations.settings.plan_limits` continuam em vigor.
4. O Platform Owner cria a empresa junto com sua assinatura no painel `/owner`. A organização e sua assinatura inicial são gravadas na mesma transação; a assinatura só é criada quando o pedido inclui os campos comerciais.
5. O Platform Owner pode atualizar plano, estado, ciclo, preço, moeda e período. O sistema registra o preço manualmente e não processa pagamentos.
6. A licença `ACT_...` continua separada e não é removida do fluxo de instalação de parceiros e clientes self-hosted. O proprietário de uma dessas instalações pode cobrar seus próprios tenants conforme a ADR-0004.
7. Tenant legado sem assinatura registrada mantém o comportamento atual até que o proprietário escolha vinculá-lo a um plano comercial.

No Cloud direto, a aquisição e o provisionamento iniciais são operados pelo projeto: o cadastro público fica em `so_convite`; o Platform Owner cria o tenant com plano e período e então convida o administrador da empresa. Assim, o signup aberto herdado não cria empresas comerciais sem assinatura. O modo self-host conserva a política de cadastro que o proprietário escolher.

## Regras de acesso e vencimento

- `active` permite usar os limites do plano enquanto o horário atual está dentro do período.
- `trialing` permite o uso até o primeiro dos limites entre o fim do teste e o fim do período.
- `past_due` continua válido somente até o fim do período já pago; não existe carência adicional nesta fase.
- `canceled`, `suspended` e `expired` bloqueiam a criação de usuários, canais e o uso dos módulos que já consultam o catálogo de plano. A assinatura pode ser reativada pelo proprietário.
- Vencimento ou suspensão da assinatura do tenant não suspende nem exclui a organização e não apaga os dados existentes. A pessoa continua podendo entrar e consultar o CRM; as operações controladas por cota recusam novas utilizações.
- `cancel_at_period_end` agenda a saída ao manter a assinatura ativa até `current_period_ends_at`; a validação de período deixa de permitir o uso quando o fim chega.

## Fronteira dos sistemas

| Objeto | Armazenamento | Unidade controlada |
|---|---|---|
| Licença `ACT_...` | Control Plane Vendor e artefato local assinado | Instalação inteira self-hosted |
| Assinatura do tenant | `tenant_plan_subscriptions` no Customer | Uma organização dentro de uma instalação |
| Plano e limites | `platform_plan_catalog` no Customer | Cotas e módulos disponíveis para o tenant |

Cloud direto usa a assinatura por tenant e não precisa emitir uma licença `ACT_...` para cada empresa. Parceiros recebem instalador e licença de instalação conforme o fluxo Vendor; a cobrança dos tenants que criarem é opcional e local à instalação deles.

## Fora desta fase

Gateway de pagamento, checkout, faturas, impostos, cobrança automática, notificações de atraso, carência, relatório de receita, portal de autoatendimento e provisionamento de infraestrutura por cliente. Nenhum preço é definido pelo código: o Platform Owner informa o valor acordado ou deixa o campo vazio.

## Consequências

- Instalações existentes recebem a tabela vazia e permanecem compatíveis até que uma assinatura seja atribuída.
- A criação comercial de uma empresa direta não deixa organização sem assinatura caso a transação falhe.
- Cada gravação é auditada com o ator global e a organização afetada.
- O Customer build contém apenas a administração de assinatura por organização; banco e rotas comerciais de licença continuam exclusivos do Vendor.
- Para abrir venda automática, será preciso uma decisão separada de gateway, reconciliação, eventos de pagamento e política de inadimplência.
