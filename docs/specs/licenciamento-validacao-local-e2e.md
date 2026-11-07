# Validação operacional local E2E do licenciamento

**Data:** 2026-11-06

**Ambiente:** `C:\Users\Rafael Bravik\Desktop\Clientix\.clientix-local\runtime\licensing-e2e-20261106`

**HEAD:** `71cfc3df2fa18be51043f7f248b15049eefeedf4` (inalterado)

**Decisão:** não liberar piloto em VPS; os gates finais não passaram.

## Escopo e isolamento

A wave executou o Control Plane Vendor e o runtime Customer em ambientes locais separados. O banco Vendor descartável foi executado no Docker Desktop, no projeto `clientix-license-e2e-20261106`, com volume e rede exclusivos. O app Vendor respondeu em `http://localhost:36785`; o Customer, construído a partir do artefato Customer, respondeu em `http://localhost:36786`. Portas locais auxiliares foram usadas para TLS de teste e Auth sintético.

As migrations Control Plane `0001` a `0006` foram aplicadas somente no banco Vendor descartável. O schema resultante reportou seis migrations e 24 tabelas. A assinatura usou uma chave Ed25519 sintética, restrita a este teste local; o valor privado permaneceu em `.clientix-local` e não é reproduzido neste documento. MANUAL foi o único provider habilitado; Stripe e Mercado Pago permaneceram desabilitados.

Não foi usada VPS, produção, gateway financeiro, nem a stack persistente `deskcomm-crm`. Não houve push ou commit. A árvore de produto não foi modificada nesta wave; foram adicionados o relatório, a change note e uma entrada no índice de documentação.

## Build e boundary Vendor/Customer

| Verificação                  | Resultado | Evidência                                                                                                                   |
| ---------------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------- |
| Build Vendor                 | PASS      | `vendor-build.log`                                                                                                          |
| Build Customer               | PASS      | `customer-build.log`; imagem Customer usada como runtime                                                                    |
| Varredura da imagem Customer | PASS      | 7.548 arquivos; nenhuma rota Vendor, Control Plane ou issuer; nenhum PEM privado; `/admin/license` presente; `.git` ausente |
| Ambiente Customer            | PASS      | Nenhum nome de variável Vendor ou de assinatura encontrado                                                                  |
| Chave de instalação          | PASS      | Chave privada persistida no volume Customer com modo `0600`; o cliente enviou somente a chave pública                       |

Resultado: o artefato Customer testado não continha Control Plane, rotas Vendor ou material privado de assinatura, e não expôs capacidade de emissão. Esta evidência vale para a imagem criada nesta árvore e para as varreduras executadas; não certifica um artefato de release futuro.

## Fluxo operacional exercitado

1. Login Vendor e páginas de dashboard, clientes, licenças, instalações e billing abriram.
2. Foi cadastrado um cliente sintético e emitida uma licença de teste Profissional, com validade curta, limite de uma instalação e sete dias de grace.
3. O runtime Customer gerou `installation_id` e keypair, importou a licença e ativou online. O Vendor registrou uma instalação. Challenge, attestation e validação online responderam com sucesso; o Customer ficou `ACTIVE`, com modo restrito desligado.
4. O pagamento MANUAL foi confirmado pela UI Vendor. O Vendor processou a renovação e a validação online subsequente entregou ao Customer uma revisão assinada nova, que foi validada e instalada por replace atômico, com validade atualizada.
5. Uma segunda instalação com identidade nova foi recusada com HTTP 403 para licença de `max_installations=1`; a contagem Vendor continuou em uma instalação.
6. A licença sintética foi revogada no Vendor. O estado assinado `REVOKED` chegou ao Customer; `/admin/license` exibiu modo restrito ativo e permaneceu acessível.

### Ressalva sobre reemissão após pagamento

A revisão renovada foi assinada e entregue, mas o caminho observado não prova a criação imediata do artefato no instante da confirmação de pagamento: o primeiro ciclo do scheduler reportou zero artefatos criados, e a entrega ocorreu na validação online subsequente. Além disso, depois da revogação, a revisão 4 foi entregue ao Customer como `REVOKED`, mas a linha correspondente no histórico de artefatos ficou `SUPERSEDED`; o ledger preservou dois eventos de assinatura, das revisões 2 e 3. Portanto, **a entrega foi demonstrada, mas a consistência temporal e histórica da reemissão ainda precisa ser corrigida e novamente validada**.

O retry do mesmo pagamento, a concorrência scheduler/webhook e o ciclo completo de pagamentos/reemissão não foram executados nesta wave. Não se declara idempotência operacional E2E a partir de uma única confirmação.

