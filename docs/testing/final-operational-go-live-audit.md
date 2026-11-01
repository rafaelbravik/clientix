# Auditoria operacional final de go-live

**Data:** 2026-11-01
**HEAD auditado:** `a64ed93265abad0250e1447e1a333d5066ae5265`
**Schema:** `9059`
**Classificação:** auditoria sintética de prontidão operacional; nenhuma instalação de produção foi acessada.

## 1. Resumo executivo

**OPERATIONAL_GO_LIVE_READY=YES**, condicionado à configuração da instalação self-host pelo proprietário. A auditoria não encontrou bloqueador P0 que impeça instalar, iniciar, autenticar, configurar pelo menos um canal e provedor de IA, atender, usar CRM/prospecção, persistir dados ou recuperar workers após reinício.

Isso certifica a prontidão funcional do produto e dos caminhos de instalação documentados. Não afirma que uma VPS específica já esteja instalada, que credenciais reais estejam configuradas, nem que um canal/provider externo esteja conectado. Essas tarefas de ambiente constam como pré-requisitos antes de operar com dados e clientes reais.

**PRODUCTION_PUBLIC_RELEASE_READY=NO.** Esta auditoria não publicou artefatos, não verificou uma chave oficial de assinatura de release, não validou uma implantação pública e não fez push/tag. **RELEASE_READY=NOT_CLAIMED.**

As certificações prévias de ChatGPT por assinatura e das waves P0-2A/B/C/D/F foram reutilizadas; não houve reabertura de funcionalidades. P0-2E, importação CSV/XLSX, continua opcional/deferida.

## 2. Base e método

- HEAD local coincide com a base esperada; schema atual declarado e verificado pelo baseline/manifest: `9059`.
- Runtime de validação: Node `v24.22.1`, libuv `1.52.1`; banco de teste PostgreSQL 15 efêmero.
- Nenhum `.env` real, arquivo de credenciais, chave privada oficial, log/evidência protegidos ou ambiente de produção/QA foi aberto.
- Nenhuma chamada real foi feita a Meta, OpenAI, Apify, Google, Telegram, TikTok, SMTP, WAHA ou sites externos.
- Instalação e update foram exercitados em ambiente sintético. As certificações de upgrade 0541→9059 e updater/rollback anteriores foram reutilizadas.

## 3. Validação executada

| Verificação | Resultado |
|---|---|
| Installer compatibility, execução 1 | PASS |
| Installer compatibility, execução 2 | PASS |
| Fresh install do baseline em Postgres 15 efêmero | PASS |
| Reaplicação do baseline / modo update | PASS, idempotente |
| Upgrade sintético 0541→9059 | PASS, certificação anterior reutilizada; sem mudança de schema nesta auditoria |
| Smoke focado operacional | PASS — 35 arquivos, 381 testes |
| `test:unit` integral | PASS, exit 0 — 1.869 arquivos passaram, 1 skip; 19.111 testes passaram, 1 falha esperada e 5 skips |
| `test:db` integral | PASS_WITH_PREEXISTING_BASELINE_REGRESSION — 372 arquivos passaram; 3.191 testes passaram, 1 falha conhecida, 1 falha esperada e 1 skip |
| `typecheck` | PASS |
| `lint` global | PASS — 0 erros, 540 warnings existentes |
| `lint:channels` | PASS — 62 itens de dívida conhecida, nenhum novo |
| `lint:role-rank` | PASS |
| Segurança/tenant/RLS/LGPD | PASS sintético, exceto o débito de extrator de tipos abaixo |
| Evidência visual anterior | Reutilizada; J47–J50 cobrem 1440×900, 768×1024 e 390×844 |
| Chamadas externas reais | 0 |

O único teste DB reprovado foi `tests/invariants/tipo-de-coluna-x-typescript.test.ts`, caso `ai_provider_credentials_safe.provider tem o mesmo tipo que CredentialRow declara`. O extrator de teste não entende a união `ProvedorComChave | typeof CHATGPT_SUBSCRIPTION_PROVIDER`. É o débito preexistente já classificado; não foi alterado nesta auditoria e requer recuperação separada do baseline.

O teste de shell self-host foi iniciado duas vezes no host Windows. Uma execução terminou com erro do Git Bash ao criar signal pipe (`Win32 error 5`). Na repetição, o caso que verifica modo POSIX `600` de um `.env` temporário falhou no host Windows e outro subprocesso Git Bash voltou a falhar. O código do kit grava arquivos de segredo com `chmod 600`, mas esta execução Windows não prova o modo de arquivo em Linux. Isso não é evidência de defeito no produto; a confirmação desse gate deve vir do CI Linux antes da publicação.

