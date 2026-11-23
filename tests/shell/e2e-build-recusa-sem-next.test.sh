#!/usr/bin/env bash
# Prova da guarda de `scripts/e2e-build.sh` que recusa quando o `next` não está
# instalado em `node_modules/.bin`.
#
#   bash tests/shell/e2e-build-recusa-sem-next.test.sh
#
# ## O defeito que ela mata
#
# `bash scripts/e2e-build.sh` chamava `pnpm exec next build` direto. Sem o binário
# instalado, a linha só esbarrava no instante da chamada — DEPOIS de o script já
# ter anunciado `==> Buildando contra ...` —, e o que aparecia era o erro genérico
# do `pnpm`, não uma frase dizendo qual binário falta. É a mesma classe de
# `scripts/test-db.sh`: o instrumento ausente não se anuncia, e o que ficou na
# tela antes dele parece ter dado certo.
#
# ## O que está sob prova
#
#   1. sem `node_modules/.bin/next`, o script RECUSA (exit 1) e recusa ANTES de
#      anunciar o preparo (`==>`);
#   2. a mensagem nomeia o binário ausente e diz o que fazer (`pnpm install`);
#   3. CONTROLE POSITIVO: com um `next` no lugar, a guarda NÃO dispara — sem este
#      caso, uma guarda que recusasse sempre passaria no caso 1 e quebraria o CI;
#   4. uma URL local dinâmica, igual no `.env.e2e` e `.env.local`, não é tratada
#      como produção;
#   5. se o bundle incluir o host diferente que veio do `.env.local`, a suíte é
#      recusada antes de poder escrever nesse banco.
#
# A cópia roda num diretório de mentira: é o jeito de medir "sem o binário" sem
# mexer no `node_modules` de quem executa o teste.
set -euo pipefail

RAIZ="$(cd "$(dirname "$0")/../.." && pwd)"
falhas=0

checar() {
  local nome="$1" esperado="$2" obtido="$3"
  if [ "$esperado" = "$obtido" ]; then
    echo "  ok: $nome"
  else
    echo "  FALHOU: $nome — esperado '$esperado', obtido '$obtido'" >&2
    falhas=$((falhas + 1))
  fi
}

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/scripts"
cp "$RAIZ/scripts/e2e-build.sh" "$tmp/scripts/"
# O `.env.e2e` existe para o caso 1 não poder ser confundido: o que falta ali é
# só o binário.
printf 'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\nNEXT_PUBLIC_SUPABASE_ANON_KEY=probe\n' > "$tmp/.env.e2e"

echo "== 1/5 · sem next instalado, recusa antes de anunciar o build"
saida="$(env -i PATH="/usr/bin:/bin" HOME="$tmp" bash "$tmp/scripts/e2e-build.sh" 2>&1 || true)"
codigo="$(env -i PATH="/usr/bin:/bin" HOME="$tmp" bash "$tmp/scripts/e2e-build.sh" >/dev/null 2>&1; echo $?)"
checar "recusa com exit 1" "1" "$codigo"
# A FRASE da guarda, não a palavra "next" solta: o erro do `pnpm` sem o binário
# também cita "next", então procurar só o nome não distingue os dois mundos.
case "$saida" in
  *"node_modules/.bin/next"*) echo "  ok: a mensagem nomeia o binário ausente";;
  *) echo "  FALHOU: a mensagem não nomeia o binário — saída: $saida" >&2; falhas=$((falhas + 1));;
esac
case "$saida" in
  *"==>"*) echo "  FALHOU: anunciou o preparo antes de recusar" >&2; falhas=$((falhas + 1));;
  *) echo "  ok: recusou antes de qualquer anúncio do preparo";;
esac

echo "== 2/5 · a mensagem manda rodar \`pnpm install\`"
case "$saida" in
  *"pnpm install"*) echo "  ok: aponta o comando certo";;
  *) echo "  FALHOU: não aponta \`pnpm install\` — saída: $saida" >&2; falhas=$((falhas + 1));;
