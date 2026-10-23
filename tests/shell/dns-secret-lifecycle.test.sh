#!/usr/bin/env bash
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/distribution/installer/install.sh"

fail() { printf '  ✗ %s\n' "$1" >&2; exit 1; }
pass() { printf '  ✓ %s\n' "$1"; }

tmp="$(mktemp -d)"
runtime_tmpfs="$(mktemp -d /dev/shm/clientix-dns-secret.XXXXXX)"
trap 'rm -rf -- "$tmp" "$runtime_tmpfs"' EXIT

INSTALL_DIR="$tmp/install"
mkdir -p "$INSTALL_DIR/state" "$INSTALL_DIR/backups" "$INSTALL_DIR/data" "$tmp/external secrets"
STATE_FILE="$INSTALL_DIR/state/release.json"
ENV_FILE="$INSTALL_DIR/.env"
COMPOSE_FILE="$INSTALL_DIR/compose.yaml"
DNS_EXTERNAL_COMPOSE_FILE="$INSTALL_DIR/compose.dns-cloudflare.yaml"
DNS_EPHEMERAL_COMPOSE_FILE="$INSTALL_DIR/compose.dns-cloudflare-ephemeral.yaml"
BACKUP_DIR="$INSTALL_DIR/backups"
CLIENTIX_CLOUDFLARE_TOKEN_OWNER_UID="$(id -u)"

token_one='SYNTHETIC_TOKEN_0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
token_two='SYNTHETIC_TOKEN_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
external_file="$tmp/external secrets/cloudflare-token"
printf '%s' "$token_one" > "$external_file"
chmod 600 "$external_file"

valid_path="$(validate_external_cloudflare_secret_file "$external_file")" || fail "external file outside install dir was rejected"
[[ "$valid_path" == "$external_file" ]] || fail "external file canonical path changed unexpectedly"
pass "accepts a canonical, root/permitted-owner 0600 external regular file outside install dir"

reject_external_path() {
  local label="$1" path="$2"
  if validate_external_cloudflare_secret_file "$path" >/dev/null 2>&1; then
    fail "$label was accepted"
  fi
}

reject_external_path "relative path" "relative/cloudflare-token"
reject_external_path "missing file" "$tmp/external secrets/missing"
reject_external_path "directory" "$tmp/external secrets"
ln -s "$external_file" "$tmp/external secrets/cloudflare-token-link"
reject_external_path "symlink" "$tmp/external secrets/cloudflare-token-link"
inside_file="$INSTALL_DIR/state/token-fixture"
printf '%s' "$token_one" > "$inside_file"
chmod 600 "$inside_file"
reject_external_path "file inside INSTALL_DIR" "$inside_file"
chmod 640 "$external_file"
reject_external_path "group-readable permissions" "$external_file"
chmod 644 "$external_file"
reject_external_path "world-readable permissions" "$external_file"
chmod 600 "$external_file"
ln "$external_file" "$tmp/external secrets/cloudflare-token-hardlink"
reject_external_path "hard-linked file" "$external_file"
rm -f -- "$tmp/external secrets/cloudflare-token-hardlink"
pass "rejects relative, absent, directory, symlink, in-tree, insecure-mode, and multiply-linked paths"

ENV_FILE="$INSTALL_DIR/.env"
cat > "$ENV_FILE" <<EOF
CLIENTIX_ACME_CHALLENGE=dns
CLIENTIX_ACME_DNS_PROVIDER=cloudflare
CLIENTIX_ACME_SECRET_MODE=external
CLIENTIX_CLOUDFLARE_TOKEN_FILE=
EOF
CLIENTIX_ACME_CHALLENGE=dns
CLIENTIX_ACME_DNS_PROVIDER=cloudflare
CLIENTIX_ACME_SECRET_MODE=external
CLIENTIX_CLOUDFLARE_TOKEN_FILE="$external_file"
persist_dns_secret_config
! grep -Fq "$token_one" "$ENV_FILE" || fail "synthetic token entered .env"
[[ ! -e "$INSTALL_DIR/state/secrets/cloudflare-api-token" ]] || fail "installer created persistent token state"
grep -Fq "CLIENTIX_CLOUDFLARE_TOKEN_FILE='$external_file'" "$ENV_FILE" || fail "external path was not persisted as path-only config"
pass "persists only the external path and creates no token file under INSTALL_DIR"

