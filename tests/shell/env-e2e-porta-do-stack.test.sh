#!/usr/bin/env bash
# O `.env.e2e` aponta para o Postgres do stack QUE ESTÁ DE PÉ — a prova da porta.
#
#   bash tests/shell/env-e2e-porta-do-stack.test.sh
#
# ── POR QUE ESTE ARQUIVO EXISTE ──────────────────────────────────────────────
# `scripts/gerar-env-e2e.sh` gravava `SUPABASE_DB_URL=…@127.0.0.1:54322/postgres`
# com a porta padrão LITERAL. Com dois stacks locais no mesmo host (cada checkout
# tem o próprio `project_id`, e portanto a própria faixa de portas — a #1091
# reproduz com o banco em 55312), o `.env.e2e` de uma sessão mandava os seeds que
# abrem conexão DIRETA para o banco da outra. Não dá erro nenhum: a conexão é
# válida, o schema é o mesmo, a suíte fica verde, e o dado de teste de uma sessão
# aparece na outra. É a mesma família do `.env.local` de produção que o gerador
# existe para impedir.
#
# ── O QUE ESTÁ SOB PROVA ────────────────────────────────────────────────────
#   1. CONTROLE POSITIVO (o pedido da issue): com um stack fora das portas
#      padrão, o `SUPABASE_DB_URL` gravado acompanha a porta que o
#      `supabase status -o env` respondeu;
#   2. CONTROLE DA VOLTA DO LITERAL: o mesmo run não pode deixar a porta padrão
#      aparecer no arquivo — se alguém reintroduzir o literal, 1 e 2 ficam
#      vermelhos;
#   3. stack nas portas padrão continua funcionando: o valor vem do status, e
#      não de um "qualquer coisa menos a porta padrão";
#   4. sem `DB_URL` na resposta do stack, o gerador RECUSA (exit 1) em vez de
#      chutar a porta padrão — o modo de falha silencioso é o caro.
#   5. MAILPIT_URL vem do status do Supabase, mesmo quando a API foi remapeada;
#      uma URL remota é recusada;
#   6. o wrapper local cobre versões de status sem MAILPIT_URL registrando SMTP.
#
# Não precisa de Docker, de Supabase de verdade nem de rede: o wrapper
# `scripts/local-supabase.sh` é um dublê que responde `status` com JSON, e o
# gerador roda num diretório temporário (ele faz `cd "$(dirname "$0")/.."`).
set -uo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GERADOR_REAL="$RAIZ/scripts/gerar-env-e2e.sh"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

falhas=0
casos=0

ok()   { printf '  ok     %s\n' "$1"; }
falha(){ printf '  FALHA  %s\n' "$1"; falhas=$((falhas + 1)); }

# Monta o diretório do caso com o gerador REAL e um wrapper local de dublê.
# uso: preparar <caso> <JSON de status> [porta SMTP do wrapper]
preparar() {
  local caso="$1" status_json="$2" smtp_port="${3:-}"
  mkdir -p "$TMP/$caso/scripts"
  cp "$GERADOR_REAL" "$TMP/$caso/scripts/gerar-env-e2e.sh"
  printf '%s\n' "$status_json" > "$TMP/$caso/status.json"
  cat > "$TMP/$caso/scripts/local-supabase.sh" <<'MOCK'
#!/usr/bin/env bash
set -eu
if [ "$*" != "status" ]; then exit 2; fi
cat "$(dirname "${BASH_SOURCE[0]}")/../status.json"
MOCK
  chmod +x "$TMP/$caso/scripts/local-supabase.sh"
  # Chaves de cifra já prontas: o gerador só as regenera quando faltam, então a
  # prova não depende de `openssl`.
  local chave="chave-de-teste-com-mais-de-44-caracteres-000000000000"
  printf 'CPF_ENCRYPTION_KEY=%s\nWAHA_BYO_ENCRYPTION_KEY=%s\nAI_CRED_AES_KEY=%s\n' \
    "$chave" "$chave" "$chave" > "$TMP/$caso/.env.e2e"
  if [ -n "$smtp_port" ]; then
    mkdir -p "$TMP/$caso/.clientix-local"
    printf 'SMTP=%s\n' "$smtp_port" > "$TMP/$caso/.clientix-local/supabase-ports"
  fi
}

# uso: rodar <caso>  → SAIDA recebe stdout+stderr e RC o código de saída
rodar() {
  SAIDA="$(cd "$TMP/$1" && bash scripts/gerar-env-e2e.sh 2>&1)"
  RC=$?
}

contem()     { grep -qF -- "$2" "$1"; }
nao_contem() { ! grep -qF -- "$2" "$1"; }