esac

echo "== 3/5 · CONTROLE POSITIVO: com next no lugar, a guarda NÃO dispara"
mkdir -p "$tmp/node_modules/.bin"
printf '#!/bin/sh\nexit 0\n' > "$tmp/node_modules/.bin/next"
chmod +x "$tmp/node_modules/.bin/next"
saida_ok="$(env -i PATH="/usr/bin:/bin" HOME="$tmp" bash "$tmp/scripts/e2e-build.sh" 2>&1 || true)"
case "$saida_ok" in
  *"node_modules/.bin/next"*)
    echo "  FALHOU: a guarda disparou COM o next no lugar — ela reprovaria o CI" >&2
    falhas=$((falhas + 1));;
  *) echo "  ok: passou da guarda";;
esac
# "Passou da guarda" só vale se o script ALCANÇOU o passo seguinte: o anúncio do
# build vem antes da chamada do binário, então ele aparece em qualquer mundo em
# que a guarda deixou passar.
case "$saida_ok" in
  *"==> Buildando contra"*) echo "  ok: chegou ao passo do build (o que vem depois é outro assunto)";;
  *) echo "  FALHOU: não chegou ao passo do build — saída: $saida_ok" >&2; falhas=$((falhas + 1));;
esac

echo "== 4/5 · aceita a URL dinâmica local copiada para .env.local"
mkdir -p "$tmp/bin"
cat > "$tmp/bin/pnpm" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
mkdir -p .next/static
printf '%s\n%s\n' "$NEXT_PUBLIC_SUPABASE_URL" "${MOCK_BUNDLE_HOST:-}" > .next/static/bundle.js
MOCK
chmod +x "$tmp/bin/pnpm"
printf 'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54635\nNEXT_PUBLIC_SUPABASE_ANON_KEY=probe\n' > "$tmp/.env.e2e"
printf 'NEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54635\n' > "$tmp/.env.local"
if env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$tmp" bash "$tmp/scripts/e2e-build.sh" > "$tmp/saida-dinamica" 2>&1; then
  codigo_dinamico=0
else
  codigo_dinamico=$?
fi
saida_dinamica="$(cat "$tmp/saida-dinamica")"
checar "URL E2E local dinâmica não foi recusada" "0" "$codigo_dinamico"
case "$saida_dinamica" in
  *"host local (127.0.0.1:54635) ESTÁ no bundle"*) echo "  ok: confirmou a URL local dinâmica no bundle";;
  *) echo "  FALHOU: não confirmou a URL dinâmica — saída: $saida_dinamica" >&2; falhas=$((falhas + 1));;
esac

echo "== 5/5 · recusa se o bundle reutilizar o host diferente de .env.local"
printf 'NEXT_PUBLIC_SUPABASE_URL=https://crm.example.test\n' > "$tmp/.env.local"
if env -i PATH="$tmp/bin:/usr/bin:/bin" HOME="$tmp" MOCK_BUNDLE_HOST=crm.example.test bash "$tmp/scripts/e2e-build.sh" > "$tmp/saida-vazamento" 2>&1; then
  codigo_vazamento=0
else
  codigo_vazamento=$?
fi
saida_vazamento="$(cat "$tmp/saida-vazamento")"
checar "recusa o host do .env.local presente no bundle" "1" "$codigo_vazamento"
case "$saida_vazamento" in
  *"bundle do browser contém o host de .env.local (crm.example.test)"*) echo "  ok: identificou o host que não deve chegar ao bundle";;
  *) echo "  FALHOU: não identificou o host diferente — saída: $saida_vazamento" >&2; falhas=$((falhas + 1));;
esac

if [ "$falhas" -ne 0 ]; then
  echo "FALHAS: $falhas" >&2
  exit 1
fi
echo "TODOS OS CASOS OK"
