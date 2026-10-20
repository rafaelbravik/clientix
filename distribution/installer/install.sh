#!/usr/bin/env bash
# Clientix Commercial Installer & Operational CLI
# Suporta: install, update, adopt, rollback, health, status
set -euo pipefail

INSTALL_DIR="${CLIENTIX_DIR:-/opt/clientix}"
INSTALLER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$INSTALLER_DIR/postgres-tls.sh"
. "$INSTALLER_DIR/installation-id.sh"
STATE_FILE="$INSTALL_DIR/state/release.json"
ENV_FILE="$INSTALL_DIR/.env"
COMPOSE_FILE="$INSTALL_DIR/compose.yaml"
BACKUP_DIR="$INSTALL_DIR/backups"
MANIFEST_FILE="$INSTALLER_DIR/release-manifest.json"
MANIFEST_VERIFIER="$INSTALLER_DIR/verify-release-manifest.mjs"
MANIFEST_TRUST_ROOT="$INSTALLER_DIR/trust/release-manifest"
INSTALLER_VERSION_FILE="$INSTALLER_DIR/VERSION"
INSTALLER_CURRENT_VERSION=""

# Redaction helper
redact() {
  local str="$1"
  printf '%s' "$str" | sed -E 's/(postgres(ql)?:\/\/[^:]+:)[^@]+(@)/\1[REDACTED]\3/g'
}

log() {
  local clean
  clean="$(redact "$*")"
  echo "[clientix-installer] $(date -u +'%Y-%m-%dT%H:%M:%SZ') $clean" >&2
}

log_err() {
  local clean
  clean="$(redact "$*")"
  echo "[clientix-installer:ERROR] $(date -u +'%Y-%m-%dT%H:%M:%SZ') $clean" >&2
}

die() {
  log_err "$*"
  exit 1
}

# 1. Preflight
preflight() {
  log "Executando verificações de pré-vôo (preflight)..."
  
  # Arquitetura
  local arch
  arch="$(uname -m 2>/dev/null || true)"
  case "$arch" in
    x86_64|amd64|aarch64|arm64) ;;
    *) die "ARQUITETURA_NAO_SUPORTADA: $arch. O Clientix suporta amd64 e arm64." ;;
  esac

  # Docker
  command -v docker >/dev/null 2>&1 || die "DOCKER_AUSENTE: Docker não está instalado ou acessível no PATH."
  docker info >/dev/null 2>&1 || die "DOCKER_INATIVO: Daemon do Docker não está rodando."

  # Compose
  docker compose version >/dev/null 2>&1 || die "DOCKER_COMPOSE_AUSENTE: Docker Compose v2 é obrigatório."

  # Node é usado apenas pelo verificador Ed25519 local, antes de puxar qualquer imagem.
  command -v node >/dev/null 2>&1 || die "NODE_AUSENTE: Node.js 22+ é obrigatório para verificar o manifesto assinado."
  local node_major
  node_major="$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)"
  [ "$node_major" -ge 22 ] || die "NODE_DESATUALIZADO: Node.js 22+ é obrigatório para verificar o manifesto assinado."

  command -v curl >/dev/null 2>&1 || die "CURL_AUSENTE: curl é obrigatório para o preflight de dependências externas."

  # Espaço em disco (mínimo 2 GB livres no diretório de instalação)
  if [ -d "$INSTALL_DIR" ] || [ -d "$(dirname "$INSTALL_DIR")" ]; then
    local check_path="$INSTALL_DIR"
    [ -d "$check_path" ] || check_path="$(dirname "$INSTALL_DIR")"
    local free_kb
    free_kb="$(df -k "$check_path" 2>/dev/null | tail -1 | awk '{print $4}')"
    if [ -n "$free_kb" ] && [ "$free_kb" -lt 2097152 ]; then
      die "ESPACO_INSUFICIENTE: Menos de 2 GB de espaço livre em disco ($((free_kb / 1024)) MB disponível)."
    fi
  fi

  log "Preflight concluído com sucesso."
}

# 2. Inicialização de Estrutura de Diretórios
init_directories() {
  mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/backups" "$INSTALL_DIR/state" "$INSTALL_DIR/licenses" "$INSTALL_DIR/logs"
  # GID 1001 é o grupo leitor compartilhado pelo app, worker e voice-agent.
  chown 1001:1001 "$INSTALL_DIR/state" "$INSTALL_DIR/licenses" || die "RUNTIME_DIRECTORY_OWNERSHIP_FAILED: não foi possível preparar os volumes para o usuário não-root do app."
  chmod 2750 "$INSTALL_DIR/state" "$INSTALL_DIR/licenses" || die "RUNTIME_DIRECTORY_PERMISSIONS_FAILED: não foi possível preparar os volumes de runtime."
  if [ -f "$INSTALL_DIR/licenses/license.json" ]; then
    chown 1001:1001 "$INSTALL_DIR/licenses/license.json" || die "LICENSE_FILE_OWNERSHIP_FAILED: não foi possível preparar a licença para leitura do worker."
    chmod 640 "$INSTALL_DIR/licenses/license.json" || die "LICENSE_FILE_PERMISSIONS_FAILED: não foi possível preparar a licença para leitura do worker."
  fi
}