## Tamper, instalação duplicada e clone

- Foram alterados `expires_at`, `plan`, `installation_id` e `features`, um por vez, em cópias de teste: cada cópia foi rejeitada como `INVALID_SIGNATURE`. Reutilizar a licença com outro installation ID falhou com `INSTALLATION_MISMATCH`; a atualização atômica preservou o arquivo original válido.
- A instalação secundária com ID novo foi bloqueada pelo limite comercial.
- No teste de clone integral, estado, licença e chave privada da instalação foram copiados entre volumes locais isolados. Ao iniciar a segunda instância, o Vendor classificou o conflito como `CLONE_CONFIRMED`.
- **Falso positivo observado:** um único container Customer também abriu mais de uma sessão ativa para a mesma identidade e chegou a `SUSPECTED_CLONE`. A causa ainda não foi provada; não se deve atribuí-la a uma causa específica sem investigação. Esse comportamento também adiou a entrega da licença renovada.
- A autorização Vendor de recovery foi registrada, mas a primeira chamada de recovery do Customer respondeu HTTP 403. Após parar o clone antigo e reiniciar o container original, a nova atestação foi aceita e o estado voltou a `NORMAL`. O controle Vendor foi exercitado, mas o caminho não foi fluido nem passou de ponta a ponta sem intervenção operacional.

Conclusão: a detecção do clone simultâneo funcionou no cenário copiado; ausência de heartbeat não foi usada como prova. Ainda há um falso positivo em container único e recovery inicialmente recusado, então clone protection não está pronta para o gate de piloto.

## Relógio, expiração e modo restrito

Com relógio injetado no código e sem alterar o relógio do Windows, foram avaliados os estados locais sobre uma licença assinada:

| Instante simulado             | Estado    |         Operação licenciada | Modo restrito |
| ----------------------------- | --------- | --------------------------: | ------------: |
| Dentro da validade            | `ACTIVE`  |                   permitida |     desligado |
| Dentro dos sete dias de grace | `GRACE`   |                   permitida |     desligado |
| Oito dias após a validade     | `EXPIRED` | negada pelo avaliador local |        ligado |

Isso valida a função de avaliação de datas com clock injetado, não uma espera real até a expiração. A renovação foi realizada antes do vencimento real; **reativação após expiração não foi exercitada**. O estado `REVOKED` foi aplicado online e o Customer continuou mostrando `/admin/license` e `/login`.

Uma tentativa de provar o bloqueio de uma operação comercial real foi feita em `POST /api/v1/admin/tenants`, mas o Customer respondeu HTTP 404 (rota indisponível no runtime exercitado). Assim, a UI e o avaliador restrito foram observados, mas o bloqueio operacional de uma rota comercial real não foi comprovado nesta wave.

## Persistência e restart

Após parar e subir novamente os componentes locais ativos — DB Vendor, app Vendor, bordas locais/Auth e Customer principal — `/login` do Customer respondeu 200; os dados Vendor de cliente, licença, pagamento e instalação persistiram. A licença revogada continuou instalada e `/admin/license` permaneceu acessível. O Customer secundário e o clone foram deixados parados após os testes. O teste de restart cobre os componentes ativos desta wave, não uma recuperação independente a partir de backup.

Backup custom-format do DB Vendor de teste:

- Arquivo: `.clientix-local/backups/licensing-e2e-20261106/clientix-vendor-local-e2e-final-20261106.dump`
- Tamanho: `199974` bytes
- SHA-256: `f1b0c90bbf62212a10098b64a69d7583d728a36090f3ebaa2dee3df4da26ee70`
- `pg_dump`: PASS; catálogo `pg_restore --list`: PASS, 206 entradas.

Esse backup é somente evidência de teste local, não é backup de produção.

## QA visual

QA visual real foi executado com dados e sessão sintéticos:

- Vendor: dashboard/billing, lista e detalhe de licença, clientes, instalações, lista e detalhe de invoice. 1366×768 sem overflow horizontal; 390×844 sem overflow nas listas consultadas.
- Customer: `/admin/license` nos estados ativo e revogado, desktop e mobile. Estado ativo mostrou plano/validade/instalação mascarada; estado revogado mostrou `REVOKED`, modo restrito ativo e manteve a página disponível.

As capturas ficam no diretório operacional ignorado `.clientix-local/runtime/licensing-e2e-20261106/`, não no Git.

## Testes e falhas encontradas

O conjunto focado de 14 arquivos de teste de licensing/boundary terminou com **12 arquivos aprovados e 2 reprovados; 127 testes aprovados de 129**:

