# Política local de QA do Clientix

Esta política registra como validar novas waves sem repetir a certificação histórica inteira.
Ela não declara release readiness e não substitui os gates exigidos pela superfície alterada.

## Método

O método de integração é **UPSTREAM-PROVEN → CLIENTIX-INTEGRATED**:

1. Localizar a implementação upstream mergeada, seus fixes posteriores e os testes que provam o comportamento.
2. Comparar apenas as diferenças de arquitetura e contratos do Clientix: tenant/RLS, permissões, provider, workers, scheduler, storage, API, auditoria e LGPD.
3. Portar/adaptar os testes upstream aplicáveis e acrescentar testes somente para invariantes exclusivos do Clientix.
4. Registrar o nível de risco e executar validação proporcional ao delta.

Use **DELTA-BASED VALIDATION**. Uma mudança cobre código novo, módulos diretamente tocados, dependências diretas e invariantes de segurança afetados. Não repita `test:db`, `test:unit` ou a auditoria visual integral por formalidade quando o delta não os alcança.

Um bloco volta ao escopo somente quando um arquivo seu é alterado, seu contrato/dependência muda, uma migration relacionada muda, um teste de integração falha ou um defeito é reproduzido. Nos demais casos, marque-o `VALIDATED_BASELINE` e registre a justificativa.

## Baseline validado

Os blocos abaixo foram certificados em waves anteriores. Essa lista é um ponto de partida para análise de delta, não uma declaração de que cada instalação ou release foi certificada.

| Bloco | Comportamentos no baseline |
|---|---|
| R2-1 | Limite `max_tenants` |
| R2-2 | Ingress HTTPS seguro |
| R2-3 | Updater e rollback |
| R2-4A | Contrato da matriz de imagens |
| MFA | Recovery codes server-only e hardening MFA |
| Moeda e health | Parsing por moeda da organização; identidade semântica no health |
| Tarefas | Visão Minhas, responsável e isolamento por tenant |
| CRM | Mudança de etapa pelo dossiê; Lista paginada; recorte de negócios encerrados antigos no quadro |
| Follow-up | Cancelamento dormente e proteção contra corrida |
| WhatsApp | Importação histórica idempotente, validação de identidade/tenant e ausência de automação para replay histórico |
| Campos de arquivo | Anexos privados, purge LGPD e enforcement de campo obrigatório na etapa |
| Wave 1 | Nodemailer, preservação SMTP, retry CAS, atualização atômica/auditada de knowledge source, pausa de IA em envio humano via API e hardening de CPF |
| Wave 2 | Idioma da conversa nas tools, admissão por palavra-chave e mídia MCP com capability temporária |
| Wave 3 | Etapa inicial do Inbox, roteiro iniciado por etapa no próximo turno e relógio/cadência de espera humana |
| Wave 4 | Lista do funil e cutoff de negócios encerrados no quadro |

Provenance R2-4B é um artefato independente: não deve ser incluído, alterado ou limpo como parte de uma wave sem escopo explícito.

## Runtime QA e Docker

- Manter um único runtime de aplicação Clientix ativo por vez; preferir `http://localhost:3001` quando disponível. Serviços de dependência (por exemplo, Postgres/Supabase) não contam como runtimes de aplicação.
- Nomear o projeto Compose local como `clientix-qa` e reutilizar a imagem existente quando o HEAD não mudou.
- Nomear a imagem `clientix-qa:<short-sha>`. Em containers QA, aplicar os labels `clientix.qa=true`, `clientix.head=<sha>`, `clientix.schema=<nnnn>` e `clientix.wave=<wave>`; builds locais sujas devem permanecer inelegíveis para release.
- Antes de substituir runtime, identificar portas, imagem/digest, source head, schema, mounts e dependências. Parar é reversível; remover exige classificação explícita `DELETE_SAFE`.
- Classificar cada recurso como `KEEP`, `DELETE_SAFE`, `ARCHIVE_EVIDENCE` ou `UNKNOWN`. Só remover `DELETE_SAFE`. Preservar volumes de banco, storage, WAHA, certificados, rollback ou evidência. Nunca usar comandos globais de prune para consolidar o ambiente.
- Não reconstruir a mesma imagem/HEAD sem uma razão registrada. Se a origem do runtime não puder ser provada, registrar `UNKNOWN` em vez de atribuir-lhe um SHA.

## Fixtures, autenticação e evidências

- Fixtures sintéticas usam o prefixo `QA —` ou um identificador técnico equivalente e registram `created_for`, `wave` e `cleanup_required`.
- Limpar somente dados criados pela wave atual e identificados como descartáveis. Fixture sem origem comprovada fica `UNKNOWN` e permanece intacta.
- Usar usuário sintético local quando possível. Storage state do Playwright, cookies, senhas, tokens e outros dados de autenticação ficam fora do Git; nunca registrar seus valores em logs ou evidências.
- Para QA visual, usar um runtime único e os viewports `1440×900`, `768×1024` e `390×844`. Registrar screenshot, erros de console, requests com falha e overflow relevante. Apagar screenshots intermediárias somente após separar as evidências de certificação e failures que precisam ser preservadas.
- A tela deve ser exercitada como usuário real. Um endpoint HTTP saudável ou uma resposta `curl` não substitui a prova visual quando o delta altera UI/fluxo.

## Nível de validação por risco

| Nível | Escopo típico | Validação proporcional |
|---|---|---|
| 1 | UI ou mudança de baixo risco | Testes focados, typecheck/lint e prova visual quando a UI muda |
| 2 | Lógica de produto | Testes focados, unitários afetados e governança |
| 3 | Banco, RLS ou worker | Testes focados, invariantes DB, `test:db`, unitários afetados e governança |
| 4 | Segurança, tenancy ou IA | Nível 3 + probes de segurança, concorrência e testes de tenant/RLS afetados |
| 5 | Release, instalação, infra ou licensing | Processo integral da superfície, incluindo gates de shell/packaging quando aplicável |

Não use retry global, timeout maior, skip ou expectativa enfraquecida para converter falha em verde. Registre comandos, resultados, skips, duração e warnings relevantes; não repita gates pesados sem vínculo com o delta.
