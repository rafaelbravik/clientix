# ADR-0006 — Acesso privado às imagens do GHCR

- **Status:** Aceita
- **Data:** 2026-11-24
- **Decisores:** Dono do produto
- **Lei decorrente:** [doutrina de packaging](../doctrine/packaging.md) e [runbook de GHCR privado](../runbooks/ghcr-privado.md)

## Contexto

O repositório de código Clientix é público, mas os pacotes com as imagens do produto não
precisam ser baixáveis anonimamente. A instalação self-host usa imagens publicadas pelo CI;
uma licença `ACT_...` valida a instalação, mas não autentica o Docker no GHCR. O workflow de
release também precisa conferir as imagens sem transformar os pacotes em públicos.

A decisão anterior de packaging documentou um estado operacional em que os pacotes eram
públicos. Esse estado não expressa mais a política de distribuição aprovada.

## Decisão

1. Manter privados os seis pacotes de imagem publicados: `clientix-app`,
   `clientix-worker`, `clientix-scheduler`, `clientix-voice-agent`,
   `clientix-migrator` e `clientix-ingress`.
2. Não habilitar **Inherit access from source repository**. O repositório público não deve
   conceder leitura anônima aos pacotes.
3. O dono concede **Read** por pacote à conta GitHub do cliente. Para baixar, o cliente usa
   um Personal access token (classic) com `read:packages`; o instalador lê o token de forma
   oculta e o Docker o persiste no arquivo de credenciais do mesmo usuário, fora de `.env`.
4. O instalador e o atualizador verificam o acesso antes de começar trabalho de instalação/
   atualização. O modo não-interativo falha com uma instrução de login, sem solicitar nem
   gravar uma credencial em arquivo do produto.
5. O job de release recebe `packages: read` e usa o `GITHUB_TOKEN` para verificar os
   digests das imagens. A permissão do workflow não é compartilhada com clientes.
6. A licença `ACT_...` e a autorização de leitura no GHCR permanecem controles separados.

## Consequências

- O cliente precisa de uma conta GitHub autorizada e um PAT clássico para a primeira
  instalação e para atualizações automatizadas. A configuração Docker precisa persistir no
  mesmo usuário que executa o instalador e o cron.
- Uma conta com **Read** pode baixar e copiar os pacotes; o código do repositório continua
  público e pode ser clonado/construído. Esta decisão bloqueia downloads anônimos dos
  artefatos publicados, mas não é DRM nem prova de licença.
- Para distribuição sem conta GitHub do cliente ou para revogação por instalação, será
  necessário um registry/proxy controlado pelo produto, com autenticação e vínculo à licença.