: > "$DNS_EXTERNAL_COMPOSE_FILE"
: > "$DNS_EPHEMERAL_COMPOSE_FILE"
parse_dns_secret_options --cloudflare-token-stdin
load_env
[[ "$CLIENTIX_ACME_SECRET_MODE" == "ephemeral" && -z "$CLIENTIX_CLOUDFLARE_TOKEN_FILE" ]] ||
  fail "CLI ephemeral mode did not clear the previously persisted external path"
[[ " ${COMPOSE_FILES[*]} " == *" $DNS_EPHEMERAL_COMPOSE_FILE "* && " ${COMPOSE_FILES[*]} " != *" $DNS_EXTERNAL_COMPOSE_FILE "* ]] ||
  fail "CLI ephemeral mode did not select only the ephemeral Compose overlay"
parse_dns_secret_options
load_env
[[ "$CLIENTIX_ACME_SECRET_MODE" == "external" && "$CLIENTIX_CLOUDFLARE_TOKEN_FILE" == "$external_file" ]] ||
  fail "clearing CLI overrides did not restore the persisted external configuration"
[[ " ${COMPOSE_FILES[*]} " == *" $DNS_EXTERNAL_COMPOSE_FILE "* && " ${COMPOSE_FILES[*]} " != *" $DNS_EPHEMERAL_COMPOSE_FILE "* ]] ||
  fail "external mode did not select only the external Compose overlay"
pass "CLI mode switches override and restore the path configuration without ambiguity"

CLIENTIX_ACME_SECRET_MODE=ephemeral
CLIENTIX_CLOUDFLARE_TOKEN_FILE=
persist_dns_secret_config
! grep -Fq "$token_one" "$ENV_FILE" || fail "synthetic token entered ephemeral .env"
grep -Fxq 'CLIENTIX_ACME_SECRET_MODE=ephemeral' "$ENV_FILE" || fail "ephemeral mode was not recorded"
[[ -z "${CLIENTIX_CLOUDFLARE_TOKEN_FILE:-}" ]] || fail "ephemeral mode retained a persistent path"
pass "ephemeral mode stores mode metadata and no token path"

CLIENTIX_ACME_SECRET_MODE=external
CLIENTIX_CLOUDFLARE_TOKEN_FILE="$external_file"
rotate_tmp="$tmp/external secrets/.rotated-token"
printf '%s\n' "$token_two" > "$rotate_tmp"
chmod 600 "$rotate_tmp"
mv -f -- "$rotate_tmp" "$external_file"
[[ "$(validate_external_cloudflare_secret_file "$external_file")" == "$external_file" ]] || fail "rotated external file was rejected"
pass "accepts atomic external-file rotation without copying it into the installation"

CLIENTIX_ACME_CHALLENGE=dns
CLIENTIX_ACME_SECRET_MODE=external
CLIENTIX_CLOUDFLARE_TOKEN_FILE="$external_file"
CLIENTIX_ACME_DNS_PROVIDER=invalid-provider
if (validate_cloudflare_token_source) > "$tmp/invalid-provider.log" 2>&1; then
  fail "invalid DNS provider was accepted"
fi
! grep -Fq "$token_two" "$tmp/invalid-provider.log" || fail "invalid-provider diagnostic contains token"
CLIENTIX_ACME_DNS_PROVIDER=cloudflare
CLIENTIX_CLOUDFLARE_TOKEN_FILE="$tmp/external secrets/missing"
if (validate_cloudflare_token_source) > "$tmp/missing-secret.log" 2>&1; then
  fail "missing external secret was accepted"
fi
CLIENTIX_ACME_SECRET_MODE=ephemeral
CLIENTIX_CLOUDFLARE_TOKEN_FILE=
RUNTIME_SECRET_STDIN_REQUIRED=0
if (validate_cloudflare_token_source) > "$tmp/missing-stdin.log" 2>&1; then
  fail "ephemeral mode without runtime stdin was accepted"
fi
pass "DNS-01 fails closed for invalid provider, missing secret, and missing ephemeral stdin"

if (read_runtime_cloudflare_token <<< 'malformed token with spaces') > "$tmp/malformed-token.log" 2>&1; then
  fail "malformed synthetic token was accepted"
fi
! grep -Fq 'malformed token with spaces' "$tmp/malformed-token.log" || fail "malformed-token diagnostic disclosed input"
pass "rejects malformed synthetic stdin without reflecting it"