1. `tests/unit/license-admin-api.test.ts` — “requires Platform Admin for status and validation”: esperava HTTP 403, recebeu 200. O mock do teste cobre `requirePlatformAdmin`, enquanto a rota chama `requirePlatformAdminEscrita`; a classificação como falha preexistente ou regressão não foi provada.
2. `tests/unit/licensing-installation-auth.test.ts` — “keeps a recovery key pending until vendor authorization is committed”: divergência de igualdade somente por newline final em `privateKeyPem`. A classificação como falha preexistente ou regressão não foi provada.

O build Vendor e o build Customer passaram. `typecheck` e `lint` não foram executados novamente nesta wave. Não houve correção de código nesta validação.

Depois de gravar o relatório, `tests/unit/documentacao-aponta-para-o-que-existe.test.ts` passou (4/4), confirmando os paths acrescentados ao índice.

## Decisão operacional

| Gate                        | Resultado                  | Motivo                                                                                                |
| --------------------------- | -------------------------- | ----------------------------------------------------------------------------------------------------- |
| Operação Vendor local       | PASS                       | UI, emissão, cobrança MANUAL, instalação, eventos e restart exercitados                               |
| Boundary Customer           | PASS para a imagem testada | scan sem Control Plane, rotas Vendor ou chave privada                                                 |
| Emissão e ativação          | PASS                       | assinatura local de teste, ativação e atestação online funcionaram                                    |
| Renovação/entrega           | PARCIAL                    | licença renovada e instalada; criação imediata não provada e ledger da revisão revogada inconsistente |
| Expiração e grace           | PASS, via clock injetado   | avaliação local ACTIVE/GRACE/EXPIRED exercitada sem alterar relógio do host                           |
| Restricted mode operacional | PARCIAL                    | página/login e estado restrito visíveis; rota comercial testada respondeu 404                         |
| Clone protection            | PARCIAL                    | clone integral detectado, mas houve falso positivo em um container e recovery inicial 403             |
| Testes focados              | BLOQUEADO                  | 2 falhas em 129; classificação ainda desconhecida                                                     |
| Pronto para piloto VPS      | **NO**                     | gates de reemissão, operação restrita, clone/recovery e suíte ainda não estão totalmente verdes       |

**Conclusão:** esta wave prova uma parte substancial do fluxo local, incluindo build Customer, boundary, emissão, ativação, renovação entregue, assinatura/tamper, limite de instalações, clone integral detectado, avaliação de grace/expiração e cold restart. Ela **não** conclui a validação E2E exigida para VPS. Investigar o falso positivo de sessão, corrigir e provar o recovery sem falha inicial, persistir corretamente a versão revogada, demonstrar o bloqueio de uma operação licenciada real e resolver/classificar as duas falhas dos testes antes do piloto.

```text
VPS_USED=NO
PRODUCTION_TOUCHED=NO
PAYMENT_GATEWAY_USED=NO
PERSISTENT_DESKCOMM_TOUCHED=NO
MIGRATIONS_APPLIED_TO_DESKCOMM=NO
COMMITS_CREATED=0
PUSH=NO
READY_FOR_VPS_PILOT=NO
PUBLIC_RELEASE_READY=NO
```

## Correções dos bloqueios E2E — 2026-11-06

Esta seção atualiza a decisão operacional acima. As seções anteriores preservam o registro da primeira execução; os bloqueios daquela execução foram tratados e os gates abaixo são os resultados finais desta wave.

### Clone falso positivo e recovery

A identidade de sessão era mantida em estado de módulo. Bundles de rota distintos podiam criar sessões diferentes dentro do mesmo processo Customer. Além disso, sessões antigas ainda marcadas como `ACTIVE` no banco eram consideradas concorrentes sem evidência de heartbeats realmente sobrepostos.

O estado da sessão agora é compartilhado pelo processo através de `globalThis` e um `Symbol` estável. A detecção do Control Plane só considera sobreposição quando as duas sessões enviaram heartbeat após o início da outra; uma linha antiga sem heartbeat concorrente não basta para classificar clone.

Evidências no Vendor descartável:

- Um Customer, uma installation ID, uma keypair e uma sessão ativa permaneceram `NORMAL`.
- Um restart rápido criou uma nova sessão sem marcar clone; as duas linhas de sessão puderam coexistir sem conflito.
- A cópia integral dos volumes de estado e licença foi comparada byte a byte. Com dois containers e sessões diferentes enviando heartbeat, o estado passou a `CLONE_CONFIRMED`.
- O Vendor autorizou recovery; o Customer original concluiu `/api/v1/admin/license/recover` com HTTP 200, voltou a `NORMAL` e permaneceu `ACTIVE`. O `StartedAt` do container não mudou, então não houve restart. A sessão e a chave local foram renovadas somente depois da autorização Vendor.