## 4. Superfícies operacionais

| Capacidade | Resultado e condição operacional |
|---|---|
| Instalar e iniciar | PASS. Instalador/baseline aceitos; preencher ambiente Supabase, Redis, chaves de cifragem e URL/HTTPS conforme a instalação. |
| Criar organização e autenticar | PASS sintético. Sessão, organização ativa, troca de organização, RBAC e MFA têm guards e testes. |
| Canais | Adapters e contratos disponíveis. Cada canal externo exige conta, credencial, URL e/ou pareamento do respectivo fornecedor. Nenhum serviço real foi conectado nesta auditoria. |
| Inbox | PASS sintético para recepção, consulta, resposta, restrições de canal, widget, webhooks, STOP/pacing e roteamento. |
| IA e agentes | PASS sintético: providers por API, agente/publicação, runtime canônico, tools, budgets, guardrails e handoff. Credenciais de provider são configuração do operador. |
| ChatGPT por assinatura | `CHATGPT_SUBSCRIPTION_OPERATIONAL=YES`, certificação anterior reutilizada; não conectada a conta real. |
| CRM e tickets | PASS sintético/DB: contatos, empresas, pipeline, propostas, tarefas, tags, campos e passagens seguem os contratos tenant-scoped. |
| Agenda | Núcleo utilizável; agendamentos, sobreposição, timezone e RBAC têm testes. Google Calendar exige OAuth/configuração do operador. Hold 8P não bloqueia o núcleo de agenda. |
| Prospecção Google/Maps | `PROSPECTING_OPERATIONAL=YES`, certificação integrada P0-2 reutilizada; conta Apify e orçamento externo precisam ser configurados pelo operador. |
| Auditoria de site, estratégia, prévia e preparo | Certificados nas waves P0-2; mocks sintéticos nesta auditoria, sem novo tráfego externo. |
| MCP de prospecção | Certificado com contexto autenticado e isolamento por organização; resultado LGPD minimizado. |
| Reinício e recuperação | PASS por contratos de restart dos containers, idempotência/reconciliação dos workers e testes de recuperação. Nenhum restart de VPS real foi executado. |
| Atualização e rollback | PASS por certificações R2-3 reutilizadas, testes de transação e compatibilidade do instalador. Não houve update/rollback de produção. |
| Monitoramento | Health endpoint da aplicação, `/healthz` e métricas do worker, logs estruturados e scrubber Sentry existem. DSN, alertas e rotina de inspeção precisam de configuração operacional. |
| Tenant e LGPD | PASS sintético/DB: RLS, filtro manual de service role, exportação, redação, supressão, retenção e tombstone cobertos por testes/invariantes. |
| White-label | PASS pelos testes integrais e superfícies principais; nomes de fornecedor podem aparecer como parte do serviço. |

### Estado dos canais

`CONFIG_REQUIRED` significa que o produto tem a superfície de integração e que o proprietário ainda precisa conectar/configurar o serviço externo. Não significa que uma conta real foi testada.

| Canal | Estado |
|---|---|
| WhatsApp | CONFIG_REQUIRED — configurar WAHA, URL/segredo e parear sessão; não tocar nem certificar uma instância WAHA real nesta auditoria. |
| Instagram | CONFIG_REQUIRED — credencial e permissões da integração social. |
| Messenger | CONFIG_REQUIRED — conta/permissões da integração social. |
| WebChat | CONFIG_REQUIRED — publicar o widget no site e validar o domínio da instalação. |
| E-mail | CONFIG_REQUIRED — SMTP ou Resend e remetente. |
| Telegram | CONFIG_REQUIRED — credencial do bot. |
| Telegram-user | CONFIG_REQUIRED — sessão/credencial de usuário conforme o fluxo instalado. |
| TikTok | CONFIG_REQUIRED — conta/provider social e permissões. |

É necessário configurar pelo menos um canal para iniciar atendimento real; canais sem credencial permanecem indisponíveis/degradados, não bloqueiam a instalação nem os outros canais.

## 5. Ambiente, segredos e self-host

`.env.example` e `lib/env.ts` descrevem as entradas do operador com validação Zod. Supabase, segredos internos, cifragem, conexão de banco/Redis e integração WAHA exigem valores obrigatórios conforme o modo instalado; SMTP, Sentry, integrações sociais e providers de IA podem ser opcionais ou configurar-se por organização, e suas superfícies falham fechadas quando faltam credenciais. A configuração do Supabase servidor permanece separada das variáveis `NEXT_PUBLIC_*`.

