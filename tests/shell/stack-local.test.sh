#!/usr/bin/env bash
# Prova as garantias do instalador local: ele não apaga o ambiente de quem já
# usa o clone, e a senha inicial não nasce publicada nem é gerada em modo
# interativo sem o conhecimento do operador.

set -uo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd -P)"
INSTALADOR="$ROOT_DIR/ubuntu-local-installer.sh"
STACK="$ROOT_DIR/scripts/local-stack.sh"
SUPA="$ROOT_DIR/scripts/local-supabase.sh"
ENVGEN="$ROOT_DIR/scripts/local-env.sh"
COMPOSE="$ROOT_DIR/docker-compose.local.yml"
FAILS=0

check() {
  local descricao="$1"
  shift
  if "$@"; then
    printf '  ✓ %s\n' "$descricao"
  else
    printf '  ✗ %s\n' "$descricao"
    FAILS=$((FAILS + 1))
  fi
}

echo "stack local — instalador e scripts"

for arquivo in "$INSTALADOR" "$STACK" "$SUPA" "$ENVGEN"; do
  check "sintaxe Bash válida: ${arquivo#"$ROOT_DIR"/}" bash -n "$arquivo"
done
check "atalhos pnpm entram no Git Bash nativo no Windows" bash -c '
  grep -qF "scripts/local-stack-launcher.mjs up" "$1" &&
  grep -qF "path.join(programFiles, \"Git\", \"bin\", \"bash.exe\")" "$2" &&
  grep -qF "spawnSync(" "$2" &&
  grep -qF "resolveBash()," "$2"' _ "$ROOT_DIR/package.json" "$ROOT_DIR/scripts/local-stack-launcher.mjs"
check "Supabase CLI 3.1.0 recebe config local gerada por clone" bash -c '
  grep -qF "npm exec --yes --package=supabase@3.1.0" "$1" &&
  grep -qF -- "--workdir" "$1" &&
  grep -qF "[local_smtp]" "$2"' _ "$SUPA" "$ROOT_DIR/supabase/config.toml"
check "agent_worker é provisionado antes da baseline sem senha em stdout" bash -c '
  grep -qF "agent-worker-password" "$1" &&
  grep -qF "provision_agent_worker \"\$db_url\"" "$1" &&
  grep -qF "agent_worker must be provisioned before applying the worker runtime ACL contract" "$2"' _ "$SUPA" "$ROOT_DIR/supabase/baseline.sql"
check "migrations Vendor usam tsx do lockfile sem depender do shim pnpm global" bash -c '
  grep -qF "node ./node_modules/tsx/dist/cli.mjs control-plane/scripts/apply-migrations.ts" "$1"' _ "$STACK"
check "signer público local é provisionado após as migrations e antes do Vendor" bash -c '
  migrations_line="$(grep -n "^    apply_control_plane_migrations$" "$1" | cut -d: -f1)"
  signer_line="$(grep -n "^    provision_local_control_plane_signer$" "$1" | cut -d: -f1)"
  compose_line="$(grep -n "up -d --build" "$1" | cut -d: -f1)"
  [[ -n "$migrations_line" && -n "$signer_line" && -n "$compose_line" ]] &&
  (( migrations_line < signer_line && signer_line < compose_line ))' _ "$STACK"
check "provisionador local recusa DB remoto e exige signer sintético de teste" bash -c '
  grep -qF "DESKCOMM_ENV_MODE !== \"local\"" "$1" &&
  grep -qF "clientix-certification-test-" "$1" &&
  grep -qF "127.0.0.1" "$1" &&
  ! grep -qF "PRIVATE KEY" "$1"' _ "$ROOT_DIR/control-plane/scripts/provision-local-license-signer.ts"
check "compose Customer persiste estado e licença em volumes próprios do projeto" bash -c '
  app="$(awk "/^  app:/{f=1;next} f && /^  [a-z]/{f=0} f" "$1")"
  printf "%s\n" "$app" | grep -qF "customer-state:/opt/clientix/state" &&
  printf "%s\n" "$app" | grep -qF "customer-licenses:/opt/clientix/licenses" &&
  grep -q "^  customer-state:$" "$1" &&
  grep -q "^  customer-licenses:$" "$1"' _ "$COMPOSE"
check "Customer private installation key uses the writable commercial license mount" bash -c '
  grep -qF "/opt/clientix/licenses/installation.key" "$1" &&
  grep -qF "./licenses:/opt/clientix/licenses:rw" "$2" &&
  grep -qF "./state:/opt/clientix/state:ro" "$2"' _ "$ROOT_DIR/lib/licensing/installation-auth.ts" "$ROOT_DIR/distribution/installer/compose.yaml"

