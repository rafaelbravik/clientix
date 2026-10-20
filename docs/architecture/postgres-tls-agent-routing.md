# PostgreSQL TLS e seleção de agente pausado

Este documento registra as adaptações de TLS PostgreSQL e seleção de agente revisadas no Clientix. A migration 0515 completa a allowlist de EXECUTE do worker para helpers chamados por triggers; não altera tabelas nem RLS.

## PostgreSQL

As conexões PostgreSQL do app, worker, Control Plane, migrator e bancos externos usam a mesma classificação de host em `scripts/lib/postgres-tls-policy.cjs`.

- `LOCAL_LOOPBACK`: `localhost`, endereços `127.0.0.0/8` e `::1` (inclusive a forma IPv6 expandida, normalizada antes da decisão).
- `LOCAL_DOCKER_NETWORK`: somente `supabase-db`, serviço alcançável pela rede privada adicionada por `docker-compose.single-server.yml`.
- `REMOTE`: todo o restante, incluindo RFC1918, IPv6 não-loopback, nomes privados e hosts públicos. Endereço privado não prova que a rede é confiável.

Loopback e `supabase-db` podem usar plaintext porque a arquitetura os mantém locais/na bridge privada. Todas as outras conexões exigem TLS e validam cadeia e hostname. `sslmode`/`sslrootcert` fornecidos na URI não podem enfraquecer a política dos clientes Node. Os utilitários libpq normalizam a URI para `sslmode=verify-full`; URLs com chaves TLS codificadas são recusadas para evitar bypass de parsing.

O sistema de CA do Node/libpq é usado por padrão. Para autoridade privada, `POSTGRES_SSL_ROOT_CERT` recebe o PEM público codificado em base64 no ambiente de runtime. O valor não entra em imagens nem é registrado em logs. O helper do banco externo recusa `ssl_mode=disable` para hosts remotos; `prefer` e `require` remotos passam a validar o certificado, em vez de aceitar TLS sem autenticação do servidor.

## Estados e seleção de agentes

Estados efetivos conforme o schema e as rotas atuais:

- `mcp_agent` publicado, não arquivado e `paused_at IS NULL`: ativo.
- `mcp_agent` publicado com `paused_at IS NOT NULL`: pausado; nunca executável.
- `rag_bot` legado usa também `is_active`; `false` o exclui da seleção.
- versão não publicada ou agente arquivado: indisponível/deletado para novos turnos.

Na seleção por sessão, o SQL ordena primeiro os não pausados e depois preserva `priority DESC, created_at ASC`. Linhas pausadas só podem sair do loader quando não existe candidato ativo, permitindo que o guard pare o turno sem cair na IA genérica. Para um membro pausado do router, a ordem de fallback existente é preservada: fallback explícito do router, depois o agente ativo publicado da sessão. Uma campanha cujo agente foi pausado segue essa mesma régua.

Se nenhuma alternativa estiver ativa, o objeto pausado permanece como sentinela: o inbound não chama modelo nem cria rascunho. O modo assistido ainda executa as detecções determinísticas de opt-out/handoff antes de parar a geração do rascunho. O gate de handoff humano roda antes da seleção; um fallback não retoma IA em conversa transferida. Tenant, canal, elegibilidade, orçamento e entitlement continuam nos mesmos carregadores e guards existentes.

## Evidência upstream

REA/Deskcomm foram consultados como referência comportamental a partir dos artefatos locais de G1.4.4 em `C:\Clientix-Upstream\G1.4.4-20261016\`. Não houve cópia substancial de código upstream; a adaptação usa os loaders e contratos próprios do Clientix. Não foi introduzido novo requisito de atribuição MIT.