# ── 1 e 2. Stack fora das portas padrão: é o cenário da #1091 ────────────────
casos=$((casos + 1))
printf 'caso 1: as portas da API e do Mailpit são independentes — ambas vêm do status\n'
preparar fora '{"API_URL":"http://127.0.0.1:55321","ANON_KEY":"anon-sintetico","SERVICE_ROLE_KEY":"service-sintetico","DB_URL":"postgresql://postgres:senha-do-stack@127.0.0.1:55312/postgres","MAILPIT_URL":"http://127.0.0.1:54324"}'
rodar fora
if [ "$RC" -eq 0 ]; then
  ok "o gerador saiu 0"
else
  falha "esperava rc 0, veio $RC — saída: $SAIDA"
fi
if contem "$TMP/fora/.env.e2e" 'SUPABASE_DB_URL=postgresql://postgres:senha-do-stack@127.0.0.1:55312/postgres'; then
  ok "SUPABASE_DB_URL seguiu a porta do stack (55312)"
else
  falha "SUPABASE_DB_URL não acompanhou o stack — arquivo: $(grep -n '^SUPABASE_DB_URL=' "$TMP/fora/.env.e2e" || echo 'sem a linha')"
fi
if nao_contem "$TMP/fora/.env.e2e" '54322'; then
  ok "nenhuma porta padrão sobrou no arquivo (a volta do literal reprova aqui)"
else
  falha "o arquivo voltou a trazer a porta padrão: $(grep -n '54322' "$TMP/fora/.env.e2e")"
fi
case "$SAIDA" in
  *55312*) ok "o recado final diz em qual Postgres os seeds escrevem" ;;
  *)       falha "o recado final não diz onde os seeds escrevem — saída: $SAIDA" ;;
esac
if contem "$TMP/fora/.env.e2e" 'MAILPIT_URL=http://127.0.0.1:54324'; then
  ok "MAILPIT_URL veio do status mesmo sem acompanhar a porta da API"
else
  falha "MAILPIT_URL não veio do status do Supabase"
fi

# ── 3. Stack nas portas padrão continua funcionando ─────────────────────────
casos=$((casos + 1))
printf 'caso 2: o stack está nas portas padrão — o .env.e2e segue o status\n'
preparar padrao '{"API_URL":"http://127.0.0.1:54321","ANON_KEY":"anon-sintetico","SERVICE_ROLE_KEY":"service-sintetico","DB_URL":"postgresql://postgres:senha-do-stack@127.0.0.1:54322/postgres","MAILPIT_URL":"http://127.0.0.1:54324"}'
rodar padrao
if [ "$RC" -eq 0 ]; then
  ok "o gerador saiu 0"
else
  falha "esperava rc 0, veio $RC — saída: $SAIDA"
fi
if contem "$TMP/padrao/.env.e2e" 'SUPABASE_DB_URL=postgresql://postgres:senha-do-stack@127.0.0.1:54322/postgres'; then
  ok "SUPABASE_DB_URL veio do status, não de um 'tudo menos a porta padrão'"
else
  falha "SUPABASE_DB_URL não bateu com o status — arquivo: $(grep -n '^SUPABASE_DB_URL=' "$TMP/padrao/.env.e2e" || echo 'sem a linha')"
fi
if contem "$TMP/padrao/.env.e2e" 'MAILPIT_URL=http://127.0.0.1:54324'; then
  ok "o Mailpit do Supabase padrão continua em 54324"
else
  falha "MAILPIT_URL não preservou a porta padrão 54324"
fi

# ── 4. Sem DB_URL no status, recusa — nunca o chute da porta padrão ─────────
casos=$((casos + 1))
printf 'caso 3: o stack não diz a DB_URL — o gerador tem que recusar\n'
preparar sem-dburl '{"API_URL":"http://127.0.0.1:54321","ANON_KEY":"anon-sintetico","SERVICE_ROLE_KEY":"service-sintetico","MAILPIT_URL":"http://127.0.0.1:54324"}'
rodar sem-dburl
if [ "$RC" -eq 1 ]; then
  ok "recusou com exit 1"
else
  falha "esperava rc 1, veio $RC — saída: $SAIDA"
fi
if nao_contem "$TMP/sem-dburl/.env.e2e" 'SUPABASE_DB_URL'; then
  ok "não gravou nenhuma DB_URL (nem a padrão)"
else
  falha "gravou uma DB_URL sem o stack informar: $(grep -n '^SUPABASE_DB_URL=' "$TMP/sem-dburl/.env.e2e")"
fi
case "$SAIDA" in
  *DB_URL*) ok "a recusa explica que faltou a DB_URL" ;;
  *)        falha "a recusa não diz o motivo — saída: $SAIDA" ;;
esac