# ── A senha do dono ────────────────────────────────────────────────────────
#
# O instalador publica as credenciais na tela no fim. Se a senha for literal
# no arquivo, ela está publicada NO REPOSITÓRIO. O `.env.local` usa loopback
# nas origens da interface e callback WAHA pela rede privada do compose.
check "a senha do dono não é literal no script" bash -c '
  ! grep -qE "^export OWNER_PASSWORD=\"[^$]" "$1"' _ "$INSTALADOR"
check "a senha do dono é solicitada em TTY e exigida em modo não interativo" bash -c '
  grep -qF '\''if [[ -z "${OWNER_PASSWORD:-}" ]]; then'\'' "$1" &&
  grep -qF '\''if [[ ! -t 0 ]]; then'\'' "$1" &&
  grep -qF '\''read -r -s -p "Senha inicial do proprietario: " OWNER_PASSWORD'\'' "$1" &&
  grep -qF '\''Defina OWNER_PASSWORD no ambiente para execucao nao interativa.'\'' "$1" &&
  grep -qF '\''export OWNER_PASSWORD'\'' "$1"' _ "$INSTALADOR"
check "OWNER_PASSWORD fornecida pelo operador é preservada" bash -c '
  grep -qF '\''if [[ -z "${OWNER_PASSWORD:-}" ]]; then'\'' "$1" &&
  grep -qF '\''export OWNER_PASSWORD'\'' "$1"' _ "$INSTALADOR"

# ── A chave da API do WAHA ─────────────────────────────────────────────────
#
# Ela comanda a sessão de WhatsApp. Literal no arquivo = publicada NESTE
# repositório — o mesmo argumento da senha do dono, e pior, porque o painel do
# WAHA fica de pé. As duas checagens abaixo EXECUTAM as linhas em vez de as
# lerem: além do literal, elas pegam o erro irmão de derivar a chave e o hash
# de dois `openssl rand` diferentes, que passa em qualquer grep e rende 401.
#
# `sha512sum` é do GNU e não existe no macOS, onde este teste roda antes de
# chegar ao Ubuntu do CI; o stub abaixo o troca por um marcador visível, porque
# o que se prova aqui é a PROCEDÊNCIA do hash, não o algoritmo.
check "instalador: o hash do WAHA deriva da chave, e a chave nasce aleatória" bash -c '
  sha512sum() { sed "s/^/marca:/"; }
  eval "$(grep -E "^WAHA_KEY(_HASH)?=" "$1")"
  [[ "${WAHA_KEY:-}" =~ ^[0-9a-f]{48}$ ]] || exit 1
  [[ "${WAHA_KEY_HASH:-}" == "marca:$WAHA_KEY" ]]
' _ "$INSTALADOR"

check "gerador de .env.local: o hash do WAHA deriva da MESMA chave" bash -c '
  sha512sum() { sed "s/^/marca:/"; }
  waha_key="canario-0123456789"
  eval "$(grep -E "^WAHA_API_KEY(_SHA512)?=" "$1")"
  [[ "${WAHA_API_KEY:-}" == "canario-0123456789" ]] || exit 1
  [[ "${WAHA_API_KEY_SHA512:-}" == "marca:canario-0123456789" ]]
' _ "$ENVGEN"

check "gerador de .env.local: a chave do WAHA nasce aleatória" bash -c '
  grep -qF "waha_key=\"\$(openssl rand" "$1"' _ "$ENVGEN"
check "ambiente local usa loopback com opt-in HTTP e callback WAHA interno" bash -c '
  grep -qF '\''app_url="http://127.0.0.1:${app_port}"'\'' "$1" &&
  grep -qF '\''admin_url="http://127.0.0.1:${vendor_port}"'\'' "$1" &&
  grep -qF "waha_port=\"\$(choose_port 3030 \"\$app_port\" \"\$vendor_port\" \"\$control_plane_db_port\")\"" "$1" &&
  grep -qF "WAHA_PORT=\$waha_port" "$1" &&
  grep -qF "NEXT_PUBLIC_ADMIN_URL=\$admin_url" "$1" &&
  grep -qF "CLIENTIX_ADMIN_ORIGIN=\$admin_url" "$1" &&
  grep -qF "CLIENTIX_ALLOW_INSECURE_HTTP=true" "$1" &&
  grep -qF "WAHA_WEBHOOK_BASE_URL=http://app:3000" "$1"' _ "$ENVGEN"
check "alocador WAHA pula portas já reservadas por outros serviços" bash -c '
  eval "$(sed -n "/^choose_port() {/,/^}/p" "$1")"
  selected="$(choose_port 3030 3030 3031)"
  [[ "$selected" -gt 3031 ]]' _ "$ENVGEN"