write_installation_id_file() {
  local installation_id="$1" target="$INSTALL_DIR/state/installation_id" tmp="$INSTALL_DIR/state/installation_id.tmp.$$"
  is_valid_canonical_installation_id "$installation_id" || die "INSTALLATION_ID_INVALID: não é possível persistir um ID fora do contrato inst_<UUIDv4>."
  printf '%s\n' "$installation_id" > "$tmp" || die "INSTALLATION_ID_WRITE_FAILED: falha ao gravar o ID persistente."
  chown 1001:1001 "$tmp" || die "INSTALLATION_ID_OWNERSHIP_FAILED: não foi possível entregar o ID ao runtime."
  chmod 640 "$tmp" || die "INSTALLATION_ID_PERMISSIONS_FAILED: não foi possível proteger o ID persistente."
  mv -f "$tmp" "$target" || die "INSTALLATION_ID_PROMOTION_FAILED: não foi possível promover o ID persistente."
}

validate_installation_id_binding() {
  local env_id="${INSTALLATION_ID:-}" state_path="$INSTALL_DIR/state/installation_id" state_id
  is_valid_canonical_installation_id "$env_id" || die "LEGACY_INSTALLATION_ID_REQUIRES_REBIND: INSTALLATION_ID atual não é inst_<UUIDv4>; nenhuma atualização foi aplicada."
  if [ -f "$state_path" ]; then
    state_id="$(tr -d '\r\n' < "$state_path")"
    is_valid_canonical_installation_id "$state_id" || die "INSTALLATION_ID_STATE_INVALID: ID persistido está corrompido; nenhuma atualização foi aplicada."
    [ "$state_id" = "$env_id" ] || die "INSTALLATION_ID_MISMATCH: .env e state/installation_id divergem; nenhuma atualização foi aplicada."
  fi
}

# Atualização atômica de uma variável do arquivo de ambiente.
set_env_value() {
  local key="$1" value="$2" tmp value_file
  umask 077
  tmp="$(mktemp "${ENV_FILE}.tmp.XXXXXX")" || die "ENV_WRITE_FAILED: Falha ao preparar arquivo temporário do .env."
  value_file="$(mktemp "${ENV_FILE}.value.XXXXXX")" || { rm -f "$tmp"; die "ENV_WRITE_FAILED: Falha ao preparar valor temporário do .env."; }
  printf '%s' "$value" > "$value_file" || { rm -f "$tmp" "$value_file"; die "ENV_WRITE_FAILED: Falha ao preparar o valor de configuração."; }
  awk -v key="$key" -v value_file="$value_file" '
    BEGIN { found = 0; getline value < value_file; close(value_file) }
    { sub(/\r$/, "") }
    index($0, key "=") == 1 {
      if (!found) print key "=" value
      found = 1
      next
    }
    { print }
    END { if (!found) print key "=" value }
  ' "$ENV_FILE" > "$tmp" || { rm -f "$tmp" "$value_file"; die "ENV_WRITE_FAILED: Falha ao preparar atualização do .env."; }
  rm -f "$value_file"
  chmod 600 "$tmp" 2>/dev/null || true
  mv "$tmp" "$ENV_FILE"
}

read_env_value() {
  local key="$1"
  awk -v key="$key" 'index($0, key "=") == 1 { sub(/\r$/, ""); print substr($0, length(key) + 2); exit }' "$ENV_FILE"
}

random_hex() {
  local bytes="$1" value
  value="$(od -An -N"$bytes" -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
  [ "${#value}" -eq "$((bytes * 2))" ] || die "CSPRNG_UNAVAILABLE: Falha ao gerar segredo criptograficamente seguro."
  printf '%s' "$value"
}