Uma busca de padrões conhecidos de chaves em arquivos de runtime rastreados (`app`, `lib`, `workers`, `scripts`, `.github`) não encontrou correspondências. `.env` real e materiais de chave foram excluídos deliberadamente da inspeção; portanto, esta conclusão cobre o código de runtime rastreado, não segredos presentes em uma instalação local.

O self-host usa imagens/serviços definidos em Compose, volumes persistentes e políticas de restart/healthcheck. Em instalações atrás de proxy existente, seguir o runbook e carregar os dois arquivos Compose conforme a topologia. Runtime oficial do projeto é Node 22+; Node 24.22.1 foi usado apenas para esta validação e é compatível com o mínimo documentado.

Backup de banco, mídia e sessões precisa ser agendado pelo operador; o free tier de Supabase não oferece backup automático suficiente por padrão. O kit disponibiliza `backup.sh` e `restore.sh`, e o runbook pede teste de restauração. A existência dos scripts não prova que uma instância específica tenha cron/backups configurados.

## 6. Bloqueadores e pré-requisitos

### P0_BLOCKER

**Nenhum encontrado** para começar a usar o Clientix pelo proprietário após a configuração inicial documentada.

### P1_BEFORE_PRODUCTION

Antes de colocar uma instalação com dados reais em operação pública, o proprietário deve:

1. provisionar Supabase/Postgres, HTTPS/domínio, URLs de callback, Redis e segredos únicos da instalação; não reutilizar credenciais de teste;
2. configurar e testar ao menos um canal e um provider de IA conforme o fluxo pretendido;
3. agendar e monitorar backup do banco, arquivos e sessões relevantes, e fazer um restore drill;
4. configurar Sentry/alertas e confirmar health checks, cron e workers na própria VPS;
5. executar o gate `test:shell` em Linux/CI e verificar as permissões de arquivos secretos no filesystem Linux.

Esses passos são configuração e validação do ambiente do operador; a auditoria não acessou nem alterou produção.

### P2_POST_GO_LIVE

- Certificar integrações externas específicas e suas quotas/termos somente quando forem habilitadas na instalação.
- Priorizar melhorias futuras segundo feedback e incidentes reais; nenhuma wave funcional nova é aberta por esta auditoria.

### Débitos e itens opcionais

- **KNOWN_DEBT:** `tipo-de-coluna-x-typescript.test.ts` falha por não compreender uma união TypeScript. Requer correção separada do extrator/invariante; não corrigido aqui.
- **KNOWN_DEBT:** 540 warnings de lint, sem erros.
- **KNOWN_DEBT:** `TEST_CREDENTIAL_ROTATION_REQUIRED=YES`. Não bloqueia o produto; rotação deve anteceder operação pública com segredos reais.
- **KNOWN_DEBT:** `test:shell` não foi conclusivo no host Windows; manter verificação Linux como pré-requisito de publicação.
- **OPTIONAL:** importação CSV/XLSX P0-2E permanece `OPTIONAL/DEFERRED`, não necessária para prospecção Google/Maps.

## 7. Holds de migration

| Hold | Bloqueia o uso operacional principal? | Tratamento |
|---|---|---|
| Wave 8E2 | Não identificado como blocker do núcleo nesta auditoria. | Manter `HOLD_MIGRATION_GOVERNANCE`; recursos dependentes de sua migration continuam fora do escopo certificado. |
| Wave 8E3 | Não identificado como blocker do núcleo nesta auditoria. | Manter `HOLD_MIGRATION_GOVERNANCE`; não reabrir nem contornar. |
| Wave 8P | Não bloqueia agenda básica certificada. | Manter `HOLD_MIGRATION_GOVERNANCE`; funcionalidades específicas dependentes permanecem pendentes. |

Nenhuma migration, baseline, manifest ou schema foi alterado nesta auditoria. A ausência de import CSV/XLSX não bloqueia o go-live operacional do fluxo Google/Maps.

## 8. Decisão

- `OPERATIONAL_GO_LIVE_READY=YES` — com a configuração do proprietário descrita em P1 antes de produção pública.
- `READY_TO_START_USING_CLIENTIX=YES` — após instalar a instância própria e conectar ao menos um canal e o provider necessário.
- `PRODUCTION_PUBLIC_RELEASE_READY=NO` — esta execução não validou assinatura/publicação oficial, implantação pública nem credenciais de uma VPS específica.
- `RELEASE_READY=NOT_CLAIMED`.

Não abrir novas waves funcionais automaticamente. Trabalho futuro deve partir de bug real, necessidade operacional, feedback de uso, manutenção upstream ou feature deliberadamente priorizada.