check "alocador local pula portas publicadas por containers Docker" bash -c '
  eval "$(sed -n "/^choose_port() {/,/^}/p" "$1")"
  docker() { printf "127.0.0.1:3030->3000/tcp, 0.0.0.0:3031-3032->3000-3001/tcp\\n"; }
  node() { return 0; }
  selected="$(choose_port 3030)"
  [[ "$selected" == "3033" ]]' _ "$ENVGEN"
check "alocador do worker pula 8787 publicado por outro container" bash -c '
  eval "$(sed -n "/^choose_port() {/,/^}/p" "$1")"
  docker() { printf "0.0.0.0:8787->8787/tcp\\n"; }
  node() { return 0; }
  selected="$(choose_port 8787)"
  [[ "$selected" == "8788" ]]' _ "$ENVGEN"
check "compose mantém 8787 interno e publica override do worker só em loopback" bash -c '
  grep -qF "WORKER_HOST_PORT=\$worker_host_port" "$1" &&
  grep -qF "127.0.0.1:\${WORKER_HOST_PORT:-8787}:8787" "$2"' _ "$ENVGEN" "$COMPOSE"

check "worker valida o ingresso HTTP local explicitamente" bash -c '
  awk "/^  worker:/{f=1;next} f && /^  [a-z]/{f=0} f" "$1" | grep -qF "CLIENTIX_INGRESS_MODE: \"local\"" &&
  awk "/^  worker:/{f=1;next} f && /^  [a-z]/{f=0} f" "$1" | grep -qF "CLIENTIX_ALLOW_INSECURE_HTTP:"' _ "$COMPOSE"

# ── O painel do WAHA não atende a rede ─────────────────────────────────────
#
# O dashboard está LIGADO neste compose e tem autenticação própria, com o
# padrão do WAHA — a chave da API não o protege. Publicar a porta sem endereço
# de bind entrega o comando da sessão de WhatsApp a qualquer máquina da rede da
# VM. `docker-compose.prod.yml` fecha o mesmo buraco desligando o dashboard e
# não publicando porta nenhuma; aqui ele serve quem desenvolve, em 127.0.0.1.
#
# Range de awk (`/^  waha:/,/^  [a-z]/`) NÃO serve: `  waha:` casa com o próprio
# padrão de fim e o bloco colapsa em 1 linha — sonda quebrada devolve zero e
# lê exatamente como "nenhuma porta exposta". Por isso a flag `f`, e por isso a
# checagem de controle logo abaixo.
check "a sonda enxerga o bloco do WAHA no compose" bash -c '
  awk "/^  waha:/{f=1;next} f && /^  [a-z]/{f=0} f" "$1" | grep -q WAHA_DASHBOARD_ENABLED' _ "$COMPOSE"
check "nenhuma porta do WAHA é publicada sem endereço de bind" bash -c '
  awk "/^  waha:/{f=1;next} f && /^  [a-z]/{f=0} f" "$1" | grep -qF '\''127.0.0.1:${WAHA_PORT:-3030}:3000'\'' &&
  ! awk "/^  waha:/{f=1;next} f && /^  [a-z]/{f=0} f" "$1" | grep -qF "127.0.0.1:3030:3000"' _ "$COMPOSE"

# ── O .env.local de quem já usa o clone ────────────────────────────────────
#
# O instalador roda DENTRO de um clone existente (ele só clona quando não acha
# `package.json`), e 93 scripts deste repositório leem `.env.local`. Escrever
# por cima sem cópia apaga o ambiente de trabalho de quem rodar por curiosidade.
check "o instalador faz backup de um .env.local que não é local" bash -c '
  grep -q "cloud-backup" "$1"' _ "$INSTALADOR"
check "o instalador reconhece o ambiente local pela marca DESKCOMM_ENV_MODE" bash -c '
  grep -q "DESKCOMM_ENV_MODE=local" "$1"' _ "$INSTALADOR"
check "o .env.local gerado carrega a marca (senão o próximo run apaga sem backup)" bash -c '
  awk "/^cat <<EOF > .env.local\$/,/^EOF\$/" "$1" | grep -q "^DESKCOMM_ENV_MODE=local\$"' _ "$INSTALADOR"