# 3. Geração ou preservação de secrets e installation_id.
setup_env() {
  [ -f "$ENV_FILE" ] || die "ENV_FILE_REQUIRED: copie $INSTALLER_DIR/.env.example para $ENV_FILE, preencha os endpoints e credenciais externos, e rode novamente. Nenhuma instalação foi alterada."

  local inst_id secret key state_id state_path="$INSTALL_DIR/state/installation_id"
  inst_id="$(read_env_value INSTALLATION_ID)"
  state_id=""
  if [ -f "$state_path" ]; then
    state_id="$(tr -d '\r\n' < "$state_path")"
    [ -n "$state_id" ] || die "INSTALLATION_ID_STATE_INVALID: ID persistido está vazio; nenhuma instalação foi alterada."
  fi
  if [ -n "$inst_id" ]; then
    is_valid_canonical_installation_id "$inst_id" || die "LEGACY_INSTALLATION_ID_REQUIRES_REBIND: INSTALLATION_ID existente não é inst_<UUIDv4>. Ele foi preservado; obtenha uma revinculação de licença antes de migrar."
    if [ -n "$state_id" ] && [ "$state_id" != "$inst_id" ]; then
      die "INSTALLATION_ID_MISMATCH: .env e state/installation_id divergem; nenhuma instalação foi alterada."
    fi
  elif [ -n "$state_id" ]; then
    is_valid_canonical_installation_id "$state_id" || die "INSTALLATION_ID_STATE_INVALID: ID persistido está corrompido; nenhuma instalação foi alterada."
    inst_id="$state_id"
    set_env_value INSTALLATION_ID "$inst_id"
  else
    inst_id="$(generate_installation_id)" || die "CSPRNG_UNAVAILABLE: não foi possível gerar INSTALLATION_ID."
    is_valid_canonical_installation_id "$inst_id" || die "INSTALLATION_ID_GENERATION_FAILED: gerador retornou ID fora do contrato inst_<UUIDv4>."
    set_env_value INSTALLATION_ID "$inst_id"
  fi
  [ -f "$state_path" ] || write_installation_id_file "$inst_id"

  for key in INTERNAL_SECRET INTERNAL_CRON_SECRET CPF_ENCRYPTION_KEY WAHA_BYO_ENCRYPTION_KEY; do
    secret="$(read_env_value "$key")"
    if [ -z "$secret" ]; then
      secret="$(random_hex 32)"
      set_env_value "$key" "$secret"
    fi
  done

  secret="$(read_env_value AI_CRED_AES_KEY)"
  if [ -z "$secret" ]; then
    secret="$(head -c 32 /dev/urandom 2>/dev/null | base64 | tr -d '\n')"
    [ "${#secret}" -ge 40 ] || die "CSPRNG_UNAVAILABLE: falha ao gerar AI_CRED_AES_KEY."
    set_env_value AI_CRED_AES_KEY "$secret"
  fi
  chmod 600 "$ENV_FILE" 2>/dev/null || true
}

# 4. Carrega Variáveis de Ambiente
load_env() {
  [ -f "$ENV_FILE" ] || die "ENV_FILE_AUSENTE: $ENV_FILE não encontrado."
  set -a
  # shellcheck source=/dev/null
  # Normaliza CRLF sem alterar o arquivo de origem.
  source <(sed 's/\r$//' "$ENV_FILE")
  set +a
}