A primeira chamada de recovery desta rodada usou o `APIRequestContext` do Playwright, que não satisfez a proteção same-origin do handler. Repetindo pelo `fetch` da página Customer autenticada, o fluxo real passou sem alteração de origem ou bypass.

### Reemissão imediata e reativação

O primeiro pagamento MANUAL foi confirmado em uma invoice sintética. Antes de qualquer validação online subsequente, o banco Vendor já continha a revisão 4 do artefato com status `ISSUED`, `signed_at`, hash de payload e hash do artefato. `created_at` era posterior à última validação Customer; portanto o artefato foi persistido no fluxo de pagamento e antes da próxima validação.

Para testar reativação sem esperar a expiração real, somente a licença sintética do banco Vendor descartável recebeu `valid_from` anterior e `expires_at` oito dias no passado. O relógio do Windows não foi alterado. O Customer aplicou a revisão vencida e entrou em modo restrito. A rota real `POST /api/v1/messages` respondeu `403 license_restricted`; com a licença ativa, a mesma rota passa pelo guard de licença e chega ao comportamento normal de autorização do tenant (`403 forbidden_tenant` para este usuário sintético sem tenant ativo), em vez de responder `404`.

Depois foi criada outra invoice MANUAL e confirmado um pagamento. Sem nova validação online, a revisão 6 já estava persistida como `ISSUED`, assinada, com hash e validade futura; `last_validation_at` ainda era anterior ao pagamento. Na validação seguinte, o Customer recebeu e aplicou atomicamente a revisão 6: `/admin/license` voltou a `ACTIVE`, o modo restrito desligou, e `POST /api/v1/messages` voltou ao resultado normal `forbidden_tenant`.

### Falhas unitárias anteriores

As duas falhas `127/129` foram registradas antes desta rodada e, portanto, classificadas como `PREEXISTING_FAILURE`:

1. `tests/unit/license-admin-api.test.ts` — `requires Platform Admin for status and validation`: mock do teste substituía `requirePlatformAdmin`, mas a rota usa `requirePlatformAdminEscrita`. O mock foi alinhado ao guard efetivo.
2. `tests/unit/licensing-installation-auth.test.ts` — `keeps a recovery key pending until vendor authorization is committed`: comparação de PEM diferia somente pela newline final. A leitura/gravação da keypair de recovery agora normaliza o PEM antes da comparação.

O conjunto focado final terminou em **15 arquivos e 97/97 testes aprovados**. `typecheck` completo e ESLint do escopo passaram. Prettier foi aplicado aos arquivos do escopo e a este relatório.

### Build, boundary e decisão final

- Vendor build: `PASS` com URLs HTTPS de placeholder e sem carregar `.env*`.
- Customer certification build: `PASS`; trust root pública de teste `DEV_ONLY` fornecida por arquivo local, sem chave privada no build.
- Customer artifact scan: `PASS`, 89.054 arquivos na imagem final, sem marcador Vendor, rota Vendor ou PEM privado; `/admin/license` presente e `.git` ausente.
- A imagem Customer final iniciou e `GET /login` retornou HTTP 200. O E2E de ativação, clone, recovery, renovação, expiração e reativação foi realizado em containers e banco Vendor descartáveis.

```text
LOCAL_CLONE_FALSE_POSITIVE_FIXED=YES
LOCAL_RECOVERY_WITHOUT_RESTART_VALIDATED=YES
LOCAL_IMMEDIATE_SIGNED_REISSUE_VALIDATED=YES
LOCAL_RESTRICTED_MODE_OPERATIONAL_VALIDATED=YES
LOCAL_REACTIVATION_VALIDATED=YES
FOCUSED_TEST_FAILURES_RESOLVED_OR_CLASSIFIED=YES
LOCAL_SECURITY_VALIDATION_COMPLETE=YES
LOCAL_END_TO_END_LICENSE_FLOW_COMPLETE=YES
READY_FOR_VPS_PILOT=YES
PUBLIC_RELEASE_READY=NO
PERSISTENT_DESKCOMM_TOUCHED=NO
PRODUCTION_TOUCHED=NO
VPS_USED=NO
PAYMENT_GATEWAY_USED=NO
MIGRATIONS_CREATED=NO
COMMITS_CREATED=0
PUSH=NO
```