[[ "$(stat -f -c '%T' /dev/shm)" == "tmpfs" ]] || fail "/dev/shm is not a tmpfs in this Linux test"
TEST_RUNTIME_TMPFS="$runtime_tmpfs"
TEST_TOKEN_MARKER="$token_one"
compose() {
  [[ "$*" == *"exec -T caddy"* ]] || fail "runtime injection did not use docker compose exec -T"
  [[ "$*" != *"$TEST_TOKEN_MARKER"* ]] || fail "synthetic token entered docker/compose arguments"
  [[ ${CLOUDFLARE_API_TOKEN+x} != x ]] || fail "Cloudflare variable unexpectedly exists in the test environment"
  cat > "$TEST_RUNTIME_TMPFS/cloudflare_api_token"
}
inject_runtime_cloudflare_token "$token_one" > "$tmp/injection.log" 2>&1
cmp -s "$runtime_tmpfs/cloudflare_api_token" <(printf '%s' "$token_one") || fail "runtime injection changed synthetic token bytes"
! grep -Fq "$token_one" "$tmp/injection.log" || fail "injection output contains synthetic token"
! grep -Fq "$token_one" "$ENV_FILE" || fail "synthetic token entered installer configuration"
[[ ! -e "$INSTALL_DIR/state/secrets/cloudflare-api-token" ]] || fail "runtime injection created host-persistent secret"
pass "passes the synthetic token through stdin only and writes to a tmpfs-only test target"

entrypoint="$RAIZ/distribution/installer/caddy-ephemeral-entrypoint.sh"
wait_secret="$runtime_tmpfs/wait-secret"
wait_log="$tmp/wait.log"
(
  source "$entrypoint"
  clientix_wait_for_dns_secret "$wait_secret"
) > "$wait_log" 2>&1 &
wait_pid=$!
for _ in $(seq 1 100); do
  grep -q 'aguardando reinjeção do segredo DNS-01 em tmpfs' "$wait_log" && break
  kill -0 "$wait_pid" 2>/dev/null || fail "ephemeral Caddy wait exited before injection"
done
[[ ! -e "$wait_secret" ]] || fail "wait fixture unexpectedly existed before injection"
printf '%s' "$token_two" > "$wait_secret"
wait "$wait_pid"
! grep -Fq "$token_two" "$wait_log" || fail "ephemeral startup log contains synthetic token"
pass "ephemeral Caddy waits without a secret and resumes after tmpfs injection without logging it"

printf '%s' 'synthetic-certificate' > "$INSTALL_DIR/data/certificate.fixture"
rm -f -- "$runtime_tmpfs/cloudflare_api_token" "$wait_secret"
[[ -s "$INSTALL_DIR/data/certificate.fixture" ]] || fail "persistent certificate fixture disappeared with tmpfs secret"
pass "runtime secret removal leaves persistent certificate state intact"

dns_compose="$(cat "$RAIZ/distribution/installer/compose.dns-cloudflare.yaml")"
ephemeral_compose="$(cat "$RAIZ/distribution/installer/compose.dns-cloudflare-ephemeral.yaml")"
[[ "$dns_compose" == *'source: ${CLIENTIX_CLOUDFLARE_TOKEN_FILE:?DNS-01 external secret path is required}'* ]] || fail "external compose mount source is not path-only config"
[[ "$dns_compose" == *'read_only: true'* && "$dns_compose" == *'create_host_path: false'* ]] || fail "external bind mount is not read-only/fail-closed"
[[ "$dns_compose" != *"$token_one"* && "$dns_compose" != *"$token_two"* ]] || fail "compose template contains a synthetic token"
[[ "$ephemeral_compose" == *'/run/secrets:mode=0700'* ]] || fail "ephemeral compose mount is not a private tmpfs"
pass "Compose templates contain no token value and declare external read-only / ephemeral tmpfs modes"

backup_function="$(sed -n '/^run_backup() {/,/^}/p' "$RAIZ/distribution/installer/install.sh")"
[[ "$backup_function" == *"pg_dump"* ]] || fail "installer backup no longer has its database-only contract"
[[ "$backup_function" != *"cloudflare-api-token"* && "$backup_function" != *"CLOUDFLARE_API_TOKEN"* ]] || fail "Clientix backup references the token"
! grep -Fq "$token_one" "$RAIZ/distribution/installer/install.sh" || fail "installer source contains synthetic token"
! grep -Fq "$token_two" "$RAIZ/distribution/installer/install.sh" || fail "installer source contains synthetic token"
pass "installer logs/source and database-only backup path contain no synthetic token bytes"