# ── O COMPORTAMENTO, e não só o texto ──────────────────────────────────────
#
# As checagens acima leem o arquivo; esta EXECUTA o trecho da guarda contra um
# `.env.local` de mentira, que é a única forma de saber que a condição casa.
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT
check "signer local é idempotente e não regenera par incompleto" bash -c '
  set -euo pipefail
  ROOT_DIR="$2"
  ENV_FILE="$ROOT_DIR/.env.local"
  LOCAL_STACK_ID="stack-test"
  mkdir -p "$ROOT_DIR"
  eval "$(sed -n "/^env_value() {/,/^}/p" "$1")"
  eval "$(sed -n "/^upsert_env_value() {/,/^}/p" "$1")"
  eval "$(sed -n "/^ensure_control_plane_environment() {/,/^}/p" "$1")"
  ensure_control_plane_environment >/dev/null
  cp "$ROOT_DIR/.clientix-local/control-plane/license-private.pem" "$ROOT_DIR/private.first"
  cp "$ROOT_DIR/.clientix-local/control-plane/license-public.pem" "$ROOT_DIR/public.first"
  ensure_control_plane_environment >/dev/null
  cmp "$ROOT_DIR/private.first" "$ROOT_DIR/.clientix-local/control-plane/license-private.pem"
  cmp "$ROOT_DIR/public.first" "$ROOT_DIR/.clientix-local/control-plane/license-public.pem"
  rm "$ROOT_DIR/.clientix-local/control-plane/license-public.pem"
  if ensure_control_plane_environment >/dev/null 2>&1; then exit 1; fi
  cmp "$ROOT_DIR/private.first" "$ROOT_DIR/.clientix-local/control-plane/license-private.pem"
  [[ ! -e "$ROOT_DIR/.clientix-local/control-plane/license-public.pem" ]]
' _ "$ENVGEN" "$TMP_DIR/signer-check"
check "identity local nasce uma vez, persiste e recusa divergência" bash -c '
  set -euo pipefail
  ROOT_DIR="$2"
  ENV_FILE="$ROOT_DIR/.env.local"
  mkdir -p "$ROOT_DIR"
  printf "DESKCOMM_ENV_MODE=local\n" > "$ENV_FILE"
  eval "$(sed -n "/^env_value() {/,/^}/p" "$1")"
  eval "$(sed -n "/^upsert_env_value() {/,/^}/p" "$1")"
  eval "$(sed -n "/^ensure_local_installation_identity() {/,/^}/p" "$1")"
  ensure_local_installation_identity
  stored="$(tr -d "\r\n" < "$ROOT_DIR/.clientix-local/runtime/licensing/installation_id")"
  [[ "$stored" =~ ^inst_[0-9a-fA-F-]{36}$ ]] &&
  [[ "$(env_value INSTALLATION_ID)" == "$stored" ]]
  printf "DESKCOMM_ENV_MODE=local\n" > "$ENV_FILE"
  ensure_local_installation_identity
  [[ "$(env_value INSTALLATION_ID)" == "$stored" ]]
  upsert_env_value INSTALLATION_ID inst_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee
  if ensure_local_installation_identity >/dev/null 2>&1; then exit 1; fi
  [[ "$(tr -d "\r\n" < "$ROOT_DIR/.clientix-local/runtime/licensing/installation_id")" == "$stored" ]]
' _ "$ENVGEN" "$TMP_DIR/identity-check"
guarda() {
  # O mesmo bloco do instalador, extraído por marcador — se ele mudar lá, esta
  # extração falha e o teste fica vermelho em vez de medir um texto obsoleto.
  awk '/^if \[\[ -s .env.local \]\]/,/^fi$/' "$INSTALADOR"
}
[[ -n "$(guarda)" ]] || { printf '  ✗ não achei a guarda no instalador\n'; FAILS=$((FAILS + 1)); }

(
  cd "$TMP_DIR" || exit 1
  paint() { :; }
  printf 'NEXT_PUBLIC_SUPABASE_URL=https://nuvem.supabase.co\n' > .env.local
  eval "$(guarda)"
) >/dev/null 2>&1
check "ambiente da NUVEM é copiado antes de ser substituído" test -s "$TMP_DIR/.env.local.cloud-backup"

(
  cd "$TMP_DIR" || exit 1
  rm -f .env.local.cloud-backup
  paint() { :; }
  printf 'DESKCOMM_ENV_MODE=local\nNEXT_PUBLIC_SUPABASE_URL=http://127.0.0.1:54321\n' > .env.local
  eval "$(guarda)"
) >/dev/null 2>&1
check "ambiente JÁ local não vira backup a cada run" bash -c '! test -e "$1/.env.local.cloud-backup"' _ "$TMP_DIR"

if [[ "$FAILS" -gt 0 ]]; then
  printf '\n%s verificação(ões) falharam\n' "$FAILS"
  exit 1
fi
printf '\ntodas as verificações passaram\n'
