# Certificação final integrada — prospecção

**Data:** 2026-11-01
**Base:** `5fe9f44b71a15c32b7f037dbe1b9cf1fc2100a86`
**Schema:** `9059`
**Upstream de referência:** `1b429e42009a90a32bd7b8694055da4c1e4c0278`

## Resultado

**P0-2 final certification: PASS**, com o débito de baseline conhecido e isolado em `tests/invariants/tipo-de-coluna-x-typescript.test.ts`. A suíte DB integral não revelou outra falha. Nenhum produto, migration, baseline, manifest ou evidência visual foi alterado nesta certificação.

O fluxo Google/Maps via Apify, auditoria segura, estratégia determinística, prévia com agente publicado, preparação automática, consulta MCP, isolamento por organização e controles LGPD estão cobertos pelas waves P0-2A, P0-2B, P0-2C, P0-2D e P0-2F já certificadas, pela suíte focada repetida nesta base e pelos invariantes de banco executados nesta certificação.

P0-2E (importação CSV/XLSX) permanece opcional/deferida. A certificação não declara release ready. A próxima etapa permitida é a auditoria operacional final.

## Fluxo certificado

- **Fonte:** provider `apify`, identificado na interface como Google Maps / Places via Apify; Actor fixo `compass~crawler-google-places`, endpoint canônico `https://api.apify.com/v2/`.
- **Credencial e tenant:** token sintético cifrado no armazenamento existente por organização. A seleção do provider e as operações usam a organização autenticada; nenhum token é exibido ou enviado ao browser.
- **Busca e custo:** budget por busca preservado; `maxTotalChargeUsd` enviado ao Actor; `cost_usd` exibido apenas quando retornado pela Apify e separado do custo de IA. Timeout ambíguo não repete automaticamente a criação de uma execução paga.
- **Candidatos:** normalização e deduplicação preservam escopo de organização; payload bruto do provider não é persistido.
- **Auditoria de site:** fetch GET limitado, SSRF guard com revalidação de redirects e DNS pinning, TLS validado, limite de corpo e filtro de content-type. HTML bruto não é persistido. Agregadores, resultado provisório e fatos definitivos permanecem distintos.
- **Estratégia e prévia:** estratégia determinística baseada em auditoria; conteúdo externo permanece dado não confiável. A prévia usa a fonte única `gerarPreviaDoCandidato`, agente publicado da própria organização e runtime canônico. A prévia não envia mensagem e pode ficar stale após mudança da auditoria ou do agente.
- **Assinatura ChatGPT:** `openai-assinatura` é exercitado por token OAuth sintético, modelo autorizado da organização e Responses API mockada; não usa chave paga nem credencial `openai` como fallback.
- **Preparação automática:** auditoria e prévia são tarefas distintas com limites, persistência, idempotência, retomada após falha e progresso justo por organização. A preparação não seleciona candidato nem envia mensagens.
- **MCP:** `crm_get_prospecting_site_audit` deriva organização e contato do contexto do turno, consulta candidate por `organization_id + contact_id`, minimiza a saída e distingue audit provisória de definitiva. Preview stale não é devolvida como atual.
- **LGPD:** invariantes focados confirmam escopo dos dados de prospecção, redação, supressão, retenção e tombstone sem ampliar schema nem alterar a política vigente.

## Prova sintética e visual

Os testes mockam Apify, Google, sites externos e OpenAI. A prova composta adicional conectou `pickToolsFromMcp` ao `runModelCall` da assinatura, percorreu uma tool call de auditoria e terminou a Responses API mockada com `response.completed`: **1/1 passou**. O arquivo de teste temporário foi removido depois da execução; não ficou teste ou código novo no worktree.

As evidências visuais certificadas das waves anteriores foram reutilizadas. J47–J50 em [`user-journey-map.md`](user-journey-map.md) registram a cobertura desktop 1440×900, tablet 768×1024 e mobile 390×844, os estados principais e as capturas existentes em `evidence/p0-prospecting-a/` até `evidence/p0-prospecting-d/`. São 37 arquivos de evidência nessas quatro pastas. A suíte de citações de evidência passou. Não foram necessárias novas capturas porque nenhuma UI mudou.

O harness visual e os testes usaram dados sintéticos. Os registros das waves não apontam erros de console ou rede e confirmam zero requests reais para Apify, Google, websites ou OpenAI.

## Validação executada

Ambiente: Node `v24.22.1`, libuv `1.52.1`, PostgreSQL 15 efêmero para `test:db`.

| Gate | Resultado |
|---|---|
| Unitários focados de prospecção, site, worker, MCP, LGPD e runtime de assinatura | PASS — 22 arquivos, 257 testes |
| Prova composta MCP + runtime ChatGPT por assinatura | PASS — 1 teste sintético temporário |
| Invariantes DB focados: prospecção, tenant, LGPD, retenção e MCP | PASS — 6 arquivos, 33 testes |
| `test:db` integral | PASS_WITH_PREEXISTING_BASELINE_REGRESSION — 372 arquivos passaram; a única falha foi o débito descrito abaixo |
| `test:unit` integral | PASS, exit 0 — 1.869 arquivos passaram, 1. skip; 19.111 testes passaram, 1 expected fail e 5 skips |
| `typecheck` | PASS |
| `lint` | PASS — 0 erros; 540 warnings existentes no baseline |
| `lint:channels` | PASS |
| `lint:role-rank` | PASS |
| `tests/unit/installer-compatibility.test.mjs` | PASS / PASS — duas execuções |
| `tests/unit/evidencia-citada.test.ts` | PASS — incluído nos testes focados |
| `git diff --check` | PASS |

### Débito de baseline fora do escopo

`tests/invariants/tipo-de-coluna-x-typescript.test.ts` falha ao extrair o tipo `ProvedorComChave | typeof CHATGPT_SUBSCRIPTION_PROVIDER` para `ai_provider_credentials_safe.provider`. A falha é a regressão preexistente formalmente conhecida; esta wave não a corrigiu. `BASELINE_TYPE_COLUMN_RECOVERY_REQUIRED=YES`.

## Schema, escopo e próximos passos

- Schema permanece `9059`; migration `20261031202143_9059_publish_chatgpt_subscription.sql`, baseline, `MANIFEST.md` e `manifest.json` estão coerentes. Esta certificação não alterou nenhum deles.
- `MIGRATION_REQUIRED_FOR_THIS_WAVE=NO`.
- `IMPORT_CSV_XLSX_STATUS=OPTIONAL_DEFERRED`.
- Os bloqueios administrativos de migration para Waves 8E2, 8E3 e 8P permanecem inalterados.
- Nenhuma funcionalidade, conta real, provedor real ou ambiente de produção foi usado ou modificado.
- `READY_FOR_FINAL_OPERATIONAL_GO_LIVE_AUDIT=YES`.
- `RELEASE_READY=NOT_CLAIMED`.
