#!/usr/bin/env bash
# Lê caminhos (um por linha) na entrada e responde `sim` se ALGUM deles pode
# mudar ou quebrar uma das três imagens (app, worker, scheduler); `nao` só
# quando TODOS estão na lista abaixo. Entrada vazia responde `sim`: não saber o
# que mudou nunca pode virar "não precisa construir".
#
# Usado pelo publish-image.yml em pull_request, para não gastar 3 builds Docker
# num PR que só mexe em documentação ou teste. A lista é de quem NÃO alcança a
# imagem, e não de quem alcança, de propósito: o `Dockerfile.worker` faz
# `COPY . .` e o `next build` do app typecheca todo `**/*.ts` do contexto
# (tsconfig.json), então praticamente qualquer arquivo de código pode quebrar
# uma imagem. Errar para o lado de "construir" custa um build; errar para o
# outro deixa passar imagem quebrada com `imagens-ok` verde.
#
# Cada entrada, e por quê:
#   - o que o `.dockerignore` exclui: nem entra no contexto de build, então
#     nenhum Dockerfile o enxerga. A lista abaixo repete o `.dockerignore`, e
#     tests/unit/pr-mexe-na-imagem.test.ts reprova se as duas divergirem.
#   - `.github/**/*.{yml,yaml,md}`, menos o próprio publish-image.yml: entra no
#     contexto (o worker o carrega inerte), mas nenhum passo de build lê YAML
#     nem markdown. `.ts` sob `.github/` NÃO está aqui — o `next build` o
#     typechecaria.
#   - `*.md` na RAIZ: inerte pela mesma razão; nenhum módulo importa markdown da
#     raiz (o CHANGELOG que a tela mostra chega do agente do host, não do disco
#     da imagem). Markdown em subdiretório fica de fora da regra: há código que
#     lê `.md` do próprio disco (lib/agent-engine/playbooks/*.md).
set -euo pipefail

algum=nao
while IFS= read -r caminho || [ -n "$caminho" ]; do
  [ -z "$caminho" ] && continue
  algum=sim
  # Docker normaliza a barra inicial/final dos padrões do .dockerignore; os
  # caminhos de git diff chegam relativos e sem barras de moldura.
  caminho="${caminho#/}"
  case "$caminho" in
    .github/workflows/publish-image.yml) echo sim; exit 0 ;;
    # Código TypeScript sob .github permanece relevante para o typecheck do app.
    .github/*.ts | .github/**/*.ts) echo sim; exit 0 ;;
    # ↓ espelho do .dockerignore — os diretórios. Padrão de .dockerignore sem
    # barra casa só na RAIZ do contexto, e `*` de `case` atravessa `/`: por
    # isso todo padrão aqui começa pelo nome do diretório da raiz.
    evidence | .superpowers | clientix-customer-build-output | .clientix-customer-build-* | .clientix-local \
      | node_modules | .pnpm-store | .next | .git | .github | test-results | tests \
      | .lina | docs | tasks | scratchpad | .vercel | .claude | .agents | .agent \
      | .codex | .cursor | .opencode | .specs | .changes) ;;
    node_modules/* | .pnpm-store/* | .next/* | .git/* | test-results/* | tests/* | .lina/* \
      | docs/* | tasks/* | scratchpad/* | .vercel/* | .claude/* | .agents/* \
      | .agent/* | .codex/* | .cursor/* | .opencode/* | .specs/* | .changes/* \
      | evidence/* | .superpowers/* | clientix-customer-build-output/* \
      | .clientix-customer-build-*/* | .clientix-local/*) ;;
    # Diretórios/arquivos secretos e locais excluídos em qualquer profundidade.
    */.env | */.env/* | */.env.* | */.env.*/amostra \
      | */.npmrc | */.npmrc/* | */.pypirc | */.pypirc/* | */.netrc | */.netrc/* \
      | */*.key | */*.key/* | */*.p8 | */*.p8/* | */*.p12 | */*.p12/* \
      | */*.pfx | */*.pfx/* | */*.pem | */*.pem/* \
      | */id_ed25519 | */id_ed25519/* | */id_ecdsa | */id_ecdsa/* \
      | */id_rsa | */id_rsa/*) ;;
    .github/*) ;;
    # Arquivos de teste co-localizados e os dois scripts de validação do kit não
    # entram nas imagens; alterações neles não exigem rebuild do app.
    **/*.test.ts | **/*.test.tsx | **/*.test.js | **/*.test.sh \
      | hostgator-setup-kit/test-validators.sh) ;;
    .github/*.yml | .github/*.yaml | .github/*.md) ;;
    # Artefatos de auditoria/documentação no contexto raiz não são runtime.
    AUDIT_REPORT.md | AUDIT_REPORT.md/* | CLIENTIX_R*.md | CLIENTIX_R*.md/* \
      | MANUAL-*.md | MANUAL-*.md/* | REMEDIATION_PLAN.md | REMEDIATION_PLAN.md/* \
      | ROADMAP-CLIENTIX.md | ROADMAP-CLIENTIX.md/* \
      | reports | reports/* | manuals | manuals/* | certification | certification/*) ;;
    # Qualquer caminho aninhado entra na imagem, salvo padrões acima que
    # representam exclusões em qualquer profundidade.
    */*) echo sim; exit 0 ;;
    # ↓ espelho do .dockerignore — os arquivos da raiz.
    .env | .env/* | .env.* | .env.*/amostra | .npmrc | .npmrc/* | .pypirc | .pypirc/* \
      | .netrc | .netrc/* | .e2e-creds.json | playwright.config.ts \
      | ubuntu-local-installer.sh | github-history.bundle | CONTINUACAO-LINUX-MINT.md \
      | *.png | *.log | *.tsbuildinfo) ;;
    *.md) ;;
    *) echo sim; exit 0 ;;
  esac
done

# Nenhuma linha lida: não sei o que mudou, então constrói.
if [ "$algum" = nao ]; then echo sim; else echo nao; fi
