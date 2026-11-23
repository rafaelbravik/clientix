#!/usr/bin/env bash
#
# `next build` com o ambiente do E2E (Supabase LOCAL).
#
# ═══ POR QUE NÃO `node --env-file=.env.e2e next build` ═══
#
# Medido: o build morre com
#   ERR_WORKER_INVALID_EXEC_ARGV: --env-file= is not allowed in NODE_OPTIONS
# O `next build` cria Workers, e o Node recusa propagar `--env-file` para eles.
# Exportar no shell resolve porque aí são variáveis de ambiente de verdade, que
# os Workers herdam — e que têm precedência sobre os arquivos `.env*` que o Next
# carrega sozinho (é o que impede o `.env.local`, apontado para produção, de
# vencer).
#
# ═══ POR QUE O BUILD PRECISA DISTO E NÃO SÓ O START ═══
#
# As três `NEXT_PUBLIC_*` são embutidas no BUNDLE aqui. Buildar com o
# `.env.local` e depois trocar o env só no `next start` deixaria a URL de
# produção dentro do JavaScript que roda no browser: o servidor falaria com o
# banco local e o cliente com a nuvem, no mesmo teste.
set -euo pipefail

cd "$(dirname "$0")/.."

# ═══ O INSTRUMENTO, ANTES DO TRABALHO ═══
#
# Mesma classe de `scripts/test-db.sh` (issue #1351): o binário que faz o
# trabalho pode não estar instalado, e o script só descobre isso no instante da
# chamada — DEPOIS de já ter anunciado `==> Buildando contra ...` —, com o erro
# genérico do `pnpm` no lugar de uma frase que diga qual binário falta.
#
# A guarda olha o ARQUIVO, não o PATH: medido, `pnpm exec` resolve
# `node_modules/.bin` sozinho (sai 0 mesmo com `node_modules/.bin` fora do
# PATH), então um `command -v next` recusaria uma chamada que funcionaria.
# Não instala nada nem mexe no PATH: RECUSA, nomeando o binário ausente.
if [ ! -x node_modules/.bin/next ]; then
  echo "ERRO: \`next\` não está instalado (falta node_modules/.bin/next) — o build do E2E não rodaria." >&2
  echo "      Rode \`pnpm install\` e chame este script de novo." >&2
  echo "      Você chamou: $0 $*" >&2
  exit 1
fi

if [ ! -f .env.e2e ]; then
  echo "==> .env.e2e não existe. Rode 'pnpm e2e:env' (precisa do Supabase local de pé)." >&2
  exit 1
fi

# `set -a` exporta tudo que for atribuído até o `set +a`.
set -a
# shellcheck disable=SC1091
. ./.env.e2e
set +a

# As partes comuns do E2E exercitam operações que devem continuar protegidas
# pela licença. Gere uma licença válida assinada por uma chave efêmera em
# memória; só a chave pública entra neste build de teste. A parte 4, que mede a
# instalação fresca, define E2E_ENABLE_SIGNED_LICENSE=false e segue sem licença.
E2E_ENABLE_SIGNED_LICENSE="${E2E_ENABLE_SIGNED_LICENSE:-true}"
if [[ "$E2E_ENABLE_SIGNED_LICENSE" == "true" ]]; then
  test_key_module="lib/licensing/e2e-test-trusted-key.ts"
  test_key_backup="$(mktemp "${TMPDIR:-/tmp}/clientix-e2e-key.XXXXXX")"
  cp "$test_key_module" "$test_key_backup"
  restore_test_key() {
    cp "$test_key_backup" "$test_key_module"
    rm -f "$test_key_backup"
  }
  trap restore_test_key EXIT
  pnpm exec tsx scripts/prepare-e2e-license.ts
elif [[ "$E2E_ENABLE_SIGNED_LICENSE" != "false" ]]; then
  echo "ERRO: E2E_ENABLE_SIGNED_LICENSE deve ser 'true' ou 'false'." >&2
  exit 1
fi

echo "==> Buildando contra ${NEXT_PUBLIC_SUPABASE_URL}"
pnpm exec next build

# A PROVA, e não a suposição: se a URL de produção sobreviveu em qualquer
# artefato do bundle, o `.env.local` venceu e o teste falaria com a nuvem pela
# metade cliente. Falhar aqui é barato; descobrir depois de escrever no banco
# real, não.
#
# O `.env.local` pode ser uma cópia do `.env.e2e` (como no CI), inclusive com a
# porta dinâmica escolhida pelo wrapper local. Só é suspeito se o host que ele
# informa for diferente do stack E2E e aparecer no bundle.
HOST_LOCAL="$(printf '%s' "$NEXT_PUBLIC_SUPABASE_URL" | sed -E 's#https?://##; s#/.*##')"
if [ -f .env.local ]; then
  HOST_CHECKOUT="$(grep -E '^NEXT_PUBLIC_SUPABASE_URL=' .env.local | cut -d= -f2- | sed -E 's#https?://##; s#/.*##' || true)"
  if [ -n "$HOST_CHECKOUT" ] && [ "$HOST_CHECKOUT" != "$HOST_LOCAL" ]; then
    if grep -rqF "$HOST_CHECKOUT" .next/static 2>/dev/null; then
      echo "==> FALHOU: o bundle do browser contém o host de .env.local ($HOST_CHECKOUT)." >&2
      echo "    O build pegou o .env.local. NÃO rode a suíte — ela escreveria em produção." >&2
      exit 1
    fi
    echo "==> OK: o host de .env.local não aparece no bundle do browser."
  fi
fi

# Controle POSITIVO do mesmo grep: se a URL local também não aparecesse, o
# "não achei produção" acima não valeria nada — seria um grep que não acha nada.
if grep -rqF "$HOST_LOCAL" .next/static 2>/dev/null; then
  echo "==> OK (controle): o host local ($HOST_LOCAL) ESTÁ no bundle — o grep está vivo."
else
  echo "==> FALHOU (controle): o host local não aparece no bundle." >&2
  echo "    Sem isto, a ausência de produção acima não prova nada." >&2
  exit 1
fi