# ── 5. Nome legado continua aceito pelo gerador ─────────────────────────────
casos=$((casos + 1))
printf 'caso 4: o campo legado INBUCKET_URL continua aceito\n'
preparar legado '{"API_URL":"http://127.0.0.1:55321","ANON_KEY":"anon-sintetico","SERVICE_ROLE_KEY":"service-sintetico","DB_URL":"postgresql://postgres:senha-do-stack@127.0.0.1:55312/postgres","INBUCKET_URL":"http://127.0.0.1:55325"}'
rodar legado
if [ "$RC" -eq 0 ] && contem "$TMP/legado/.env.e2e" 'MAILPIT_URL=http://127.0.0.1:55325'; then
  ok "o alias legado é convertido para MAILPIT_URL"
else
  falha "o gerador não converteu INBUCKET_URL — rc=$RC, saída: $SAIDA"
fi

# ── 6. URL remota é recusada ────────────────────────────────────────────────
casos=$((casos + 1))
printf 'caso 5: uma URL de Mailpit remota é recusada\n'
preparar remoto '{"API_URL":"http://127.0.0.1:55321","ANON_KEY":"anon-sintetico","SERVICE_ROLE_KEY":"service-sintetico","DB_URL":"postgresql://postgres:senha-do-stack@127.0.0.1:55312/postgres","MAILPIT_URL":"https://mailpit.example.com"}'
rodar remoto
if [ "$RC" -eq 1 ] && nao_contem "$TMP/remoto/.env.e2e" 'MAILPIT_URL='; then
  ok "recusou o endpoint remoto antes de gravar o ambiente"
else
  falha "esperava recusa sem gravar Mailpit, veio rc=$RC — saída: $SAIDA"
fi

# ── 7. GitHub inicia a CLI direta; o gerador usa esse stack como fallback ────
casos=$((casos + 1))
printf 'caso 6: GitHub Actions iniciou a CLI direta — o gerador a consulta\n'
preparar github-cli '{"API_URL":"http://127.0.0.1:55321","ANON_KEY":"anon-sintetico","SERVICE_ROLE_KEY":"service-sintetico","DB_URL":"postgresql://postgres:senha-do-stack@127.0.0.1:55312/postgres","MAILPIT_URL":"http://127.0.0.1:54324"}'
cat > "$TMP/github-cli/scripts/local-supabase.sh" <<'MOCK'
#!/usr/bin/env bash
exit 1
MOCK
mkdir -p "$TMP/github-cli/bin"
cat > "$TMP/github-cli/bin/supabase" <<'MOCK'
#!/usr/bin/env bash
if [ "$*" != "status -o json" ]; then exit 2; fi
cat "$(dirname "${BASH_SOURCE[0]}")/../status.json"
MOCK
chmod +x "$TMP/github-cli/scripts/local-supabase.sh" "$TMP/github-cli/bin/supabase"
SAIDA="$(cd "$TMP/github-cli" && GITHUB_ACTIONS=true PATH="$TMP/github-cli/bin:$PATH" bash scripts/gerar-env-e2e.sh 2>&1)"
RC=$?
if [ "$RC" -eq 0 ]; then
  ok "o fallback do CLI do GitHub saiu 0"
else
  falha "esperava rc 0, veio $RC — saída: $SAIDA"
fi
if contem "$TMP/github-cli/.env.e2e" 'SUPABASE_DB_URL=postgresql://postgres:senha-do-stack@127.0.0.1:55312/postgres'; then
  ok "o .env.e2e recebeu o Postgres da CLI iniciada pelo workflow"
else
  falha "o gerador não usou o status da CLI direta"
fi
if contem "$TMP/github-cli/.env.e2e" 'MAILPIT_URL=http://127.0.0.1:54324'; then
  ok "o .env.e2e recebeu a URL do Mailpit da CLI direta"
else
  falha "o gerador não usou MAILPIT_URL retornada pela CLI direta"
fi

# ── 7. Wrapper informa SMTP quando uma versão antiga omite a URL ────────────
casos=$((casos + 1))
printf 'caso 7: o wrapper fornece a porta SMTP se o status omitir a URL\n'
preparar wrapper-smtp '{"API_URL":"http://127.0.0.1:55321","ANON_KEY":"anon-sintetico","SERVICE_ROLE_KEY":"service-sintetico","DB_URL":"postgresql://postgres:senha-do-stack@127.0.0.1:55312/postgres"}' 55326
rodar wrapper-smtp
if [ "$RC" -eq 0 ] && contem "$TMP/wrapper-smtp/.env.e2e" 'MAILPIT_URL=http://127.0.0.1:55326'; then
  ok "usou a porta SMTP registrada pelo wrapper"
else
  falha "não usou a porta SMTP do wrapper — rc=$RC, saída: $SAIDA"
fi

printf '\n%s caso(s), %s falha(s)\n' "$casos" "$falhas"
if [ "$falhas" -ne 0 ]; then
  echo "==> O .env.e2e não está seguindo o stack de pé (issue #1091)."
  exit 1
fi
echo "==> O .env.e2e aponta para o Postgres do stack que está de pé."