# 5. Validação de Evolução de Configuração (Check de Variáveis Obrigatórias)
validate_config_evolution() {
  log "Verificando consistência de variáveis obrigatórias contra .env.example..."
  local missing=() key
  local required=(INSTALLATION_ID NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY INTERNAL_SECRET CPF_ENCRYPTION_KEY WAHA_BYO_ENCRYPTION_KEY AI_CRED_AES_KEY SUPABASE_DB_URL SUPABASE_DB_ADMIN_URL WAHA_API_BASE_URL WAHA_API_KEY WAHA_WEBHOOK_BASE_URL UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN APP_IMAGE WORKER_IMAGE SCHEDULER_IMAGE VOICE_AGENT_IMAGE MIGRATOR_IMAGE)
  for key in "${required[@]}"; do
    if [ -z "${!key:-}" ]; then missing+=("$key"); fi
  done
  if [[ ",${COMPOSE_PROFILES:-}," == *,telefonia,* ]]; then
    for key in ARI_URL ARI_WS_URL ARI_USERNAME ARI_PASSWORD OPENAI_API_KEY; do
      if [ -z "${!key:-}" ]; then missing+=("$key"); fi
    done
  fi
  if [[ ",${COMPOSE_PROFILES:-}," == *,voz,* ]]; then
    for key in WACALLS_API_BASE_URL WACALLS_API_TOKEN WACALLS_ADMIN_USER WACALLS_ADMIN_PASSWORD; do
      if [ -z "${!key:-}" ]; then missing+=("$key"); fi
    done
    if [[ ! "${WACALLS_WEBRTC_UDP_PORT:-7881}" =~ ^[0-9]+$ ]] ||
      [ "${WACALLS_WEBRTC_UDP_PORT:-7881}" -lt 1 ] || [ "${WACALLS_WEBRTC_UDP_PORT:-7881}" -gt 65535 ]; then
      missing+=(WACALLS_WEBRTC_UDP_PORT_must_be_1_to_65535)
    fi
  fi
  [ ${#missing[@]} -eq 0 ] || die "MISSING_REQUIRED_CONFIG: Variáveis obrigatórias ausentes no .env: ${missing[*]}"
  log "Validação de configuração concluída: OK."
}

# Credenciais e URLs de serviços independentes do pacote comercial. Nenhum
# endpoint recebe defaults locais: o Supabase, Upstash e WAHA são externos.
validate_external_config() {
  local missing=() key webhook_secret="${WAHA_HMAC_SECRET:-}"
  local required=(NEXT_PUBLIC_APP_URL NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_DB_URL SUPABASE_DB_ADMIN_URL WAHA_API_BASE_URL WAHA_API_KEY WAHA_WEBHOOK_BASE_URL UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN)
  for key in "${required[@]}"; do
    if [ -z "${!key:-}" ]; then missing+=("$key"); fi
  done
  if [[ ",${COMPOSE_PROFILES:-}," == *,telefonia,* ]]; then
    for key in ARI_URL ARI_WS_URL ARI_USERNAME ARI_PASSWORD OPENAI_API_KEY; do
      if [ -z "${!key:-}" ]; then missing+=("$key"); fi
    done
  fi
  if [ "${WAHA_WEBHOOK_REQUIRE_SIGNATURE:-false}" != "true" ] && [ "${WAHA_WEBHOOK_REQUIRE_SIGNATURE:-false}" != "false" ]; then
    missing+=(WAHA_WEBHOOK_REQUIRE_SIGNATURE_must_be_true_or_false)
  fi
  if [ "${WAHA_WEBHOOK_REQUIRE_SIGNATURE:-false}" = "true" ] && [ "${#webhook_secret}" -lt 16 ]; then
    missing+=(WAHA_HMAC_SECRET)
  fi
  if [ -n "${TELEGRAM_MTPROTO_GATEWAY_URL:-}" ] &&
    [[ ! "${TELEGRAM_MTPROTO_GATEWAY_URL}" =~ ^https://[^/@?#[:space:]]+(/[^?#[:space:]]*)?$ ]]; then
    missing+=(TELEGRAM_MTPROTO_GATEWAY_URL_requires_https)
  fi
  [ ${#missing[@]} -eq 0 ] || die "MISSING_EXTERNAL_CONFIG: configure no .env as dependências externas: ${missing[*]}"
}

validate_existing_runtime_config() {
  local missing=() key
  local required=(INSTALLATION_ID INTERNAL_SECRET CPF_ENCRYPTION_KEY WAHA_BYO_ENCRYPTION_KEY AI_CRED_AES_KEY)
  for key in "${required[@]}"; do
    if [ -z "${!key:-}" ]; then missing+=("$key"); fi
  done
  [ ${#missing[@]} -eq 0 ] || die "MISSING_RUNTIME_CONFIG: instalação existente sem configuração runtime: ${missing[*]}"
}

# A instalação só avança se os três serviços externos estiverem alcançáveis.
# Respostas e URLs não são impressas; tokens seguem apenas em headers.
curl_config_quote() {
  local value="$1"
  case "$value" in
    *$'\n'*|*$'\r'*) return 1 ;;
  esac
  value="${value//\\/\\\\}"
  value="${value//\"/\\\"}"
  printf '"%s"' "$value"
}

check_external_dependencies() {
  local supabase_url="${NEXT_PUBLIC_SUPABASE_URL%/}"
  local upstash_code waha_code supabase_code
  supabase_code="$( { curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 --config - 2>/dev/null || true; } <<EOF
url = $(curl_config_quote "$supabase_url/auth/v1/health")
header = $(curl_config_quote "apikey: $NEXT_PUBLIC_SUPABASE_ANON_KEY")
EOF
  )"
  [[ "$supabase_code" =~ ^2[0-9][0-9]$ ]] || die "SUPABASE_UNREACHABLE: Supabase externo não respondeu ao health check. Verifique URL e conectividade."

  upstash_code="$( { curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 \
    --request POST --data '["PING"]' --config - 2>/dev/null || true; } <<EOF
url = $(curl_config_quote "$UPSTASH_REDIS_REST_URL")
header = $(curl_config_quote "Authorization: Bearer $UPSTASH_REDIS_REST_TOKEN")
header = "Content-Type: application/json"
EOF
  )"
  [[ "$upstash_code" =~ ^2[0-9][0-9]$ ]] || die "UPSTASH_UNREACHABLE: Upstash Redis REST não respondeu ao PING. Verifique URL e conectividade."

  local waha_url="${WAHA_API_BASE_URL%/}"
  waha_code="$( { curl --silent --show-error --output /dev/null --write-out '%{http_code}' --max-time 10 --config - 2>/dev/null || true; } <<EOF
url = $(curl_config_quote "$waha_url/api/sessions")
header = $(curl_config_quote "X-Api-Key: $WAHA_API_KEY")
EOF
  )"
  [[ "$waha_code" =~ ^2[0-9][0-9]$ ]] || die "WAHA_UNREACHABLE: WAHA externo não respondeu ao health check. Verifique URL e conectividade."
  log "Preflight de dependências externas concluído."
}

# 6. Autenticação Privada de Registro
registry_auth() {
  if [ -n "${REGISTRY_TOKEN:-}" ]; then
    local user="${REGISTRY_USERNAME:-token}"
    log "Autenticando no registro de imagens privado (sem expor credenciais)..."
    printf '%s' "$REGISTRY_TOKEN" | docker login ghcr.io -u "$user" --password-stdin >/dev/null 2>&1 || die "REGISTRY_AUTH_FAILED: Falha na autenticação do GHCR."
    log "Autenticação no registro concluída com sucesso."
  fi
}

registry_logout() {
  if [ -n "${REGISTRY_TOKEN:-}" ]; then
    docker logout ghcr.io >/dev/null 2>&1 || true
  fi
}

# 7. Validação de Manifesto de Release
validate_manifest() {
  [ -f "$MANIFEST_FILE" ] || die "MANIFEST_AUSENTE: release-manifest.json não encontrado."
  [ -f "$INSTALLER_VERSION_FILE" ] || die "INSTALLER_VERSION_UNAVAILABLE: arquivo VERSION do instalador não encontrado."
  INSTALLER_CURRENT_VERSION="$(tr -d '\r' < "$INSTALLER_VERSION_FILE")"
  [ -n "$INSTALLER_CURRENT_VERSION" ] || die "INSTALLER_VERSION_UNAVAILABLE: arquivo VERSION do instalador está vazio."
  local verified
  if ! verified="$(node "$MANIFEST_VERIFIER" verify "$MANIFEST_FILE" "$MANIFEST_TRUST_ROOT" "$INSTALLER_CURRENT_VERSION" 2>&1)"; then
    die "$verified"
  fi
  VERIFIED_MANIFEST_JSON="$verified"
  VERIFIED_RELEASE_VERSION="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.release_version)' "$VERIFIED_MANIFEST_JSON")"
  VERIFIED_SCHEMA_TARGET="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.schema_target)' "$VERIFIED_MANIFEST_JSON")"
  VERIFIED_IMAGE_APP="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.images.app)' "$VERIFIED_MANIFEST_JSON")"
  VERIFIED_IMAGE_WORKER="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.images.worker)' "$VERIFIED_MANIFEST_JSON")"
  VERIFIED_IMAGE_SCHEDULER="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.images.scheduler)' "$VERIFIED_MANIFEST_JSON")"
  VERIFIED_IMAGE_VOICE_AGENT="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.images.voice_agent)' "$VERIFIED_MANIFEST_JSON")"
  VERIFIED_IMAGE_MIGRATOR="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.images.migrator)' "$VERIFIED_MANIFEST_JSON")"
  log "Manifesto assinado validado: Release $VERIFIED_RELEASE_VERSION (schema $VERIFIED_SCHEMA_TARGET; installer $INSTALLER_CURRENT_VERSION)."
}

check_schema_compatibility() {
  local status_json="$1"
  local result
  if ! result="$(printf '%s' "$status_json" | node "$MANIFEST_VERIFIER" schema-check \
      "$MANIFEST_FILE" "$MANIFEST_TRUST_ROOT" "$INSTALLER_CURRENT_VERSION" - 2>&1)"; then
    die "$result"
  fi
  log "Compatibilidade de schema confirmada: $result"
}

# 8. Verificação e Pull de Imagens Target com Validação de Digest
ensure_target_images() {
  log "Verificando disponibilidade e integridade das imagens do release..."
  local images=("$VERIFIED_IMAGE_APP" "$VERIFIED_IMAGE_WORKER" "$VERIFIED_IMAGE_SCHEDULER" "$VERIFIED_IMAGE_VOICE_AGENT" "$VERIFIED_IMAGE_MIGRATOR")
  local full_ref repo expected_digest repo_digests
  for full_ref in "${images[@]}"; do
    repo="${full_ref%@*}"
    expected_digest="${full_ref#*@}"
    log "Realizando pull da imagem: $full_ref..."
    if ! docker pull "$full_ref" >/dev/null 2>&1; then
      die "TARGET_IMAGE_UNAVAILABLE: Falha ao obter imagem '$full_ref' do registro."
    fi

    repo_digests="$(docker image inspect "$full_ref" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null || true)"
    grep -Fxq "$repo@$expected_digest" <<<"$repo_digests" || die "IMAGE_DIGEST_MISMATCH: digest verificado da imagem $repo não corresponde ao manifesto assinado."
  done

  log "Todas as imagens do release foram validadas com sucesso."
}

persist_verified_image_refs() {
  set_env_value APP_IMAGE "$VERIFIED_IMAGE_APP"
  set_env_value WORKER_IMAGE "$VERIFIED_IMAGE_WORKER"
  set_env_value SCHEDULER_IMAGE "$VERIFIED_IMAGE_SCHEDULER"
  set_env_value VOICE_AGENT_IMAGE "$VERIFIED_IMAGE_VOICE_AGENT"
  set_env_value MIGRATOR_IMAGE "$VERIFIED_IMAGE_MIGRATOR"
  load_env
  validate_config_evolution
}

# Credenciais do PostgreSQL entram no container por arquivo temporário protegido,
# nunca como argumento visível na linha de comando do processo do host.
run_docker_with_database() (
  local database_url="$1"
  shift
  local env_file
  umask 077
  env_file="$(mktemp "${TMPDIR:-/tmp}/clientix-migrator-env.XXXXXX")" || exit 1
  trap 'rm -f -- "$env_file"' EXIT
  trap 'exit 129' HUP
  trap 'exit 130' INT
  trap 'exit 143' TERM
  {
    printf 'DATABASE_URL=%s\n' "$database_url"
    printf 'POSTGRES_SSL_ROOT_CERT=%s\n' "${POSTGRES_SSL_ROOT_CERT:-}"
    printf 'BACKUP_ACK=%s\n' "${BACKUP_ACK:-1}"
  } > "$env_file" || exit 1
  chmod 600 "$env_file" || exit 1
  docker run --rm \
    --network "${DOCKER_NETWORK:-host}" \
    --env-file "$env_file" \
    "$@"
)

# 9. Execução do Standalone Migrator
run_migrator() {
  local cmd="$1"
  shift || true
  log "Executando clientix-migrator: $cmd..."
  run_docker_with_database "$SUPABASE_DB_ADMIN_URL" "$VERIFIED_IMAGE_MIGRATOR" "$cmd" "$@"
}

run_runtime_db_preflight() {
  log "Validando a conexão PostgreSQL usada pelo runtime..."
  run_docker_with_database "$SUPABASE_DB_URL" \
    --entrypoint node "$VERIFIED_IMAGE_MIGRATOR" \
    -e 'const { Client } = require("pg"); const { resolvePostgresConnectionConfig } = require("/app/lib/postgres-tls-policy.cjs"); const policy = resolvePostgresConnectionConfig(process.env.DATABASE_URL); const client = new Client({ ...policy, connectionTimeoutMillis: 10000 }); client.connect().then(async () => { const result = await client.query("select session_user::text, current_user::text"); if (result.rows[0]?.session_user !== "agent_worker" || result.rows[0]?.current_user !== "agent_worker") throw new Error("RUNTIME_DATABASE_ROLE_INVALID"); await client.end(); }).catch(async () => { try { await client.end(); } catch {} process.exit(1); });' \
    || die "RUNTIME_DATABASE_ROLE_INVALID: SUPABASE_DB_URL deve autenticar diretamente como agent_worker; nenhuma migration foi aplicada."
  log "Conexão PostgreSQL do runtime validada como agent_worker."
}

# 10. Backup Lógico do Banco de Dados
run_backup() {
  local target_ver="$1"
  local current_ver="${2:-unknown}"
  local ts
  ts="$(date -u +'%Y%m%d_%H%M%S')"
  local bkp_file="$BACKUP_DIR/backup_${current_ver}_to_${target_ver}_${ts}.dump"
  log "Iniciando backup antes de mutação de banco: $bkp_file..."

  local secure_database_url
  secure_database_url="$(clientix_postgres_url_for_libpq "$SUPABASE_DB_ADMIN_URL")" \
    || die "DATABASE_TLS_CONFIG_INVALID: configure o banco remoto com TLS verificado; a URL foi recusada sem exibir credenciais."
  run_docker_with_database "$secure_database_url" \
    --entrypoint sh "$VERIFIED_IMAGE_MIGRATOR" \
    -c 'set -eu; if [ -n "${POSTGRES_SSL_ROOT_CERT:-}" ]; then printf "%s" "$POSTGRES_SSL_ROOT_CERT" | base64 -d > /tmp/clientix-postgres-root-ca.pem; chmod 600 /tmp/clientix-postgres-root-ca.pem; export PGSSLROOTCERT=/tmp/clientix-postgres-root-ca.pem; fi; exec pg_dump "$DATABASE_URL" -Fc' > "$bkp_file" || die "BACKUP_FAILED: Falha ao executar pg_dump do banco."

  if [ ! -s "$bkp_file" ]; then
    die "BACKUP_INVALID: Arquivo de backup está vazio ou não foi gerado."
  fi

  # Valida integridade via pg_restore --list
  docker run --rm \
    --entrypoint pg_restore \
    -v "$BACKUP_DIR:/backups:ro" \
    "$VERIFIED_IMAGE_MIGRATOR" --list "/backups/$(basename "$bkp_file")" >/dev/null 2>&1 || die "BACKUP_CORRUPTED: pg_restore falhou ao ler o catálogo do backup."

  # Calcula checksum sha256 do arquivo de backup
  local bkp_sha256
  bkp_sha256="$(sha256sum "$bkp_file" 2>/dev/null | awk '{print $1}' || true)"
  log "Backup lógico concluído e validado com sucesso (SHA-256: $bkp_sha256)."

  # Rotação segura de backups (mantém os últimos N)
  local keep="${KEEP_LAST_N_BACKUPS:-5}"
  local count
  count="$(find "$BACKUP_DIR" -name "*.dump" | wc -l)"
  if [ "$count" -gt "$keep" ]; then
    log "Aplicando retenção de backups (mantendo os últimos $keep)..."
    find "$BACKUP_DIR" -name "*.dump" -type f | sort | head -n -"$keep" | xargs rm -f || true
  fi

  echo "$bkp_file"
}

# 11. Verificação de Saúde (Health Check com HTTP Probe)
check_health() {
  local timeout="${1:-45}"
  log "Aguardando boot e saúde da aplicação (HTTP probe / timeout: ${timeout}s)..."
  local elapsed=0
  local port="${PORT:-3000}"

  while [ $elapsed -lt $timeout ]; do
    # A rota pública de saúde consulta as dependências que o app realmente usa;
    # `/login` sozinho só prova que o Next devolveu uma página.
    local http_code
    http_code="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${port}/api/v1/health" 2>/dev/null || true)"
    if [ "$http_code" = "200" ]; then
      log "Aplicação Clientix respondendo com sucesso (HTTP $http_code)."
      
      # Verifica se contêineres vitais continuam ativos sem loop de restart
      local stopped
      stopped="$(docker compose -f "$COMPOSE_FILE" ps --status exited -q 2>/dev/null || true)"
      if [ -n "$stopped" ]; then
        die "CONTAINER_CRASH_DETECTED: Um ou mais serviços falharam no boot."
      fi
      return 0
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done

  die "HEALTH_CHECK_FAILED: Aplicação não respondeu HTTP na porta $port após ${timeout}s."
}

# 12. Comando: install
cmd_install() {
  preflight
  [ ! -f "$STATE_FILE" ] || die "ALREADY_INSTALLED: Instalação existente detectada no estado. Para atualizar, use 'clientix-installer update'."
  load_env
  validate_external_config
  validate_manifest
  check_external_dependencies

  registry_auth
  ensure_target_images
  registry_logout

  run_runtime_db_preflight
  log "Verificando estado do banco de dados..."
  local status_json
  status_json="$(run_migrator status --json)"
  local state_type
  state_type="$(node -e 'try { const d=JSON.parse(process.argv[1]); process.stdout.write(String(d.state_type || "")); } catch { process.exit(2); }' "$status_json")" || die "MIGRATOR_STATUS_INVALID: resposta de status do banco não é JSON válido."
  [ -n "$state_type" ] || die "MIGRATOR_STATUS_INVALID: resposta de status do banco não contém state_type."
  check_schema_compatibility "$status_json"

  log "Estado do banco detectado: $state_type"
  if [ "$state_type" = "FRESH_DATABASE" ]; then
    local db_action="install"
  elif [ "$state_type" = "EXISTING_UNTRACKED_INSTALLATION" ]; then
    if [ "${ALLOW_ADOPT:-0}" = "1" ] || [ "${1:-}" = "--adopt" ]; then
      log "Adotando instalação existente expressamente permitida..."
      local db_action="adopt"
    else
      die "EXISTING_DATABASE_REQUIRES_CONFIRMATION: Banco existente não rastreado. Execute com '--adopt' ou defina ALLOW_ADOPT=1."
    fi
  elif [ "$state_type" = "TRACKED_INSTALLATION" ]; then
    log "Banco já rastreado. Executando check de sanidade..."
    local db_action="check"
  else
    die "DATABASE_STATE_UNSUPPORTED: estado de banco '$state_type' não é suportado pelo instalador."
  fi

  # Só agora, após validar dependências, assinatura, digests e estado real do
  # banco, o instalador cria arquivos e segredos locais.
  init_directories
  setup_env
  persist_verified_image_refs
  cp "$INSTALLER_DIR/compose.yaml" "$COMPOSE_FILE"
  run_migrator "$db_action"

  log "Subindo serviços Clientix..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d

  check_health 45

  local ver="$VERIFIED_RELEASE_VERSION"
  local schema_ver="$VERIFIED_SCHEMA_TARGET"

  cat <<EOF > "$STATE_FILE.tmp"
{
  "installed_version": "$ver",
  "previous_version": null,
  "schema_version": "$schema_ver",
  "installation_id": "$INSTALLATION_ID",
  "installed_at": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "last_successful_update": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
}
EOF
  mv "$STATE_FILE.tmp" "$STATE_FILE"
  chmod 600 "$STATE_FILE"

  log "INSTALACAO CONCLUIDA COM SUCESSO! Versao: $ver (ID: $INSTALLATION_ID)"
}

# 13. Comando: update
cmd_update() {
  preflight
  [ -f "$STATE_FILE" ] || die "ESTADO_NAO_ENCONTRADO: Nenhuma instalação anterior encontrada para atualizar."
  load_env
  validate_external_config
  validate_existing_runtime_config
  validate_manifest
  check_external_dependencies
  validate_installation_id_binding
  local current_ver
  current_ver="$(grep '"installed_version":' "$STATE_FILE" | awk -F'"' '{print $4}')"
  local target_ver="$VERIFIED_RELEASE_VERSION"
  local schema_ver="$VERIFIED_SCHEMA_TARGET"

  log "Iniciando processo de atualização de $current_ver para $target_ver..."

  # Autenticação e download prévio de TODAS as imagens antes de qualquer mutação
  registry_auth
  ensure_target_images
  registry_logout

  run_runtime_db_preflight
  local status_json state_type
  status_json="$(run_migrator status --json)"
  state_type="$(node -e 'try { const d=JSON.parse(process.argv[1]); process.stdout.write(String(d.state_type || "")); } catch { process.exit(2); }' "$status_json")" || die "MIGRATOR_STATUS_INVALID: resposta de status do banco não é JSON válido."
  [ "$state_type" = "TRACKED_INSTALLATION" ] || die "DATABASE_STATE_MISMATCH: o banco não está numa instalação rastreada; nenhuma atualização foi aplicada."
  check_schema_compatibility "$status_json"

  # Backup obrigatório pré-migration
  local bkp_path
  bkp_path="$(run_backup "$target_ver" "$current_ver")"
  local bkp_sha256
  bkp_sha256="$(sha256sum "$bkp_path" 2>/dev/null | awk '{print $1}' || echo "uncalculated")"

  # Executa migrações incrementais
  init_directories
  [ -f "$INSTALL_DIR/state/installation_id" ] || write_installation_id_file "$INSTALLATION_ID"
  chown 1001:1001 "$INSTALL_DIR/state/installation_id" 2>/dev/null || die "INSTALLATION_ID_OWNERSHIP_FAILED: não foi possível entregar o ID ao runtime."
  chmod 640 "$INSTALL_DIR/state/installation_id" || die "INSTALLATION_ID_PERMISSIONS_FAILED: não foi possível proteger o ID persistente."
  run_migrator update --backup-ack

  # Atualiza compose e reinicia serviços
  persist_verified_image_refs
  cp "$INSTALLER_DIR/compose.yaml" "$COMPOSE_FILE"
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d

  # Valida saúde
  check_health 45

  # Promove estado atômico
  cat <<EOF > "$STATE_FILE.tmp"
{
  "installed_version": "$target_ver",
  "previous_version": "$current_ver",
  "schema_version": "$schema_ver",
  "installation_id": "$INSTALLATION_ID",
  "last_successful_update": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "last_backup": "$bkp_path",
  "backup_sha256": "$bkp_sha256"
}
EOF
  mv "$STATE_FILE.tmp" "$STATE_FILE"
  chmod 600 "$STATE_FILE"

  log "ATUALIZACAO CONCLUIDA COM SUCESSO para $target_ver!"
}

# 14. Comando: status
cmd_status() {
  load_env
  log "Inspecionando instalação Clientix em $INSTALL_DIR..."
  if [ -f "$STATE_FILE" ]; then
    echo "--- ESTADO DA VERSÃO ---"
    cat "$STATE_FILE"
    echo ""
  else
    log "Nenhum arquivo de estado encontrado em $STATE_FILE."
  fi

  local license_path="$INSTALL_DIR/licenses/license.json"
  if [ -f "$license_path" ]; then
    echo "--- LICENÇA COMERCIAL DETECTADA ---"
    local lic_id cust_name exp_at lic_type max_tenants white_label resale
    lic_id="$(grep '"license_id":' "$license_path" 2>/dev/null | awk -F'"' '{print $4}' || echo "desconhecido")"
    cust_name="$(grep '"name":' "$license_path" 2>/dev/null | awk -F'"' '{print $4}' || echo "desconhecido")"
    lic_type="$(grep '"license_type":' "$license_path" 2>/dev/null | awk -F'"' '{print $4}' || echo "desconhecido")"
    exp_at="$(grep '"expires_at":' "$license_path" 2>/dev/null | awk -F'"' '{print $4}' || echo "desconhecido")"
    max_tenants="$(grep '"max_tenants":' "$license_path" 2>/dev/null | awk -F': ' '{print $2}' | tr -d ',\r\n' || echo "desconhecido")"
    white_label="$(grep '"white_label":' "$license_path" 2>/dev/null | awk -F': ' '{print $2}' | tr -d ',\r\n' || echo "desconhecido")"
    resale="$(grep '"resale_allowed":' "$license_path" 2>/dev/null | awk -F': ' '{print $2}' | tr -d ',\r\n' || echo "desconhecido")"

    echo "  ID da Licença: $lic_id"
    echo "  Cliente: $cust_name"
    echo "  Tipo Comercial: $lic_type"
    echo "  Expiração: $exp_at"
    echo "  Capacidades Habilitadas:"
    echo "    - Revenda / Multi-cliente: $resale"
    echo "    - White-Label / Marca Própria: $white_label"
    echo "    - Limite Global de Empresas (max_tenants): $max_tenants"
    echo ""
  else
    log "Arquivo de licença não encontrado em $license_path (Modo não licenciado / restrito)."
  fi

  echo "--- ESTADO DOS SERVIÇOS DOCKER ---"
  docker compose -f "$COMPOSE_FILE" ps 2>/dev/null || true
}

# Main CLI Dispatcher
if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  case "${1:-help}" in
    install)
      shift
      cmd_install "$@"
      ;;
    update)
      shift
      cmd_update "$@"
      ;;
    status)
      cmd_status
      ;;
    help|--help|-h)
      echo "Uso: clientix-installer <install|update|status|help>"
      ;;
    *)
      die "Comando desconhecido: ${1:-}"
      ;;
  esac
fi
