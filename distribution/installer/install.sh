#!/usr/bin/env bash
# Clientix Commercial Installer & Operational CLI
# Suporta: install, update, adopt, rollback, health, status
set -euo pipefail
set +x

INSTALL_DIR="${CLIENTIX_DIR:-/opt/clientix}"
INSTALLER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$INSTALLER_DIR/postgres-tls.sh"
source "$INSTALLER_DIR/ingress-contract.sh"
. "$INSTALLER_DIR/installation-id.sh"
STATE_FILE="$INSTALL_DIR/state/release.json"
ENV_FILE="$INSTALL_DIR/.env"
COMPOSE_FILE="$INSTALL_DIR/compose.yaml"
DNS_EXTERNAL_COMPOSE_FILE="$INSTALL_DIR/compose.dns-cloudflare.yaml"
DNS_EPHEMERAL_COMPOSE_FILE="$INSTALL_DIR/compose.dns-cloudflare-ephemeral.yaml"
LEGACY_CLOUDFLARE_TOKEN_FILE="$INSTALL_DIR/state/secrets/cloudflare-api-token"
COMPOSE_FILES=(-f "$COMPOSE_FILE")
BACKUP_DIR="$INSTALL_DIR/backups"
MANIFEST_FILE="$INSTALLER_DIR/release-manifest.json"
MANIFEST_VERIFIER="$INSTALLER_DIR/verify-release-manifest.mjs"
MANIFEST_TRUST_ROOT="$INSTALLER_DIR/trust/release-manifest"
UPDATE_TRANSACTION_TOOL="$INSTALLER_DIR/release-update-transaction.mjs"
INSTALLER_VERSION_FILE="$INSTALLER_DIR/VERSION"
INSTALLER_CURRENT_VERSION=""
VERIFIED_IMAGE_CADDY=""
VERIFIED_RELEASE_ID=""
CLI_DNS_SECRET_MODE=""
CLI_DNS_SECRET_FILE=""
CLI_DNS_SECRET_FILE_SET=0
CLI_DRY_RUN=0
CLI_CONFIRM_IRREVERSIBLE_RELEASE_ID=""
CLI_TEST_MODE=0
RUNTIME_CLOUDFLARE_TOKEN=""
RUNTIME_SECRET_STDIN_REQUIRED=0
UPDATE_LOCK_FILE="$INSTALL_DIR/state/update.lock"
UPDATE_LOCK_FD=""
UPDATE_LOCK_HELD=0
UPDATE_ACTIVE=0
UPDATE_EXIT_HANDLER_ACTIVE=0
UPDATE_TRANSACTION_ID=""
UPDATE_JOURNAL_STATE=""
UPDATE_SOURCE_VERSION=""
UPDATE_TARGET_VERSION=""
UPDATE_RELEASE_ID=""
UPDATE_SOURCE_RELEASE_ID=""
UPDATE_SIGNER_KEY_ID=""
UPDATE_SOURCE_IMAGES_JSON=""
UPDATE_TARGET_IMAGES_JSON=""
UPDATE_SOURCE_SCHEMA=""
UPDATE_TARGET_SCHEMA=""
UPDATE_SCHEMA_AFTER=""
UPDATE_CHECKPOINT_DIR=""
UPDATE_BACKUP_PATH=""
UPDATE_BACKUP_SHA256=""
UPDATE_CONFIG_CHANGED=0
UPDATE_MIGRATION_STARTED=0
UPDATE_ROLLBACK_COMPATIBLE=0
UPDATE_LEGACY_SOURCE=0
UPDATE_FAILURE_CODE="UPDATE_FAILED"
REGISTRY_AUTHED=0

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
  if [ "${UPDATE_EXIT_HANDLER_ACTIVE:-0}" = "1" ]; then
    return 1
  fi
  if [ "${UPDATE_ACTIVE:-0}" = "1" ]; then
    local code="${1%%:*}"
    [[ "$code" =~ ^[A-Z][A-Z0-9_]{0,63}$ ]] && UPDATE_FAILURE_CODE="$code"
  fi
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
  command -v realpath >/dev/null 2>&1 || die "REALPATH_AUSENTE: realpath é obrigatório para validar o arquivo de segredo externo."

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
  if grep -Eq '^[[:space:]]*(export[[:space:]]+)?CLOUDFLARE_API_TOKEN[[:space:]]*=' "$ENV_FILE"; then
    die "CLOUDFLARE_TOKEN_ENV_FORBIDDEN: remova CLOUDFLARE_API_TOKEN do .env; use arquivo externo ou stdin efêmero."
  fi
  if [[ ${CLOUDFLARE_API_TOKEN+x} ]]; then
    die "CLOUDFLARE_TOKEN_ENV_FORBIDDEN: não forneça CLOUDFLARE_API_TOKEN no ambiente do instalador."
  fi
  set -a
  # shellcheck source=/dev/null
  # Normaliza CRLF sem alterar o arquivo de origem.
  source <(sed 's/\r$//' "$ENV_FILE")
  set +a
  CLIENTIX_ACME_SECRET_MODE="${CLIENTIX_ACME_SECRET_MODE:-external}"
  CLIENTIX_CLOUDFLARE_TOKEN_FILE="${CLIENTIX_CLOUDFLARE_TOKEN_FILE:-}"
  if [ -n "$CLI_DNS_SECRET_MODE" ]; then
    CLIENTIX_ACME_SECRET_MODE="$CLI_DNS_SECRET_MODE"
  fi
  if [ "$CLI_DNS_SECRET_FILE_SET" -eq 1 ]; then
    CLIENTIX_CLOUDFLARE_TOKEN_FILE="$CLI_DNS_SECRET_FILE"
  fi
  COMPOSE_FILES=(-f "$COMPOSE_FILE")
  if [[ "${CLIENTIX_ACME_CHALLENGE:-direct}" == "dns" ]]; then
    case "$CLIENTIX_ACME_SECRET_MODE" in
      external)
        if [ -f "$DNS_EXTERNAL_COMPOSE_FILE" ]; then
          COMPOSE_FILES+=(-f "$DNS_EXTERNAL_COMPOSE_FILE")
        fi
        ;;
      ephemeral)
        if [ -f "$DNS_EPHEMERAL_COMPOSE_FILE" ]; then
          COMPOSE_FILES+=(-f "$DNS_EPHEMERAL_COMPOSE_FILE")
        fi
        ;;
    esac
  fi
}

compose() {
  docker compose "${COMPOSE_FILES[@]}" --env-file "$ENV_FILE" "$@"
}

# 5. Validação de Evolução de Configuração (Check de Variáveis Obrigatórias)
validate_config_evolution() {
  log "Verificando consistência de variáveis obrigatórias contra .env.example..."
  local missing=() key
  local required=(INSTALLATION_ID DOMAIN ACME_EMAIL CLIENTIX_ACME_CHALLENGE NEXT_PUBLIC_APP_URL NEXT_PUBLIC_ADMIN_URL NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY INTERNAL_SECRET CPF_ENCRYPTION_KEY WAHA_BYO_ENCRYPTION_KEY AI_CRED_AES_KEY SUPABASE_DB_URL SUPABASE_DB_ADMIN_URL WAHA_API_BASE_URL WAHA_API_KEY WAHA_WEBHOOK_BASE_URL UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN APP_IMAGE WORKER_IMAGE SCHEDULER_IMAGE VOICE_AGENT_IMAGE MIGRATOR_IMAGE)
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
  local required=(DOMAIN ACME_EMAIL NEXT_PUBLIC_APP_URL NEXT_PUBLIC_ADMIN_URL NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY SUPABASE_DB_URL SUPABASE_DB_ADMIN_URL WAHA_API_BASE_URL WAHA_API_KEY WAHA_WEBHOOK_BASE_URL UPSTASH_REDIS_REST_URL UPSTASH_REDIS_REST_TOKEN)
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

validate_ingress_config() {
  clientix_valid_acme_config "${CLIENTIX_ACME_CHALLENGE:-direct}" "${CLIENTIX_ACME_DNS_PROVIDER:-}" ||
    die "INGRESS_ACME_MODE_INVALID: use CLIENTIX_ACME_CHALLENGE=direct or dns; DNS mode requires CLIENTIX_ACME_DNS_PROVIDER=cloudflare."
  clientix_valid_public_domain "${DOMAIN:-}" || die "INGRESS_DOMAIN_INVALID: DOMAIN deve ser um hostname DNS público completo, sem esquema, porta ou caminho."
  clientix_valid_acme_email "${ACME_EMAIL:-}" || die "INGRESS_ACME_EMAIL_INVALID: ACME_EMAIL deve conter um endereço válido para avisos de certificado."

  local canonical_origin="https://${DOMAIN}"
  for key in NEXT_PUBLIC_APP_URL NEXT_PUBLIC_ADMIN_URL WAHA_WEBHOOK_BASE_URL; do
    clientix_is_https_origin_for_domain "${!key:-}" "$DOMAIN" ||
      die "INGRESS_CANONICAL_ORIGIN_MISMATCH: $key deve ser exatamente $canonical_origin."
  done
  if [ -n "${META_WEBHOOK_BASE_URL:-}" ] &&
    ! clientix_is_https_public_origin "$META_WEBHOOK_BASE_URL"; then
    die "INGRESS_META_ORIGIN_INVALID: META_WEBHOOK_BASE_URL deve ser uma origem HTTPS pública sem porta, caminho ou credenciais."
  fi
}

validate_dns_ingress_release() {
  [ "${CLIENTIX_ACME_CHALLENGE:-direct}" != "dns" ] ||
    [ -n "$VERIFIED_IMAGE_CADDY" ] ||
    die "INGRESS_DNS_IMAGE_UNAVAILABLE: DNS-01 requer imagem Caddy Cloudflare com digest incluído no manifesto de release assinado."
}

require_dns_caddy_image_digest() {
  [ "${CLIENTIX_ACME_CHALLENGE:-direct}" != "dns" ] ||
    [[ "${CADDY_IMAGE:-}" =~ ^[^[:space:]@]+@sha256:[a-f0-9]{64}$ ]] ||
    die "INGRESS_DNS_IMAGE_UNAVAILABLE: DNS-01 requer imagem Caddy referenciada por digest."
}

validate_cloudflare_token_source() {
  if [ "${CLIENTIX_ACME_CHALLENGE:-direct}" != "dns" ]; then
    [ "$RUNTIME_SECRET_STDIN_REQUIRED" -eq 0 ] && [ -z "$CLI_DNS_SECRET_MODE" ] ||
      die "CLOUDFLARE_SECRET_MODE_CONFLICT: segredo DNS-01 só pode ser usado quando CLIENTIX_ACME_CHALLENGE=dns."
    return 0
  fi
  [ "${CLIENTIX_ACME_DNS_PROVIDER:-}" = "cloudflare" ] ||
    die "INGRESS_ACME_MODE_INVALID: DNS-01 aceita somente o provider Cloudflare configurado explicitamente."
  case "${CLIENTIX_ACME_SECRET_MODE:-}" in
    external)
      [ "$RUNTIME_SECRET_STDIN_REQUIRED" -eq 0 ] ||
        die "CLOUDFLARE_SECRET_MODE_CONFLICT: selecione arquivo externo ou modo efêmero, sem combinar os dois."
      CLIENTIX_CLOUDFLARE_TOKEN_FILE="$(validate_external_cloudflare_secret_file "${CLIENTIX_CLOUDFLARE_TOKEN_FILE:-}")" ||
        die "CLOUDFLARE_EXTERNAL_SECRET_INVALID: informe um arquivo externo root-owned, regular, não-link e com permissões 0400 ou 0600."
      ;;
    ephemeral)
      [ -z "${CLIENTIX_CLOUDFLARE_TOKEN_FILE:-}" ] ||
        die "CLOUDFLARE_SECRET_MODE_CONFLICT: modo efêmero não aceita caminho persistido de segredo."
      [ "$RUNTIME_SECRET_STDIN_REQUIRED" -eq 1 ] ||
        die "CLOUDFLARE_EPHEMERAL_STDIN_REQUIRED: use --cloudflare-token-stdin para fornecer o segredo somente por stdin."
      ;;
    *)
      die "CLOUDFLARE_SECRET_MODE_INVALID: use CLIENTIX_ACME_SECRET_MODE=external ou ephemeral."
      ;;
  esac
}

validate_external_cloudflare_secret_file() {
  local path="${1:-}" canonical install_root metadata owner mode links allowed_owner=0
  [[ "$path" == /* ]] || return 1
  [[ "$path" =~ ^/[A-Za-z0-9._\ /-]+$ ]] || return 1
  [ -f "$path" ] && [ ! -L "$path" ] && [ -s "$path" ] || return 1
  canonical="$(realpath -e -- "$path" 2>/dev/null)" || return 1
  [ "$canonical" = "$path" ] || return 1
  install_root="$(realpath -m -- "$INSTALL_DIR" 2>/dev/null)" || return 1
  if [ "$install_root" = "/" ]; then
    return 1
  fi
  case "$canonical" in
    "$install_root"|"$install_root"/*) return 1 ;;
  esac
  metadata="$(stat -c '%u %a %h' -- "$canonical" 2>/dev/null)" || return 1
  read -r owner mode links <<<"$metadata"
  if [[ -n "${CLIENTIX_CLOUDFLARE_TOKEN_OWNER_UID:-}" ]]; then
    [[ "$CLIENTIX_CLOUDFLARE_TOKEN_OWNER_UID" =~ ^[0-9]+$ ]] || return 1
    allowed_owner="$CLIENTIX_CLOUDFLARE_TOKEN_OWNER_UID"
  fi
  [ "$owner" = "0" ] || [ "$owner" = "$allowed_owner" ] || return 1
  case "$mode" in 400|600) ;; *) return 1 ;; esac
  [ "$links" = "1" ] || return 1
  printf '%s' "$canonical"
}

persist_dns_secret_config() {
  [ "${CLIENTIX_ACME_CHALLENGE:-direct}" = "dns" ] || return 0
  case "$CLIENTIX_ACME_SECRET_MODE" in
    external)
      CLIENTIX_CLOUDFLARE_TOKEN_FILE="$(validate_external_cloudflare_secret_file "$CLIENTIX_CLOUDFLARE_TOKEN_FILE")" ||
        die "CLOUDFLARE_EXTERNAL_SECRET_INVALID: arquivo externo deixou de cumprir o contrato de segurança."
      set_env_value CLIENTIX_ACME_SECRET_MODE external
      set_env_value CLIENTIX_CLOUDFLARE_TOKEN_FILE "'$CLIENTIX_CLOUDFLARE_TOKEN_FILE'"
      ;;
    ephemeral)
      set_env_value CLIENTIX_ACME_SECRET_MODE ephemeral
      set_env_value CLIENTIX_CLOUDFLARE_TOKEN_FILE ""
      ;;
  esac
  load_env
}

read_runtime_cloudflare_token() {
  local token="" extra=""
  export -n token 2>/dev/null || true
  set +x
  if [ -t 0 ]; then
    printf '%s' 'Token DNS-01 (entrada oculta): ' >&2
    IFS= read -r -s token || [ -n "$token" ] ||
      die "CLOUDFLARE_TOKEN_STDIN_EMPTY: stdin não contém um token DNS-01 válido."
    printf '\n' >&2
  else
    if ! IFS= read -r token && [ -z "$token" ]; then
      die "CLOUDFLARE_TOKEN_STDIN_EMPTY: stdin não contém um token DNS-01 válido."
    fi
    if IFS= read -r extra || [ -n "$extra" ]; then
      die "CLOUDFLARE_TOKEN_STDIN_FORMAT_INVALID: stdin deve conter somente uma linha de token."
    fi
  fi
  [[ "$token" =~ ^[A-Za-z0-9_-]{20,256}$ ]] ||
    die "CLOUDFLARE_TOKEN_STDIN_FORMAT_INVALID: token sintético/runtime deve ser uma única sequência ASCII sem espaços."
  RUNTIME_CLOUDFLARE_TOKEN="$token"
  unset token extra
}

inject_runtime_cloudflare_token() {
  local token="$1"
  export -n token 2>/dev/null || true
  printf '%s' "$token" | compose exec -T caddy sh -eu -c '
    umask 077
    target=/run/secrets/cloudflare_api_token
    temporary="${target}.tmp.$$"
    trap '\''rm -f -- "$temporary"'\'' EXIT
    cat > "$temporary"
    chmod 600 "$temporary"
    mv -f -- "$temporary" "$target"
    if [ "$(cat /proc/1/comm 2>/dev/null || true)" = caddy ]; then
      /usr/bin/caddy reload --config /etc/caddy/Caddyfile >/dev/null 2>&1
    fi
  ' >/dev/null 2>&1 || die "CLOUDFLARE_RUNTIME_INJECTION_FAILED: não foi possível injetar o segredo no tmpfs do Caddy."
}

inject_cloudflare_token_from_stdin() {
  export -n RUNTIME_CLOUDFLARE_TOKEN 2>/dev/null || true
  read_runtime_cloudflare_token
  inject_runtime_cloudflare_token "$RUNTIME_CLOUDFLARE_TOKEN"
  unset -v RUNTIME_CLOUDFLARE_TOKEN
}

remove_legacy_cloudflare_secret_after_ready() {
  if [ -e "$LEGACY_CLOUDFLARE_TOKEN_FILE" ] || [ -L "$LEGACY_CLOUDFLARE_TOKEN_FILE" ]; then
    rm -f -- "$LEGACY_CLOUDFLARE_TOKEN_FILE" ||
      die "LEGACY_CLOUDFLARE_SECRET_CLEANUP_FAILED: não foi possível remover o arquivo legado após o novo ingress ficar saudável."
    rmdir "$INSTALL_DIR/state/secrets" 2>/dev/null || true
  fi
}

check_ingress_ports_available() {
  local port owned_caddy=""
  if [ -f "$COMPOSE_FILE" ]; then
    owned_caddy="$(compose ps --status running -q caddy 2>/dev/null || true)"
  fi
  # A atualização pode encontrar o Caddy desta própria instalação já escutando.
  [ -n "$owned_caddy" ] && return 0

  for port in 80 443; do
    if (exec 9<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then
      die "INGRESS_PORT_IN_USE: a porta TCP $port já está ocupada. Libere-a antes de instalar/atualizar; nenhuma migration foi executada."
    fi
  done
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
    REGISTRY_AUTHED=1
    log "Autenticação no registro concluída com sucesso."
  fi
}

registry_logout() {
  if [ -n "${REGISTRY_TOKEN:-}" ]; then
    docker logout ghcr.io >/dev/null 2>&1 || true
  fi
  REGISTRY_AUTHED=0
}

# 7. Validação de Manifesto de Release
validate_manifest() {
  [ -f "$MANIFEST_FILE" ] || die "MANIFEST_AUSENTE: release-manifest.json não encontrado."
  [ -f "$INSTALLER_VERSION_FILE" ] || die "INSTALLER_VERSION_UNAVAILABLE: arquivo VERSION do instalador não encontrado."
  INSTALLER_CURRENT_VERSION="$(tr -d '\r' < "$INSTALLER_VERSION_FILE")"
  [ -n "$INSTALLER_CURRENT_VERSION" ] || die "INSTALLER_VERSION_UNAVAILABLE: arquivo VERSION do instalador está vazio."
  local verified
  local -a test_mode_args=()
  [ "$CLI_TEST_MODE" -eq 0 ] || test_mode_args=(--test-mode)
  if ! verified="$(node "$MANIFEST_VERIFIER" verify "$MANIFEST_FILE" "$MANIFEST_TRUST_ROOT" "$INSTALLER_CURRENT_VERSION" "${test_mode_args[@]}" 2>&1)"; then
    die "$verified"
  fi
  VERIFIED_MANIFEST_JSON="$verified"
  VERIFIED_RELEASE_ID="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.release_id)' "$VERIFIED_MANIFEST_JSON")"
  VERIFIED_RELEASE_VERSION="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.release_version)' "$VERIFIED_MANIFEST_JSON")"
  VERIFIED_SCHEMA_TARGET="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.schema_target)' "$VERIFIED_MANIFEST_JSON")"
  VERIFIED_IMAGE_APP="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.images.app)' "$VERIFIED_MANIFEST_JSON")"
  VERIFIED_IMAGE_WORKER="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.images.worker)' "$VERIFIED_MANIFEST_JSON")"
  VERIFIED_IMAGE_SCHEDULER="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.images.scheduler)' "$VERIFIED_MANIFEST_JSON")"
  VERIFIED_IMAGE_VOICE_AGENT="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.images.voice_agent)' "$VERIFIED_MANIFEST_JSON")"
  VERIFIED_IMAGE_MIGRATOR="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.images.migrator)' "$VERIFIED_MANIFEST_JSON")"
  VERIFIED_IMAGE_CADDY="$(node -e 'const d=JSON.parse(process.argv[1]); process.stdout.write(d.images.caddy || "")' "$VERIFIED_MANIFEST_JSON")"
  log "Manifesto assinado validado: Release $VERIFIED_RELEASE_VERSION (schema $VERIFIED_SCHEMA_TARGET; installer $INSTALLER_CURRENT_VERSION)."
}

check_schema_compatibility() {
  local status_json="$1"
  local result
  local -a test_mode_args=()
  [ "$CLI_TEST_MODE" -eq 0 ] || test_mode_args=(--test-mode)
  if ! result="$(printf '%s' "$status_json" | node "$MANIFEST_VERIFIER" schema-check \
      "$MANIFEST_FILE" "$MANIFEST_TRUST_ROOT" "$INSTALLER_CURRENT_VERSION" - "${test_mode_args[@]}" 2>&1)"; then
    die "$result"
  fi
  log "Compatibilidade de schema confirmada: $result"
}

verify_signed_manifest_file() {
  local manifest_path="$1"
  if [ -z "$INSTALLER_CURRENT_VERSION" ]; then
    [ -f "$INSTALLER_VERSION_FILE" ] || die "INSTALLER_VERSION_UNAVAILABLE: versão do instalador não pode ser lida para validar o rollback."
    INSTALLER_CURRENT_VERSION="$(tr -d '\r' < "$INSTALLER_VERSION_FILE")"
  fi
  local -a test_mode_args=()
  [ "$CLI_TEST_MODE" -eq 0 ] || test_mode_args=(--test-mode)
  node "$MANIFEST_VERIFIER" verify "$manifest_path" "$MANIFEST_TRUST_ROOT" "$INSTALLER_CURRENT_VERSION" "${test_mode_args[@]}"
}

check_source_schema_compatibility() {
  local status_json="$1"
  node -e '
    const status = JSON.parse(process.argv[1]);
    const minimum = process.argv[2];
    const maximum = process.argv[3];
    if (status.state_type !== "TRACKED_INSTALLATION" || status.schema_evidence_valid !== true ||
        typeof status.current_schema !== "string" || !/^\d{4,6}$/.test(status.current_schema)) process.exit(2);
    const current = Number(status.current_schema);
    if (current < Number(minimum)) { process.stderr.write("SCHEMA_TOO_OLD_FOR_DIRECT_UPDATE\n"); process.exit(3); }
    if (current > Number(maximum)) { process.stderr.write("SCHEMA_NEWER_THAN_RELEASE\n"); process.exit(4); }
  ' "$status_json" \
    "$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).compatibility.min_schema)' "$VERIFIED_MANIFEST_JSON")" \
    "$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).compatibility.max_schema)' "$VERIFIED_MANIFEST_JSON")" \
    || die "SOURCE_SCHEMA_COMPATIBILITY_FAILED: schema atual não é compatível com o manifesto assinado; nenhuma imagem foi puxada."
  log "Schema atual validado contra a faixa de origem assinada."
}

current_image_refs_json() {
  node -e '
    const names = ["app", "worker", "scheduler", "voice_agent", "migrator", "caddy"];
    const values = process.argv.slice(1);
    process.stdout.write(JSON.stringify(Object.fromEntries(names.map((name, index) => [name, values[index] || ""]))));
  ' "${APP_IMAGE:-}" "${WORKER_IMAGE:-}" "${SCHEDULER_IMAGE:-}" "${VOICE_AGENT_IMAGE:-}" "${MIGRATOR_IMAGE:-}" "${CADDY_IMAGE:-}"
}

validate_current_image_availability() {
  local image_refs="$1" ref repo expected actual
  while IFS= read -r ref; do
    [ -n "$ref" ] || die "CURRENT_IMAGE_DIGEST_INVALID: imagem atual sem referência por digest."
    [[ "$ref" =~ ^[^[:space:]@]+@sha256:[a-f0-9]{64}$ ]] || die "CURRENT_IMAGE_DIGEST_INVALID: imagem atual não está pinada por digest."
    repo="${ref%@*}"
    expected="${ref#*@}"
    docker image inspect "$ref" >/dev/null 2>&1 || die "PREVIOUS_IMAGE_UNAVAILABLE: imagem anterior necessária para rollback não está localmente disponível."
    actual="$(docker image inspect "$ref" --format '{{range .RepoDigests}}{{println .}}{{end}}' 2>/dev/null || true)"
    grep -Fxq "$repo@$expected" <<<"$actual" || die "PREVIOUS_IMAGE_DIGEST_MISMATCH: digest local da release anterior diverge do estado instalado."
  done < <(node -e 'const d=JSON.parse(process.argv[1]); for (const key of ["app","worker","scheduler","voice_agent","migrator","caddy"]) console.log(d[key]||"")' "$image_refs")
}

runtime_config_snapshot_json() {
  local value app_image worker_image scheduler_image voice_agent_image migrator_image caddy_image acme_challenge dns_provider secret_mode token_file
  app_image="$(read_env_value APP_IMAGE)"
  worker_image="$(read_env_value WORKER_IMAGE)"
  scheduler_image="$(read_env_value SCHEDULER_IMAGE)"
  voice_agent_image="$(read_env_value VOICE_AGENT_IMAGE)"
  migrator_image="$(read_env_value MIGRATOR_IMAGE)"
  caddy_image="$(read_env_value CADDY_IMAGE)"
  acme_challenge="$(read_env_value CLIENTIX_ACME_CHALLENGE)"
  dns_provider="$(read_env_value CLIENTIX_ACME_DNS_PROVIDER)"
  secret_mode="$(read_env_value CLIENTIX_ACME_SECRET_MODE)"
  token_file="$(read_env_value CLIENTIX_CLOUDFLARE_TOKEN_FILE)"
  node -e '
    const names = ["APP_IMAGE", "WORKER_IMAGE", "SCHEDULER_IMAGE", "VOICE_AGENT_IMAGE", "MIGRATOR_IMAGE", "CADDY_IMAGE", "CLIENTIX_ACME_CHALLENGE", "CLIENTIX_ACME_DNS_PROVIDER", "CLIENTIX_ACME_SECRET_MODE", "CLIENTIX_CLOUDFLARE_TOKEN_FILE"];
    const values = process.argv.slice(1);
    process.stdout.write(JSON.stringify(Object.fromEntries(names.map((name, index) => [name, values[index] || ""]))));
  ' "$app_image" "$worker_image" "$scheduler_image" "$voice_agent_image" "$migrator_image" "$caddy_image" "${acme_challenge:-direct}" "$dns_provider" "${secret_mode:-external}" "$token_file"
}

acquire_update_lock() {
  local transaction_id="$1"
  command -v flock >/dev/null 2>&1 || die "FLOCK_AUSENTE: util-linux/flock é obrigatório para impedir updates simultâneos."
  mkdir -p "$INSTALL_DIR/state" || die "UPDATE_LOCK_DIRECTORY_FAILED: não foi possível preparar o estado do updater."
  [ ! -L "$UPDATE_LOCK_FILE" ] || die "UPDATE_LOCK_PATH_UNSAFE: o arquivo de lock não pode ser symlink."
  if [ ! -e "$UPDATE_LOCK_FILE" ]; then (umask 077; : > "$UPDATE_LOCK_FILE") || die "UPDATE_LOCK_CREATE_FAILED: não foi possível criar o lock exclusivo."; fi
  [ -f "$UPDATE_LOCK_FILE" ] || die "UPDATE_LOCK_PATH_UNSAFE: o lock existente não é arquivo regular."
  exec {UPDATE_LOCK_FD}<> "$UPDATE_LOCK_FILE" || die "UPDATE_LOCK_OPEN_FAILED: não foi possível abrir o lock do updater."
  if ! flock -n "$UPDATE_LOCK_FD"; then
    exec {UPDATE_LOCK_FD}>&-
    UPDATE_LOCK_FD=""
    die "UPDATE_LOCK_ACTIVE: outra atualização ou rollback já está em andamento."
  fi
  if [ -s "$UPDATE_LOCK_FILE" ]; then
    log "UPDATE_STALE_LOCK_METADATA: o lock do sistema operacional estava livre; metadados anteriores serão substituídos com posse exclusiva."
  fi
  local metadata
  metadata="$(node -e 'process.stdout.write(JSON.stringify({pid:Number(process.argv[1]),transaction_id:process.argv[2],started_at:new Date().toISOString()}))' "$$" "$transaction_id")" || die "UPDATE_LOCK_METADATA_FAILED: não foi possível preparar metadados não sensíveis."
  : > "$UPDATE_LOCK_FILE" || die "UPDATE_LOCK_WRITE_FAILED: não foi possível atualizar metadados do lock."
  printf '%s\n' "$metadata" > "$UPDATE_LOCK_FILE" || die "UPDATE_LOCK_WRITE_FAILED: não foi possível gravar metadados do lock."
  chmod 600 "$UPDATE_LOCK_FILE" 2>/dev/null || true
  UPDATE_LOCK_HELD=1
  UPDATE_TRANSACTION_ID="$transaction_id"
}

release_update_lock() {
  if [ "${UPDATE_LOCK_HELD:-0}" = "1" ] && [ -n "${UPDATE_LOCK_FD:-}" ]; then
    flock -u "$UPDATE_LOCK_FD" 2>/dev/null || true
    exec {UPDATE_LOCK_FD}>&- 2>/dev/null || true
    UPDATE_LOCK_HELD=0
    UPDATE_LOCK_FD=""
  fi
}

write_update_journal() {
  local next_state="$1" error_code="${2:-}" schema_after="${3:-}" exit_code="${4:-}"
  local output metadata
  if [ -z "$exit_code" ]; then
    case "$next_state" in
      COMMITTED|ROLLED_BACK) exit_code=0 ;;
      FAILED_PRE_MIGRATION|FAILED_POST_MIGRATION|MANUAL_RECOVERY_REQUIRED) exit_code=1 ;;
    esac
  fi
  metadata="$(node -e '
    const [releaseId, sourceReleaseId, signerKeyId, sourceImages, targetImages, backupSha, transactionId] = process.argv.slice(1);
    const result = {
      release_id: releaseId || undefined,
      source_release_id: sourceReleaseId || null,
      signer_key_id: signerKeyId || undefined,
      source_images: sourceImages ? JSON.parse(sourceImages) : undefined,
      target_images: targetImages ? JSON.parse(targetImages) : undefined,
      checkpoint_id: transactionId || undefined,
      database_backup_sha256: /^[a-f0-9]{64}$/.test(backupSha || "") ? backupSha : undefined,
    };
    process.stdout.write(JSON.stringify(result));
  ' "$UPDATE_RELEASE_ID" "$UPDATE_SOURCE_RELEASE_ID" "$UPDATE_SIGNER_KEY_ID" \
      "$UPDATE_SOURCE_IMAGES_JSON" "$UPDATE_TARGET_IMAGES_JSON" "$UPDATE_BACKUP_SHA256" "$UPDATE_TRANSACTION_ID")" || return 1
  output="$(node "$UPDATE_TRANSACTION_TOOL" journal "$INSTALL_DIR" "$UPDATE_TRANSACTION_ID" "$next_state" \
    "$UPDATE_SOURCE_VERSION" "$UPDATE_TARGET_VERSION" "$UPDATE_SOURCE_SCHEMA" "$UPDATE_TARGET_SCHEMA" \
    "$error_code" "$schema_after" "$exit_code" "$metadata" 2>&1)" || { log_err "UPDATE_JOURNAL_WRITE_FAILED: $output"; return 1; }
  UPDATE_JOURNAL_STATE="$next_state"
  return 0
}

validate_target_migration_plan() {
  local target_status="$1"
  local result
  result="$(printf '%s' "$target_status" | node "$UPDATE_TRANSACTION_TOOL" validate-migrations "$INSTALL_DIR" "$VERIFIED_MANIFEST_JSON" 2>&1)" \
    || die "MIGRATION_PLAN_MISMATCH: migration IDs do manifesto não correspondem exatamente às migrations pendentes do ledger; nenhuma migration foi executada."
  log "Migration plan assinado validado: $result"
}

make_update_plan() {
  local current_images="$1" status_json="$2" payload input result
  local -a test_mode_args=()
  [ "$CLI_TEST_MODE" -eq 0 ] || test_mode_args=(--test-mode)
  payload="$(node -e 'process.stdout.write(JSON.stringify({verified_manifest:JSON.parse(process.argv[1]),current_images:JSON.parse(process.argv[2]),migrator_status:JSON.parse(process.argv[3]),legacy_source:process.argv[4]==="1"}))' \
    "$VERIFIED_MANIFEST_JSON" "$current_images" "$status_json" "$UPDATE_LEGACY_SOURCE")" || die "UPDATE_PLAN_INPUT_INVALID: não foi possível formar o plano validado."
  result="$(printf '%s' "$payload" | node "$UPDATE_TRANSACTION_TOOL" plan "$INSTALL_DIR" "$CLI_CONFIRM_IRREVERSIBLE_RELEASE_ID" "${test_mode_args[@]}" 2>&1)" || die "$result"
  printf '%s' "$result"
}

create_update_checkpoint() {
  local current_images="$1" plan_json="$2" runtime_config signed_manifest input
  local -a test_mode_args=()
  [ "$CLI_TEST_MODE" -eq 0 ] || test_mode_args=(--test-mode)
  runtime_config="$(runtime_config_snapshot_json)" || die "CHECKPOINT_CONFIG_SNAPSHOT_FAILED: não foi possível preparar o snapshot não sensível."
  signed_manifest="$(node -e 'const fs=require("node:fs");process.stdout.write(JSON.stringify(JSON.parse(fs.readFileSync(process.argv[1],"utf8"))))' "$MANIFEST_FILE")" || die "SIGNED_MANIFEST_UNAVAILABLE: manifesto não pôde ser relido após a verificação."
  input="$(node -e 'process.stdout.write(JSON.stringify({current_images:JSON.parse(process.argv[1]),runtime_config:JSON.parse(process.argv[2]),verified_manifest:JSON.parse(process.argv[3]),signed_manifest:JSON.parse(process.argv[4]),plan:JSON.parse(process.argv[5])}))' \
    "$current_images" "$runtime_config" "$VERIFIED_MANIFEST_JSON" "$signed_manifest" "$plan_json")" || die "CHECKPOINT_INPUT_INVALID: não foi possível preparar o checkpoint."
  printf '%s' "$input" | node "$UPDATE_TRANSACTION_TOOL" checkpoint "$INSTALL_DIR" "$UPDATE_TRANSACTION_ID" "${test_mode_args[@]}" >/dev/null || die "CHECKPOINT_CREATE_FAILED: checkpoint de configuração/release/imagens falhou."
  UPDATE_CHECKPOINT_DIR="$BACKUP_DIR/releases/$UPDATE_TRANSACTION_ID"
}

record_update_database_backup() {
  local backup_path="$1" backup_sha256="$2" size_bytes payload
  size_bytes="$(wc -c < "$backup_path" | tr -d '[:space:]')" || return 1
  payload="$(node -e 'process.stdout.write(JSON.stringify({path:process.argv[1],sha256:process.argv[2],size_bytes:Number(process.argv[3])}))' "$backup_path" "$backup_sha256" "$size_bytes")" || return 1
  printf '%s' "$payload" | node "$UPDATE_TRANSACTION_TOOL" record-db "$INSTALL_DIR" "$UPDATE_TRANSACTION_ID" >/dev/null
}

set_env_value_for_rollback() {
  local key="$1" value="$2" tmp value_file
  umask 077
  tmp="$(mktemp "${ENV_FILE}.rollback.XXXXXX")" || return 1
  value_file="$(mktemp "${ENV_FILE}.rollback-value.XXXXXX")" || { rm -f "$tmp"; return 1; }
  printf '%s' "$value" > "$value_file" || { rm -f "$tmp" "$value_file"; return 1; }
  awk -v key="$key" -v value_file="$value_file" '
    BEGIN { found = 0; getline value < value_file; close(value_file) }
    { sub(/\r$/, "") }
    index($0, key "=") == 1 { if (!found) print key "=" value; found = 1; next }
    { print }
    END { if (!found) print key "=" value }
  ' "$ENV_FILE" > "$tmp" || { rm -f "$tmp" "$value_file"; return 1; }
  rm -f "$value_file"
  chmod 600 "$tmp" || { rm -f "$tmp"; return 1; }
  mv "$tmp" "$ENV_FILE"
}

restore_update_checkpoint() {
  local checkpoint_id="$1" schema_version="$2" restored key value
  local -a test_mode_args=()
  [ "$CLI_TEST_MODE" -eq 0 ] || test_mode_args=(--test-mode)
  restored="$(node "$UPDATE_TRANSACTION_TOOL" restore "$INSTALL_DIR" "$checkpoint_id" "$schema_version" "${test_mode_args[@]}" 2>&1)" || return 1
  for key in APP_IMAGE WORKER_IMAGE SCHEDULER_IMAGE VOICE_AGENT_IMAGE MIGRATOR_IMAGE CADDY_IMAGE \
      CLIENTIX_ACME_CHALLENGE CLIENTIX_ACME_DNS_PROVIDER CLIENTIX_ACME_SECRET_MODE CLIENTIX_CLOUDFLARE_TOKEN_FILE; do
    value="$(node -e 'const d=JSON.parse(process.argv[1]);const key=process.argv[2];process.stdout.write(d.runtime_config[key]||"")' "$restored" "$key" 2>/dev/null)" || return 1
    set_env_value_for_rollback "$key" "$value" || return 1
  done
  load_env || return 1
  compose config --quiet || return 1
  return 0
}

# 8. Verificação e Pull de Imagens Target com Validação de Digest
ensure_target_images() {
  log "Verificando disponibilidade e integridade das imagens do release..."
  local images=("$VERIFIED_IMAGE_APP" "$VERIFIED_IMAGE_WORKER" "$VERIFIED_IMAGE_SCHEDULER" "$VERIFIED_IMAGE_VOICE_AGENT" "$VERIFIED_IMAGE_MIGRATOR")
  [ -z "$VERIFIED_IMAGE_CADDY" ] || images+=("$VERIFIED_IMAGE_CADDY")
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
  set_env_value CADDY_IMAGE "$VERIFIED_IMAGE_CADDY"
  if ! grep -q '^CLIENTIX_ACME_CHALLENGE=' "$ENV_FILE"; then
    set_env_value CLIENTIX_ACME_CHALLENGE "${CLIENTIX_ACME_CHALLENGE:-direct}"
  fi
  if ! grep -q '^CLIENTIX_ACME_DNS_PROVIDER=' "$ENV_FILE"; then
    set_env_value CLIENTIX_ACME_DNS_PROVIDER "${CLIENTIX_ACME_DNS_PROVIDER:-}"
  fi
  load_env
  validate_config_evolution
}

parse_dns_secret_options() {
  local option
  CLI_DNS_SECRET_MODE=""
  CLI_DNS_SECRET_FILE=""
  CLI_DNS_SECRET_FILE_SET=0
  CLI_DRY_RUN=0
  CLI_CONFIRM_IRREVERSIBLE_RELEASE_ID=""
  CLI_TEST_MODE=0
  RUNTIME_SECRET_STDIN_REQUIRED=0
  INSTALL_ADOPT=0
  while [ "$#" -gt 0 ]; do
    option="$1"
    shift
    case "$option" in
      --cloudflare-token-file)
        [ "$#" -gt 0 ] || die "CLOUDFLARE_EXTERNAL_PATH_REQUIRED: informe o caminho absoluto do arquivo externo."
        [ -z "$CLI_DNS_SECRET_MODE" ] || die "CLOUDFLARE_SECRET_MODE_CONFLICT: selecione apenas um modo de segredo."
        CLI_DNS_SECRET_MODE=external
        CLI_DNS_SECRET_FILE="$1"
        CLI_DNS_SECRET_FILE_SET=1
        shift
        ;;
      --cloudflare-token-stdin)
        [ -z "$CLI_DNS_SECRET_MODE" ] || die "CLOUDFLARE_SECRET_MODE_CONFLICT: selecione apenas um modo de segredo."
        CLI_DNS_SECRET_MODE=ephemeral
        CLI_DNS_SECRET_FILE=""
        CLI_DNS_SECRET_FILE_SET=1
        RUNTIME_SECRET_STDIN_REQUIRED=1
        ;;
      --dry-run)
        [ "$CLI_DRY_RUN" -eq 0 ] || die "ARGUMENTO_DUPLICADO: --dry-run foi informado mais de uma vez."
        CLI_DRY_RUN=1
        ;;
      --confirm-irreversible)
        [ "$#" -gt 0 ] || die "IRREVERSIBLE_RELEASE_ID_REQUIRED: informe o release ID assinado a confirmar."
        [ -z "$CLI_CONFIRM_IRREVERSIBLE_RELEASE_ID" ] || die "ARGUMENTO_DUPLICADO: confirmação de migration irreversível repetida."
        CLI_CONFIRM_IRREVERSIBLE_RELEASE_ID="$1"
        [[ "$CLI_CONFIRM_IRREVERSIBLE_RELEASE_ID" =~ ^[a-z0-9][a-z0-9._-]{0,63}$ ]] || die "IRREVERSIBLE_RELEASE_ID_INVALID: release ID inválido."
        shift
        ;;
      --test-mode)
        [ "$CLI_TEST_MODE" -eq 0 ] || die "ARGUMENTO_DUPLICADO: --test-mode foi informado mais de uma vez."
        CLI_TEST_MODE=1
        ;;
      --adopt)
        INSTALL_ADOPT=1
        ;;
      *)
        die "ARGUMENTO_INVALIDO: opção não reconhecida para install/update/ingress reload."
        ;;
    esac
  done
}

configure_test_release_authority() {
  [ "$CLI_TEST_MODE" -eq 1 ] || return 0
  [ "${CLIENTIX_INSTALLER_TEST_MODE:-}" = "1" ] ||
    die "TEST_MODE_DISABLED: modo TEST requer CLIENTIX_INSTALLER_TEST_MODE=1 explicitamente no laboratório."
  local canonical_install_dir test_key
  canonical_install_dir="$(realpath -m -- "$INSTALL_DIR")" || die "TEST_INSTALL_PATH_INVALID: caminho do laboratório inválido."
  [[ "$canonical_install_dir" == /tmp/clientix-updater-test-* ]] &&
    [ "$canonical_install_dir" = "$INSTALL_DIR" ] && [ ! -L "$INSTALL_DIR" ] ||
    die "TEST_INSTALL_PATH_INVALID: modo TEST só é permitido em /tmp/clientix-updater-test-* sem symlink."
  MANIFEST_FILE="$INSTALL_DIR/test-fixtures/release-manifest.json"
  MANIFEST_TRUST_ROOT="$INSTALL_DIR/test-trust/release-manifest"
  [ -d "$MANIFEST_TRUST_ROOT" ] && [ ! -L "$MANIFEST_TRUST_ROOT" ] ||
    die "TEST_TRUST_ROOT_UNAVAILABLE: trust root TEST fixa do laboratório não existe."
  test_key="$MANIFEST_TRUST_ROOT/clientix-test-release-fixture.pem"
  [ -f "$test_key" ] && [ ! -L "$test_key" ] || die "TEST_RELEASE_KEY_UNAVAILABLE: chave pública TEST fixa não existe."
}

persist_runtime_dns_secret_mode() {
  [ "${CLIENTIX_ACME_CHALLENGE:-direct}" = "dns" ] || return 0
  persist_dns_secret_config
}

install_ingress_files() {
  cp "$INSTALLER_DIR/compose.yaml" "$COMPOSE_FILE"
  cp "$INSTALLER_DIR/compose.dns-cloudflare.yaml" "$DNS_EXTERNAL_COMPOSE_FILE"
  cp "$INSTALLER_DIR/compose.dns-cloudflare-ephemeral.yaml" "$DNS_EPHEMERAL_COMPOSE_FILE"
  if [ "${CLIENTIX_ACME_CHALLENGE:-direct}" = "dns" ]; then
    cp "$INSTALLER_DIR/Caddyfile.dns-cloudflare" "$INSTALL_DIR/Caddyfile"
  else
    cp "$INSTALLER_DIR/Caddyfile" "$INSTALL_DIR/Caddyfile"
  fi
  load_env
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
run_migrator_with_image() {
  local image="$1" cmd="$2"
  shift 2 || true
  log "Executando clientix-migrator: $cmd..."
  run_docker_with_database "$SUPABASE_DB_ADMIN_URL" "$image" "$cmd" "$@"
}

run_migrator() {
  run_migrator_with_image "$VERIFIED_IMAGE_MIGRATOR" "$@"
}

run_runtime_db_preflight() {
  local image="${1:-$VERIFIED_IMAGE_MIGRATOR}"
  log "Validando a conexão PostgreSQL usada pelo runtime..."
  run_docker_with_database "$SUPABASE_DB_URL" \
    --entrypoint node "$image" \
    -e 'const { Client } = require("pg"); const { resolvePostgresConnectionConfig } = require("/app/lib/postgres-tls-policy.cjs"); const policy = resolvePostgresConnectionConfig(process.env.DATABASE_URL); const client = new Client({ ...policy, connectionTimeoutMillis: 10000 }); client.connect().then(async () => { const result = await client.query("select session_user::text, current_user::text"); if (result.rows[0]?.session_user !== "agent_worker" || result.rows[0]?.current_user !== "agent_worker") throw new Error("RUNTIME_DATABASE_ROLE_INVALID"); await client.end(); }).catch(async () => { try { await client.end(); } catch {} process.exit(1); });' \
    || die "RUNTIME_DATABASE_ROLE_INVALID: SUPABASE_DB_URL deve autenticar diretamente como agent_worker; nenhuma migration foi aplicada."
  log "Conexão PostgreSQL do runtime validada como agent_worker."
}

# 10. Backup Lógico do Banco de Dados
run_backup() {
  local previous_umask
  previous_umask="$(umask)"
  umask 077
  local target_ver="$1"
  local current_ver="${2:-unknown}"
  local ts
  ts="$(date -u +'%Y%m%d_%H%M%S')"
  local bkp_file="$BACKUP_DIR/backup_${current_ver}_to_${target_ver}_${ts}.dump"
  local bkp_tmp="$bkp_file.partial.$$"
  local backup_image="${MIGRATOR_IMAGE:-}"
  log "Iniciando backup antes de mutação de banco: $bkp_file..."

  [[ "$backup_image" =~ ^[^[:space:]@]+@sha256:[a-f0-9]{64}$ ]] || die "CURRENT_MIGRATOR_DIGEST_INVALID: a imagem de migrador instalada não está pinada por digest."
  docker image inspect "$backup_image" >/dev/null 2>&1 || die "CURRENT_MIGRATOR_IMAGE_UNAVAILABLE: a imagem de migrador anterior não está disponível localmente; nenhuma migration foi executada."

  local secure_database_url
  secure_database_url="$(clientix_postgres_url_for_libpq "$SUPABASE_DB_ADMIN_URL")" \
    || die "DATABASE_TLS_CONFIG_INVALID: configure o banco remoto com TLS verificado; a URL foi recusada sem exibir credenciais."
  run_docker_with_database "$secure_database_url" \
    --entrypoint sh "$backup_image" \
    -c 'set -eu; if [ -n "${POSTGRES_SSL_ROOT_CERT:-}" ]; then printf "%s" "$POSTGRES_SSL_ROOT_CERT" | base64 -d > /tmp/clientix-postgres-root-ca.pem; chmod 600 /tmp/clientix-postgres-root-ca.pem; export PGSSLROOTCERT=/tmp/clientix-postgres-root-ca.pem; fi; exec pg_dump "$DATABASE_URL" -Fc' > "$bkp_tmp" || { rm -f "$bkp_tmp"; die "BACKUP_FAILED: Falha ao executar pg_dump do banco."; }

  if [ ! -s "$bkp_tmp" ]; then
    rm -f "$bkp_tmp"
    die "BACKUP_INVALID: Arquivo de backup está vazio ou não foi gerado."
  fi

  # Valida integridade via pg_restore --list
  docker run --rm \
    --user 0:0 \
    --entrypoint pg_restore \
    -v "$BACKUP_DIR:/backups:ro" \
    "$backup_image" --list "/backups/$(basename "$bkp_tmp")" >/dev/null 2>&1 || { rm -f "$bkp_tmp"; die "BACKUP_CORRUPTED: pg_restore falhou ao ler o catálogo do backup."; }
  mv "$bkp_tmp" "$bkp_file" || { rm -f "$bkp_tmp"; die "BACKUP_PROMOTION_FAILED: não foi possível publicar o backup completo."; }

  # Calcula checksum sha256 do arquivo de backup
  local bkp_sha256
  bkp_sha256="$(sha256sum "$bkp_file" 2>/dev/null | awk '{print $1}' || true)"
  log "Backup lógico concluído e validado com sucesso (SHA-256: $bkp_sha256)."

  # Rotação segura de backups (mantém os últimos N)
  local keep="${KEEP_LAST_N_BACKUPS:-5}"
  [[ "$keep" =~ ^[0-9]+$ ]] && [ "$keep" -ge 2 ] || die "BACKUP_RETENTION_INVALID: retenção deve preservar pelo menos dois backups."
  local count
  count="$(find "$BACKUP_DIR" -name "*.dump" | wc -l)"
  if [ "$count" -gt "$keep" ]; then
    log "Aplicando retenção de backups (mantendo os últimos $keep)..."
    local stale_backup
    while IFS= read -r stale_backup; do
      [ -n "$stale_backup" ] && rm -f -- "$stale_backup"
    done < <(find "$BACKUP_DIR" -type f -name "*.dump" -printf '%T@ %p\n' | sort -n | head -n -"$keep" | cut -d' ' -f2-)
  fi

  umask "$previous_umask"
  echo "$bkp_file"
}

# 11. Verificação de Saúde (HTTPS público + health check interno)
check_update_service_states() {
  local services_json
  services_json="$(compose ps --format json 2>/dev/null)" || return 1
  node -e '
    const raw = process.argv[1].trim();
    let services;
    try {
      if (raw.startsWith("[")) services = JSON.parse(raw);
      else services = raw.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    } catch { process.exit(2); }
    const byService = new Map(services.map(item => [item.Service, item]));
    const required = ["app", "worker", "scheduler", "caddy"];
    if (process.argv[2] === "1") required.push("voice-agent");
    for (const name of required) {
      const item = byService.get(name);
      if (!item || String(item.State).toLowerCase() !== "running") process.exit(3);
      if (["app", "worker", "scheduler"].includes(name) && !item.Health) process.exit(5);
      if (item.Health && String(item.Health).toLowerCase() !== "healthy") process.exit(4);
    }
  ' "$services_json" "$( [[ ",${COMPOSE_PROFILES:-}," == *,telefonia,* ]] && echo 1 || echo 0 )" || return 1
  return 0
}

check_health() {
  local timeout="${1:-45}"
  log "Aguardando HTTPS público e saúde da aplicação (timeout: ${timeout}s)..."
  local elapsed=0
  local https_ready=0
  local response_headers
  response_headers="$(mktemp)" || die "HTTPS_HEALTH_CHECK_FAILED: não foi possível preparar a verificação TLS."

  while [ $elapsed -lt $timeout ]; do
    # --resolve fixa o destino local do teste, mas mantém SNI, Host e validação
    # normal da cadeia/SAN do certificado público emitido para DOMAIN.
    local http_code
    http_code="$(curl --silent --show-error --max-time 5 --resolve "${DOMAIN}:443:127.0.0.1" \
      --dump-header "$response_headers" --output /dev/null --write-out "%{http_code}" \
      "https://${DOMAIN}/api/v1/health" 2>/dev/null || true)"
    if [ "$http_code" = "200" ] && grep -qi '^strict-transport-security: max-age=31536000' "$response_headers"; then
      https_ready=1
      # Espera os healthchecks reais de app, worker e scheduler; Caddy é
      # validado pelo HTTPS com SNI, certificado, HSTS e rota crítica acima.
      if check_update_service_states; then
        rm -f "$response_headers"
        local stopped
        stopped="$(compose ps --status exited -q 2>/dev/null || true)"
        if [ -n "$stopped" ]; then
          [ "${HEALTH_CHECK_RETURN_ONLY:-0}" = "1" ] && return 1
          die "CONTAINER_CRASH_DETECTED: Um ou mais serviços falharam no boot."
        fi
        log "Ingress HTTPS e serviços Clientix respondendo com sucesso (HTTP $http_code)."
        return 0
      fi
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done

  rm -f "$response_headers"
  [ "${HEALTH_CHECK_RETURN_ONLY:-0}" = "1" ] && return 1
  if [ "$https_ready" = "1" ]; then
    die "RELEASE_SERVICE_HEALTH_FAILED: app, worker, scheduler ou Caddy não ficaram saudáveis após ${timeout}s."
  fi
  die "HTTPS_INGRESS_NOT_READY: HTTPS com certificado válido e healthcheck não ficaram prontos para ${DOMAIN} após ${timeout}s. Confira DNS público, firewall TCP 80/443 e logs do serviço caddy; nenhuma instalação foi marcada como pronta."
}

# 12. Comando: install
cmd_install() {
  parse_dns_secret_options "$@"
  configure_test_release_authority
  [ "$CLI_DRY_RUN" -eq 0 ] && [ -z "$CLI_CONFIRM_IRREVERSIBLE_RELEASE_ID" ] || die "ARGUMENTO_INVALIDO: --dry-run e --confirm-irreversible pertencem somente ao update."
  preflight
  [ ! -f "$STATE_FILE" ] || die "ALREADY_INSTALLED: Instalação existente detectada no estado. Para atualizar, use 'clientix-installer update'."
  load_env
  validate_external_config
  validate_ingress_config
  check_ingress_ports_available
  validate_manifest
  validate_dns_ingress_release
  validate_cloudflare_token_source
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
    if [ "${ALLOW_ADOPT:-0}" = "1" ] || [ "${INSTALL_ADOPT:-0}" = "1" ]; then
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
  # banco, o instalador cria arquivos de estado sem copiar nenhum segredo DNS.
  init_directories
  setup_env
  persist_verified_image_refs
  persist_runtime_dns_secret_mode
  install_ingress_files
  compose config --quiet || die "INGRESS_COMPOSE_INVALID: configuração HTTPS do compose é inválida; nenhuma migration foi executada."
  run_migrator "$db_action"

  log "Subindo serviços Clientix..."
  compose up -d
  if [ "${CLIENTIX_ACME_CHALLENGE:-direct}" = "dns" ] && [ "$CLIENTIX_ACME_SECRET_MODE" = "ephemeral" ]; then
    inject_cloudflare_token_from_stdin
  fi

  if [ "${CLIENTIX_ACME_CHALLENGE:-direct}" = "dns" ]; then check_health 300; else check_health 45; fi
  remove_legacy_cloudflare_secret_after_ready

  local ver="$VERIFIED_RELEASE_VERSION"
  local schema_ver="$VERIFIED_SCHEMA_TARGET"
  local release_state_input
  local -a test_mode_args=()
  [ "$CLI_TEST_MODE" -eq 0 ] || test_mode_args=(--test-mode)
  release_state_input="$(node -e 'process.stdout.write(JSON.stringify({verified_manifest:JSON.parse(process.argv[1]),installation_id:process.argv[2]}))' "$VERIFIED_MANIFEST_JSON" "$INSTALLATION_ID")" || die "RELEASE_STATE_INPUT_INVALID: estado instalado não pôde ser preparado."
  printf '%s' "$release_state_input" | node "$UPDATE_TRANSACTION_TOOL" commit-state "$INSTALL_DIR" "$MANIFEST_FILE" "" "$schema_ver" "" "" "${test_mode_args[@]}" >/dev/null || die "RELEASE_STATE_COMMIT_FAILED: não foi possível registrar a release instalada."
  chmod 600 "$STATE_FILE" "$INSTALL_DIR/state/current-release-manifest.json"

  log "INSTALACAO CONCLUIDA COM SUCESSO! Versao: $ver (ID: $INSTALLATION_ID)"
}

# 13. Comando: update
handle_update_exit() {
  local exit_code="${1:-1}" schema_json="" observed_schema="" journal_error="${UPDATE_FAILURE_CODE:-UPDATE_FAILED}"
  set +e
  UPDATE_EXIT_HANDLER_ACTIVE=1
  if [ "${UPDATE_ACTIVE:-0}" = "1" ] && [ -n "${UPDATE_JOURNAL_STATE:-}" ]; then
    if [ "${UPDATE_MIGRATION_STARTED:-0}" = "1" ]; then
      if [ -z "$UPDATE_SCHEMA_AFTER" ] && [ -n "${VERIFIED_IMAGE_MIGRATOR:-}" ] && docker image inspect "$VERIFIED_IMAGE_MIGRATOR" >/dev/null 2>&1; then
        schema_json="$(run_migrator_with_image "$VERIFIED_IMAGE_MIGRATOR" status --json 2>/dev/null)"
        observed_schema="$(node -e 'try { const d=JSON.parse(process.argv[1]); if (/^\d{4,6}$/.test(d.current_schema||"")) process.stdout.write(d.current_schema); } catch {}' "$schema_json" 2>/dev/null)"
        if node -e 'const a=Number(process.argv[1]),b=Number(process.argv[2]),c=Number(process.argv[3]);process.exit(/^\d{4,6}$/.test(process.argv[1])&&a>=b&&a<=c?0:1)' "$observed_schema" "$UPDATE_SOURCE_SCHEMA" "$UPDATE_TARGET_SCHEMA"; then
          UPDATE_SCHEMA_AFTER="$observed_schema"
        fi
      fi
      if [ "$UPDATE_ROLLBACK_COMPATIBLE" = "1" ] && [[ "$UPDATE_SCHEMA_AFTER" =~ ^[0-9]{4,6}$ ]] && \
          node -e 'const a=Number(process.argv[1]),b=Number(process.argv[2]),c=Number(process.argv[3]);process.exit(a>=b&&a<=c?0:1)' "$UPDATE_SCHEMA_AFTER" "$UPDATE_SOURCE_SCHEMA" "$UPDATE_TARGET_SCHEMA"; then
        if write_update_journal ROLLBACK_IN_PROGRESS "$journal_error" "$UPDATE_SCHEMA_AFTER" &&
            restore_update_checkpoint "$UPDATE_TRANSACTION_ID" "$UPDATE_SCHEMA_AFTER" &&
            compose up -d >/dev/null 2>&1; then
          HEALTH_CHECK_RETURN_ONLY=1
          if [ "${CLIENTIX_ACME_CHALLENGE:-direct}" = "dns" ]; then
            check_health 300
          else
            check_health 45
          fi
          local rollback_health=$?
          unset HEALTH_CHECK_RETURN_ONLY
          if [ "$rollback_health" -eq 0 ]; then
            write_update_journal ROLLED_BACK "$journal_error" "$UPDATE_SCHEMA_AFTER" || true
            log "UPDATE_ROLLED_BACK: versao e configuracao anteriores restauradas; schema $UPDATE_SCHEMA_AFTER preservado."
          else
            write_update_journal MANUAL_RECOVERY_REQUIRED "ROLLBACK_HEALTH_FAILED" "$UPDATE_SCHEMA_AFTER" || true
            log_err "ROLLBACK_REQUIRES_OPERATOR_INTERVENTION: health gate da release anterior falhou; schema preservado."
          fi
        else
          write_update_journal MANUAL_RECOVERY_REQUIRED "AUTOMATIC_ROLLBACK_FAILED" "$UPDATE_SCHEMA_AFTER" || true
          log_err "ROLLBACK_REQUIRES_OPERATOR_INTERVENTION: nao foi possivel restaurar a configuracao anterior."
        fi
      else
        if [ "$UPDATE_JOURNAL_STATE" != "FAILED_POST_MIGRATION" ]; then
          write_update_journal FAILED_POST_MIGRATION "$journal_error" "$UPDATE_SCHEMA_AFTER" || true
        fi
        write_update_journal MANUAL_RECOVERY_REQUIRED "DATABASE_ROLLBACK_NOT_PROVEN" "$UPDATE_SCHEMA_AFTER" || true
        log_err "ROLLBACK_REQUIRES_OPERATOR_INTERVENTION: compatibilidade do app/schema nao foi comprovada; nenhum rollback de banco foi tentado."
      fi
    else
      if [ "${UPDATE_CONFIG_CHANGED:-0}" = "1" ]; then
        if restore_update_checkpoint "$UPDATE_TRANSACTION_ID" "$UPDATE_SOURCE_SCHEMA" && compose up -d >/dev/null 2>&1; then
          write_update_journal FAILED_PRE_MIGRATION "$journal_error" || true
        else
          write_update_journal MANUAL_RECOVERY_REQUIRED "PRE_MIGRATION_RESTORE_FAILED" || true
          log_err "UPDATE_RECOVERY_REQUIRED: restauracao pre-migration falhou."
        fi
      else
        write_update_journal FAILED_PRE_MIGRATION "$journal_error" || true
      fi
    fi
    UPDATE_ACTIVE=0
  fi
  UPDATE_EXIT_HANDLER_ACTIVE=0
  [ "${REGISTRY_AUTHED:-0}" = "1" ] && registry_logout
  release_update_lock
  trap - EXIT
  return "$exit_code"
}

cmd_update() {
  parse_dns_secret_options "$@"
  configure_test_release_authority
  UPDATE_LEGACY_SOURCE=0
  UPDATE_BACKUP_SHA256=""
  preflight
  [ -f "$STATE_FILE" ] || die "ESTADO_NAO_ENCONTRADO: Nenhuma instalacao anterior encontrada para atualizar."
  load_env
  validate_external_config
  validate_ingress_config
  check_ingress_ports_available
  validate_existing_runtime_config
  validate_manifest
  validate_dns_ingress_release
  validate_cloudflare_token_source
  validate_installation_id_binding

  local current_ver target_ver schema_ver transaction_id current_images status_json plan_json prior_journal prior_state
  local state_signer state_schema source_verified
  current_ver="$(node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.installed_version||""))' "$STATE_FILE")" || die "CURRENT_RELEASE_STATE_INVALID: versao instalada nao pode ser lida."
  target_ver="$VERIFIED_RELEASE_VERSION"
  schema_ver="$VERIFIED_SCHEMA_TARGET"
  current_images="$(current_image_refs_json)" || die "CURRENT_IMAGE_STATE_INVALID: referencias atuais nao puderam ser preparadas."
  local transaction_suffix
  transaction_suffix="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0,10))' "$VERIFIED_RELEASE_ID")" || die "UPDATE_TRANSACTION_ID_INVALID: não foi possível derivar o identificador da transação."
  transaction_id="tx-$(date -u +'%Y%m%d%H%M%S')-$$-$transaction_suffix"
  UPDATE_SOURCE_VERSION="$current_ver"
  UPDATE_TARGET_VERSION="$target_ver"
  UPDATE_TARGET_SCHEMA="$schema_ver"
  UPDATE_RELEASE_ID="$VERIFIED_RELEASE_ID"
  UPDATE_SIGNER_KEY_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).signer_key_id)' "$VERIFIED_MANIFEST_JSON")"
  UPDATE_SOURCE_RELEASE_ID="$(node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.release_id||""))' "$STATE_FILE")"
  state_signer="$(node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.signer_key_id||""))' "$STATE_FILE")" || die "CURRENT_RELEASE_STATE_INVALID: autoridade da release instalada nao pode ser lida."
  state_schema="$(node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));process.stdout.write(String(d.schema_version||""))' "$STATE_FILE")" || die "CURRENT_RELEASE_STATE_INVALID: schema da release instalada nao pode ser lido."
  if [ -z "$state_signer" ]; then
    [ ! -e "$INSTALL_DIR/state/current-release-manifest.json" ] && [ ! -L "$INSTALL_DIR/state/current-release-manifest.json" ] ||
      die "CURRENT_RELEASE_STATE_INCONSISTENT: manifesto instalado existe sem signer autenticado."
    node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));if(d.release_id||d.manifest_signature||d.images)process.exit(1)' "$STATE_FILE" ||
      die "CURRENT_RELEASE_STATE_INCONSISTENT: estado sem signer contém metadados parciais de release."
    UPDATE_LEGACY_SOURCE=1
    log "LEGACY_RELEASE_STATE_BOOTSTRAPPED: origem antiga validada por versão, ledger e seis digests locais; rollback ficará limitado aos mesmos digests."
  else
    [ -f "$INSTALL_DIR/state/current-release-manifest.json" ] && [ ! -L "$INSTALL_DIR/state/current-release-manifest.json" ] ||
      die "CURRENT_RELEASE_MANIFEST_UNAVAILABLE: release autenticada sem manifesto persistido."
    source_verified="$(verify_signed_manifest_file "$INSTALL_DIR/state/current-release-manifest.json" 2>&1)" ||
      die "CURRENT_RELEASE_MANIFEST_INVALID: assinatura da release instalada não pôde ser confirmada."
    node -e '
      const state=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"));
      const manifest=JSON.parse(process.argv[2]);
      const images=JSON.parse(process.argv[3]);
      if(state.installed_version!==manifest.release_version||state.release_id!==manifest.release_id||
         state.signer_key_id!==manifest.signer_key_id||state.manifest_signature!==manifest.signature||
         JSON.stringify(state.images)!==JSON.stringify(images))process.exit(2);
    ' "$STATE_FILE" "$source_verified" "$current_images" || die "CURRENT_RELEASE_STATE_MISMATCH: manifesto assinado, estado e digests instalados divergem."
  fi

  if [ "$CLI_DRY_RUN" -eq 0 ]; then
    acquire_update_lock "$transaction_id"
    trap 'handle_update_exit $?' EXIT
  fi
  prior_journal="$(node "$UPDATE_TRANSACTION_TOOL" read-journal "$INSTALL_DIR" 2>&1)" || die "UPDATE_JOURNAL_CORRUPTED: journal do updater nao pode ser lido."
  if [ "$prior_journal" != "null" ]; then
    prior_state="$(node -e 'const d=JSON.parse(process.argv[1]);process.stdout.write(d.state)' "$prior_journal")" || die "UPDATE_JOURNAL_CORRUPTED: journal invalido."
    case "$prior_state" in
      COMMITTED|FAILED_PRE_MIGRATION|ROLLED_BACK) ;;
      *) die "UPDATE_RECOVERY_REQUIRED: existe uma operacao incompleta ($prior_state); execute rollback antes de novo update." ;;
    esac
  fi

  check_external_dependencies
  compose config --quiet || die "CURRENT_COMPOSE_INVALID: configuração instalada não é válida."
  validate_current_image_availability "$current_images"
  run_runtime_db_preflight "${MIGRATOR_IMAGE:-}"
  status_json="$(run_migrator_with_image "${MIGRATOR_IMAGE:-}" status --json)"
  check_source_schema_compatibility "$status_json"
  UPDATE_SOURCE_SCHEMA="$(node -e 'const d=JSON.parse(process.argv[1]);process.stdout.write(d.current_schema)' "$status_json")" || die "MIGRATOR_STATUS_INVALID: schema atual ausente."
  [[ "$state_schema" =~ ^[0-9]{4,6}$ ]] && [ "$state_schema" = "$UPDATE_SOURCE_SCHEMA" ] ||
    die "CURRENT_RELEASE_SCHEMA_MISMATCH: schema persistido diverge do ledger atual."
  plan_json="$(make_update_plan "$current_images" "$status_json")"
  UPDATE_ROLLBACK_COMPATIBLE="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).rollback_compatible?"1":"0")' "$plan_json")"
  UPDATE_SOURCE_IMAGES_JSON="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).source_images))' "$plan_json")"
  UPDATE_TARGET_IMAGES_JSON="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).target_images))' "$plan_json")"

  if [ "$CLI_DRY_RUN" -eq 1 ]; then
    printf 'UPDATE_DRY_RUN=PASS\n%s\n' "$plan_json"
    return 0
  fi
  if [ "$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).idempotent?"1":"0")' "$plan_json")" = "1" ]; then
    check_external_dependencies
    run_runtime_db_preflight "${MIGRATOR_IMAGE:-}"
    if [ "${CLIENTIX_ACME_CHALLENGE:-direct}" = "dns" ]; then check_health 300; else check_health 45; fi
    log "UPDATE_IDEMPOTENT: release $target_ver e digests ja estao ativos e saudaveis."
    trap - EXIT
    release_update_lock
    return 0
  fi

  UPDATE_ACTIVE=1
  UPDATE_FAILURE_CODE="UPDATE_FAILED"
  write_update_journal PREFLIGHT_OK || die "UPDATE_JOURNAL_WRITE_FAILED: nao foi possivel iniciar o journal seguro."
  create_update_checkpoint "$current_images" "$plan_json"
  local bkp_path bkp_sha256 target_status post_migration_schema
  bkp_path="$(run_backup "$target_ver" "$current_ver")"
  bkp_sha256="$(sha256sum "$bkp_path" 2>/dev/null | awk '{print $1}')" || die "BACKUP_DIGEST_FAILED: nao foi possivel validar o checksum do backup."
  [[ "$bkp_sha256" =~ ^[a-f0-9]{64}$ ]] || die "BACKUP_DIGEST_FAILED: checksum do backup invalido."
  UPDATE_BACKUP_SHA256="$bkp_sha256"
  record_update_database_backup "$bkp_path" "$bkp_sha256" || die "BACKUP_CHECKPOINT_FAILED: backup do banco nao foi vinculado ao checkpoint."
  write_update_journal CHECKPOINT_CREATED || die "UPDATE_JOURNAL_WRITE_FAILED: checkpoint nao pode ser registrado."

  registry_auth
  ensure_target_images
  registry_logout
  write_update_journal IMAGES_PULLED || die "UPDATE_JOURNAL_WRITE_FAILED: imagens verificadas nao puderam ser registradas."

  target_status="$(run_migrator_with_image "$VERIFIED_IMAGE_MIGRATOR" status --json)"
  check_schema_compatibility "$target_status"
  validate_target_migration_plan "$target_status"
  init_directories
  [ -f "$INSTALL_DIR/state/installation_id" ] || write_installation_id_file "$INSTALLATION_ID"
  chown 1001:1001 "$INSTALL_DIR/state/installation_id" 2>/dev/null || die "INSTALLATION_ID_OWNERSHIP_FAILED: nao foi possivel entregar o ID ao runtime."
  chmod 640 "$INSTALL_DIR/state/installation_id" || die "INSTALLATION_ID_PERMISSIONS_FAILED: nao foi possivel proteger o ID persistente."
  UPDATE_CONFIG_CHANGED=1
  persist_verified_image_refs
  persist_runtime_dns_secret_mode
  install_ingress_files
  compose config --quiet || die "INGRESS_COMPOSE_INVALID: configuracao HTTPS do compose e invalida; nenhuma migration foi executada."
  write_update_journal CONFIG_PREPARED || die "UPDATE_JOURNAL_WRITE_FAILED: configuracao preparada nao pode ser registrada."

  UPDATE_MIGRATION_STARTED=1
  write_update_journal MIGRATION_STARTED || die "UPDATE_JOURNAL_WRITE_FAILED: inicio da migration nao pode ser registrado."
  run_migrator update --backup-ack
  post_migration_schema="$(run_migrator_with_image "$VERIFIED_IMAGE_MIGRATOR" status --json)"
  check_schema_compatibility "$post_migration_schema"
  UPDATE_SCHEMA_AFTER="$(node -e 'const d=JSON.parse(process.argv[1]);process.stdout.write(d.current_schema||"")' "$post_migration_schema")" || die "MIGRATOR_STATUS_INVALID: schema apos migration nao pode ser lido."
  [ "$UPDATE_SCHEMA_AFTER" = "$schema_ver" ] || die "MIGRATION_TARGET_SCHEMA_MISMATCH: ledger nao alcancou o schema assinado."
  write_update_journal MIGRATIONS_APPLIED "" "$UPDATE_SCHEMA_AFTER" || die "UPDATE_JOURNAL_WRITE_FAILED: migration aplicada nao pode ser registrada."

  compose up -d || die "RELEASE_START_FAILED: nao foi possivel iniciar os servicos da release candidata."
  write_update_journal SERVICES_STARTED "" "$UPDATE_SCHEMA_AFTER" || die "UPDATE_JOURNAL_WRITE_FAILED: servicos iniciados nao puderam ser registrados."
  if [ "${CLIENTIX_ACME_CHALLENGE:-direct}" = "dns" ] && [ "$CLIENTIX_ACME_SECRET_MODE" = "ephemeral" ]; then
    inject_cloudflare_token_from_stdin
  fi
  write_update_journal HEALTHCHECKING "" "$UPDATE_SCHEMA_AFTER" || die "UPDATE_JOURNAL_WRITE_FAILED: health checking nao pode ser registrado."
  run_runtime_db_preflight "$VERIFIED_IMAGE_MIGRATOR"
  check_external_dependencies
  if [ "${CLIENTIX_ACME_CHALLENGE:-direct}" = "dns" ]; then check_health 300; else check_health 45; fi
  remove_legacy_cloudflare_secret_after_ready

  local release_state_input
  release_state_input="$(node -e 'process.stdout.write(JSON.stringify({verified_manifest:JSON.parse(process.argv[1]),installation_id:process.argv[2]}))' "$VERIFIED_MANIFEST_JSON" "$INSTALLATION_ID")" || die "RELEASE_STATE_INPUT_INVALID: estado da release nao pode ser preparado."
  local -a test_mode_args=()
  [ "$CLI_TEST_MODE" -eq 0 ] || test_mode_args=(--test-mode)
  printf '%s' "$release_state_input" | node "$UPDATE_TRANSACTION_TOOL" commit-state "$INSTALL_DIR" "$MANIFEST_FILE" "$UPDATE_TRANSACTION_ID" "$UPDATE_SCHEMA_AFTER" "$bkp_path" "$bkp_sha256" "${test_mode_args[@]}" >/dev/null || die "RELEASE_STATE_COMMIT_FAILED: estado da release candidata nao pode ser promovido."
  chmod 600 "$STATE_FILE" "$INSTALL_DIR/state/current-release-manifest.json"
  write_update_journal COMMITTED "" "$UPDATE_SCHEMA_AFTER" || die "UPDATE_JOURNAL_WRITE_FAILED: commit da release nao pode ser registrado."
  UPDATE_ACTIVE=0
  trap - EXIT
  release_update_lock
  log "ATUALIZACAO CONCLUIDA COM SUCESSO para $target_ver; checkpoint anterior retido em $UPDATE_CHECKPOINT_DIR."
}

handle_rollback_exit() {
  local exit_code="${1:-1}"
  set +e
  if [ "$exit_code" -ne 0 ] && [ "$UPDATE_JOURNAL_STATE" = "ROLLBACK_IN_PROGRESS" ]; then
    log_err "ROLLBACK_INTERRUPTED: journal preservado em ROLLBACK_IN_PROGRESS para retomada segura."
  fi
  release_update_lock
  trap - EXIT
  return "$exit_code"
}

rollback_manual_recovery() {
  local code="$1"
  if [ -n "${UPDATE_TRANSACTION_ID:-}" ] && [ "$UPDATE_JOURNAL_STATE" != "MANUAL_RECOVERY_REQUIRED" ]; then
    write_update_journal MANUAL_RECOVERY_REQUIRED "$code" "${UPDATE_SCHEMA_AFTER:-}" || true
  fi
  log_err "ROLLBACK_REQUIRES_OPERATOR_INTERVENTION: $code; nenhum rollback de banco foi tentado."
  exit 1
}

cmd_rollback() {
  parse_dns_secret_options "$@"
  [ "$CLI_DRY_RUN" -eq 0 ] && [ -z "$CLI_CONFIRM_IRREVERSIBLE_RELEASE_ID" ] ||
    die "ARGUMENTO_INVALIDO: rollback não aceita --dry-run nem --confirm-irreversible."
  configure_test_release_authority
  preflight
  [ -f "$STATE_FILE" ] || die "CURRENT_RELEASE_STATE_UNAVAILABLE: instalação sem estado de release."
  load_env
  validate_existing_runtime_config
  local lock_id="rollback-$(date -u +'%Y%m%d%H%M%S')-$$"
  acquire_update_lock "$lock_id"
  trap 'handle_rollback_exit $?' EXIT

  local journal_json journal_state checkpoint_id checkpoint_json target_signed target_verified source_manifest_path source_verified
  local current_verified source_images_json target_migrator migration_started schema_json observed_schema source_mode source_path source_legacy
  local -a test_mode_args=()
  [ "$CLI_TEST_MODE" -eq 0 ] || test_mode_args=(--test-mode)
  journal_json="$(node "$UPDATE_TRANSACTION_TOOL" read-journal "$INSTALL_DIR" 2>&1)" || die "UPDATE_JOURNAL_CORRUPTED: journal do updater não pode ser lido."
  [ "$journal_json" != "null" ] || die "ROLLBACK_UNAVAILABLE: não existe transação de update para reverter."
  journal_state="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).state)' "$journal_json")" || die "UPDATE_JOURNAL_CORRUPTED: estado do journal inválido."
  case "$journal_state" in
    ROLLED_BACK|FAILED_PRE_MIGRATION)
      printf 'ROLLBACK_IDEMPOTENT=PASS\nSTATE=%s\n' "$journal_state"
      trap - EXIT
      release_update_lock
      return 0
      ;;
    MANUAL_RECOVERY_REQUIRED)
      die "ROLLBACK_REQUIRES_OPERATOR_INTERVENTION: journal já exige recuperação manual; estado preservado."
      ;;
    COMMITTED|PREFLIGHT_OK|CHECKPOINT_CREATED|IMAGES_PULLED|CONFIG_PREPARED|MIGRATION_STARTED|MIGRATIONS_APPLIED|SERVICES_STARTED|HEALTHCHECKING|FAILED_POST_MIGRATION|ROLLBACK_IN_PROGRESS) ;;
    *) die "UPDATE_JOURNAL_STATE_INVALID: estado não pode ser recuperado automaticamente." ;;
  esac

  UPDATE_TRANSACTION_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).transaction_id)' "$journal_json")" || die "UPDATE_JOURNAL_CORRUPTED: transaction ID ausente."
  UPDATE_JOURNAL_STATE="$journal_state"
  UPDATE_SOURCE_VERSION="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).source_version)' "$journal_json")"
  UPDATE_TARGET_VERSION="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).target_version)' "$journal_json")"
  UPDATE_SOURCE_SCHEMA="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).source_schema)' "$journal_json")"
  UPDATE_TARGET_SCHEMA="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).target_schema)' "$journal_json")"
  UPDATE_RELEASE_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).release_id||"")' "$journal_json")"
  UPDATE_SOURCE_RELEASE_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).source_release_id||"")' "$journal_json")"
  UPDATE_SIGNER_KEY_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).signer_key_id||"")' "$journal_json")"
  UPDATE_SOURCE_IMAGES_JSON="$(node -e 'const d=JSON.parse(process.argv[1]);if(d.source_images)process.stdout.write(JSON.stringify(d.source_images))' "$journal_json")"
  UPDATE_TARGET_IMAGES_JSON="$(node -e 'const d=JSON.parse(process.argv[1]);if(d.target_images)process.stdout.write(JSON.stringify(d.target_images))' "$journal_json")"
  UPDATE_BACKUP_SHA256="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).database_backup_sha256||"")' "$journal_json")"
  checkpoint_id="$UPDATE_TRANSACTION_ID"

  if [ "$journal_state" = "PREFLIGHT_OK" ]; then
    write_update_journal FAILED_PRE_MIGRATION "INTERRUPTED_BEFORE_CHECKPOINT" || die "UPDATE_JOURNAL_WRITE_FAILED: recuperação pré-checkpoint não pôde ser registrada."
    printf 'ROLLBACK_RECOVERY=PASS\nSTATE=FAILED_PRE_MIGRATION\n'
    trap - EXIT
    release_update_lock
    return 0
  fi

  checkpoint_json="$(node "$UPDATE_TRANSACTION_TOOL" read-checkpoint "$INSTALL_DIR" "$checkpoint_id" "${test_mode_args[@]}" 2>&1)" ||
    rollback_manual_recovery "CHECKPOINT_UNAVAILABLE"
  if [ -z "$INSTALLER_CURRENT_VERSION" ]; then
    [ -f "$INSTALLER_VERSION_FILE" ] || rollback_manual_recovery "INSTALLER_VERSION_UNAVAILABLE"
    INSTALLER_CURRENT_VERSION="$(tr -d '\r' < "$INSTALLER_VERSION_FILE")"
    [ -n "$INSTALLER_CURRENT_VERSION" ] || rollback_manual_recovery "INSTALLER_VERSION_UNAVAILABLE"
  fi
  target_signed="$(node -e 'const d=JSON.parse(process.argv[1]);if(!d.target_release?.signed)process.exit(2);process.stdout.write(JSON.stringify(d.target_release.signed))' "$checkpoint_json")" ||
    rollback_manual_recovery "TARGET_MANIFEST_UNAVAILABLE"
  if ! target_verified="$(printf '%s' "$target_signed" | node "$MANIFEST_VERIFIER" verify - "$MANIFEST_TRUST_ROOT" "$INSTALLER_CURRENT_VERSION" "${test_mode_args[@]}" 2>&1)"; then
    local target_verify_error="${target_verified%%$'\n'*}"
    target_verify_error="${target_verify_error%%:*}"
    [[ "$target_verify_error" =~ ^[A-Z][A-Z0-9_]{0,63}$ ]] || target_verify_error="VERIFIER_OUTPUT_INVALID"
    log_err "TARGET_MANIFEST_VERIFY_FAILED: $target_verify_error"
    rollback_manual_recovery "TARGET_MANIFEST_SIGNATURE_INVALID"
  fi
  source_manifest_path="$INSTALL_DIR/backups/releases/$checkpoint_id/release-state/current-release-manifest.json"
  source_legacy="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).legacy_source?"1":"0")' "$checkpoint_json")"
  if [ "$source_legacy" = "1" ]; then
    [ ! -e "$source_manifest_path" ] && [ ! -L "$source_manifest_path" ] || rollback_manual_recovery "LEGACY_SOURCE_HAS_UNEXPECTED_MANIFEST"
    source_verified="$(node -e 'const d=JSON.parse(process.argv[1]).release_state;if(d.signer_key_id||d.manifest_signature||d.release_id||d.images)process.exit(2);process.stdout.write(JSON.stringify({release_version:d.installed_version,release_id:null,signer_key_id:null,signature:null}))' "$checkpoint_json")" ||
      rollback_manual_recovery "LEGACY_SOURCE_STATE_INVALID"
  else
    [ -f "$source_manifest_path" ] && [ ! -L "$source_manifest_path" ] || rollback_manual_recovery "SOURCE_MANIFEST_UNAVAILABLE"
    source_verified="$(verify_signed_manifest_file "$source_manifest_path" 2>&1)" || rollback_manual_recovery "SOURCE_MANIFEST_SIGNATURE_INVALID"
  fi
  if [ "$journal_state" = "COMMITTED" ]; then
    current_verified="$(verify_signed_manifest_file "$INSTALL_DIR/state/current-release-manifest.json" 2>&1)" ||
      rollback_manual_recovery "CURRENT_MANIFEST_SIGNATURE_INVALID"
  elif [ "$source_legacy" = "1" ]; then
    [ ! -e "$INSTALL_DIR/state/current-release-manifest.json" ] && [ ! -L "$INSTALL_DIR/state/current-release-manifest.json" ] ||
      rollback_manual_recovery "LEGACY_CURRENT_MANIFEST_UNEXPECTED"
    current_verified="$source_verified"
  else
    current_verified="$(verify_signed_manifest_file "$INSTALL_DIR/state/current-release-manifest.json" 2>&1)" ||
      rollback_manual_recovery "CURRENT_MANIFEST_SIGNATURE_INVALID"
  fi
  node -e '
    const checkpoint = JSON.parse(process.argv[1]);
    const target = JSON.parse(process.argv[2]);
    const source = JSON.parse(process.argv[3]);
    const current = JSON.parse(process.argv[4]);
    const journal = JSON.parse(process.argv[5]);
    const state = JSON.parse(process.argv[6]);
    const plan = checkpoint.plan;
    const oldState = checkpoint.release_state;
    const legacy = checkpoint.legacy_source === true;
    if (!plan || plan.release_id !== target.release_id || plan.target_version !== target.release_version ||
        plan.source_version !== source.release_version || plan.source_schema !== journal.source_schema ||
        plan.target_schema !== journal.target_schema || journal.target_version !== target.release_version ||
        journal.source_version !== source.release_version ||
        oldState.installed_version !== source.release_version ||
        (legacy ? (oldState.signer_key_id || oldState.manifest_signature || oldState.release_id || oldState.images) :
          (oldState.release_id !== source.release_id || oldState.signer_key_id !== source.signer_key_id || oldState.manifest_signature !== source.signature)) ||
        (!legacy && JSON.stringify(source.images) !== JSON.stringify(checkpoint.images)) ||
        JSON.stringify(oldState.images || checkpoint.images) !== JSON.stringify(checkpoint.images) ||
        JSON.stringify(checkpoint.target_release.verified) !== JSON.stringify(target)) process.exit(2);
    if (plan.source_authentication !== (legacy ? "legacy_digest_pinned" : "signed_manifest")) process.exit(6);
    const rollbackCompatible = ["none", "expand"].includes(target.migration.strategy) &&
      target.rollback.application === true && target.rollback.configuration === true &&
      target.rollback.database_strategy === "preserve_schema" &&
      target.rollback.compatible_previous_apps.includes(source.release_version) &&
      target.compatibility.compatible_previous_apps.includes(source.release_version);
    if (rollbackCompatible !== (plan.rollback_compatible === true)) process.exit(3);
    const stateIsTarget = state.installed_version === target.release_version && state.release_id === target.release_id &&
      state.signer_key_id === target.signer_key_id && state.manifest_signature === target.signature &&
      state.update_checkpoint_id === journal.transaction_id && JSON.stringify(state.images) === JSON.stringify(target.images) &&
      current.signature === target.signature &&
      current.release_id === target.release_id;
    const commitWindow = ["HEALTHCHECKING", "COMMITTED"].includes(journal.state);
    if ((journal.state === "COMMITTED" && !stateIsTarget) || (stateIsTarget && !commitWindow)) process.exit(4);
    if (stateIsTarget) {
      // Crash after release-state promotion but before the COMMITTED journal write.
      if (!commitWindow) process.exit(4);
    } else if (state.installed_version !== source.release_version ||
        (legacy ? (state.signer_key_id || state.manifest_signature || state.release_id || state.images) :
          (state.release_id !== source.release_id || state.signer_key_id !== source.signer_key_id || state.manifest_signature !== source.signature)) ||
        JSON.stringify(state.images || checkpoint.images) !== JSON.stringify(checkpoint.images) ||
        (!legacy && (current.signature !== source.signature || current.release_id !== source.release_id))) process.exit(5);
  ' "$checkpoint_json" "$target_verified" "$source_verified" "$current_verified" "$journal_json" "$(cat "$STATE_FILE")" ||
    rollback_manual_recovery "RELEASE_CHECKPOINT_IDENTITY_MISMATCH"

  source_images_json="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).images))' "$checkpoint_json")" ||
    rollback_manual_recovery "CHECKPOINT_IMAGE_STATE_INVALID"
  UPDATE_SOURCE_IMAGES_JSON="$source_images_json"
  UPDATE_TARGET_IMAGES_JSON="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(process.argv[1]).images))' "$target_verified")"
  UPDATE_RELEASE_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).release_id)' "$target_verified")"
  UPDATE_SIGNER_KEY_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).signer_key_id)' "$target_verified")"
  UPDATE_SOURCE_RELEASE_ID="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).release_id||"")' "$source_verified")"
  UPDATE_BACKUP_SHA256="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).database_backup?.sha256||"")' "$checkpoint_json")"
  validate_current_image_availability "$source_images_json" || rollback_manual_recovery "PREVIOUS_IMAGE_UNAVAILABLE"
  target_migrator="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).images.migrator)' "$target_verified")" ||
    rollback_manual_recovery "TARGET_MIGRATOR_DIGEST_INVALID"
  VERIFIED_IMAGE_MIGRATOR="$target_migrator"
  UPDATE_ROLLBACK_COMPATIBLE="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).plan.rollback_compatible?"1":"0")' "$checkpoint_json")"
  migration_started="$(node -e 'const d=JSON.parse(process.argv[1]);process.stdout.write(d.events.some(e=>e.state==="MIGRATION_STARTED")?"1":"0")' "$journal_json")"

  if [ "$migration_started" = "1" ]; then
    [ "$UPDATE_ROLLBACK_COMPATIBLE" = "1" ] || rollback_manual_recovery "DATABASE_ROLLBACK_NOT_PROVEN"
    node "$UPDATE_TRANSACTION_TOOL" verify-db "$INSTALL_DIR" "$checkpoint_id" >/dev/null 2>&1 ||
      rollback_manual_recovery "DATABASE_BACKUP_UNAVAILABLE_OR_CORRUPTED"
    schema_json="$(run_migrator_with_image "$target_migrator" status --json 2>/dev/null)" ||
      rollback_manual_recovery "CURRENT_DATABASE_SCHEMA_UNAVAILABLE"
    observed_schema="$(node -e 'const d=JSON.parse(process.argv[1]);if(d.state_type!=="TRACKED_INSTALLATION"||d.schema_evidence_valid!==true||!/^[0-9]{4,6}$/.test(d.current_schema||""))process.exit(2);process.stdout.write(d.current_schema)' "$schema_json")" ||
      rollback_manual_recovery "CURRENT_DATABASE_SCHEMA_UNAVAILABLE"
    node -e 'const n=Number(process.argv[1]),a=Number(process.argv[2]),b=Number(process.argv[3]);process.exit(n>=a&&n<=b?0:1)' \
      "$observed_schema" "$UPDATE_SOURCE_SCHEMA" "$UPDATE_TARGET_SCHEMA" || rollback_manual_recovery "DATABASE_SCHEMA_OUTSIDE_SIGNED_ROLLBACK_RANGE"
    UPDATE_SCHEMA_AFTER="$observed_schema"
  else
    UPDATE_SCHEMA_AFTER="$UPDATE_SOURCE_SCHEMA"
  fi

  local backup_required=0
  [ "$journal_state" = "PREFLIGHT_OK" ] || backup_required=1
  if [ "$backup_required" -eq 1 ]; then
    node "$UPDATE_TRANSACTION_TOOL" verify-db "$INSTALL_DIR" "$checkpoint_id" >/dev/null 2>&1 ||
      rollback_manual_recovery "DATABASE_BACKUP_UNAVAILABLE_OR_CORRUPTED"
  fi

  source_mode="$(node -e 'const c=JSON.parse(process.argv[1]).runtime_config;process.stdout.write(c.CLIENTIX_ACME_SECRET_MODE||"external")' "$checkpoint_json")"
  source_path="$(node -e 'const c=JSON.parse(process.argv[1]).runtime_config;process.stdout.write(c.CLIENTIX_CLOUDFLARE_TOKEN_FILE||"")' "$checkpoint_json")"
  local source_challenge
  source_challenge="$(node -e 'const c=JSON.parse(process.argv[1]).runtime_config;process.stdout.write(c.CLIENTIX_ACME_CHALLENGE||"direct")' "$checkpoint_json")"
  if [ "$source_challenge" = "dns" ] && [ "$source_mode" = "external" ]; then
    validate_external_cloudflare_secret_file "$source_path" >/dev/null || rollback_manual_recovery "SOURCE_EXTERNAL_SECRET_UNAVAILABLE_OR_UNSAFE"
  elif [ "$source_challenge" = "dns" ] && [ "$source_mode" = "ephemeral" ]; then
    [ "$CLI_DNS_SECRET_MODE" = "ephemeral" ] || die "CLOUDFLARE_TOKEN_REINJECTION_REQUIRED: passe --cloudflare-token-stdin para restaurar o Caddy efêmero."
    read_runtime_cloudflare_token
  fi

  [ "$CLI_DNS_SECRET_MODE" != "external" ] || die "ROLLBACK_SECRET_OVERRIDE_UNSUPPORTED: o rollback usa somente a referência externa da release anterior."
  if [ "$journal_state" != "ROLLBACK_IN_PROGRESS" ]; then
    write_update_journal ROLLBACK_IN_PROGRESS "OPERATOR_REQUESTED_ROLLBACK" "$UPDATE_SCHEMA_AFTER" ||
      die "UPDATE_JOURNAL_WRITE_FAILED: rollback não pôde ser iniciado no journal."
  fi
  restore_update_checkpoint "$checkpoint_id" "$UPDATE_SCHEMA_AFTER" || rollback_manual_recovery "CONFIGURATION_RESTORE_FAILED"
  validate_ingress_config
  validate_cloudflare_token_source
  compose config --quiet || rollback_manual_recovery "RESTORED_COMPOSE_INVALID"
  run_runtime_db_preflight "$target_migrator"
  compose up -d || rollback_manual_recovery "PREVIOUS_RELEASE_START_FAILED"
  if [ "$source_challenge" = "dns" ] && [ "$source_mode" = "ephemeral" ]; then
    inject_runtime_cloudflare_token "$RUNTIME_CLOUDFLARE_TOKEN"
    unset -v RUNTIME_CLOUDFLARE_TOKEN
  fi
  if [ "$source_challenge" = "dns" ]; then check_health 300; else check_health 45; fi
  write_update_journal ROLLED_BACK "OPERATOR_REQUESTED_ROLLBACK" "$UPDATE_SCHEMA_AFTER" ||
    rollback_manual_recovery "ROLLBACK_JOURNAL_COMMIT_FAILED"
  printf 'ROLLBACK=PASS\nSOURCE_VERSION=%s\nSCHEMA_PRESERVED=%s\n' "$UPDATE_SOURCE_VERSION" "$UPDATE_SCHEMA_AFTER"
  trap - EXIT
  release_update_lock
}

cmd_secret_inject() {
  [ "$#" -eq 1 ] && [ "$1" = "--stdin" ] ||
    die "USO: clientix-installer secret inject --stdin"
  RUNTIME_SECRET_STDIN_REQUIRED=1
  preflight
  load_env
  validate_ingress_config
  validate_cloudflare_token_source
  require_dns_caddy_image_digest
  compose config --quiet || die "INGRESS_COMPOSE_INVALID: configuração do ingress efêmero é inválida."
  compose up -d caddy || die "CADDY_RUNTIME_UNAVAILABLE: não foi possível iniciar o Caddy para reinjeção efêmera."
  inject_cloudflare_token_from_stdin
  log "Segredo DNS-01 injetado somente no tmpfs do Caddy."
}

cmd_ingress_reload() {
  parse_dns_secret_options "$@"
  [ "$CLI_TEST_MODE" -eq 0 ] || die "TEST_MODE_UNSUPPORTED: modo TEST só pode ser usado em install/update/rollback isolado."
  preflight
  load_env
  validate_ingress_config
  validate_cloudflare_token_source
  require_dns_caddy_image_digest
  persist_runtime_dns_secret_mode
  [ -f "$COMPOSE_FILE" ] || die "COMPOSE_FILE_AUSENTE: configuração da instalação não foi encontrada."
  compose config --quiet || die "INGRESS_COMPOSE_INVALID: configuração HTTPS do compose é inválida."
  compose up -d --force-recreate caddy || die "CADDY_RELOAD_FAILED: não foi possível recriar o Caddy com a origem atual do segredo."
  if [ "${CLIENTIX_ACME_CHALLENGE:-direct}" = "dns" ] && [ "$CLIENTIX_ACME_SECRET_MODE" = "ephemeral" ]; then
    inject_cloudflare_token_from_stdin
  fi
  if [ "${CLIENTIX_ACME_CHALLENGE:-direct}" = "dns" ]; then check_health 300; else check_health 45; fi
  remove_legacy_cloudflare_secret_after_ready
  log "Ingress Caddy recriado e validado."
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
  compose ps 2>/dev/null || true
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
    rollback)
      shift
      cmd_rollback "$@"
      ;;
    ingress)
      shift
      [ "${1:-}" = "reload" ] || die "USO: clientix-installer ingress reload [opções de segredo DNS-01]"
      shift
      cmd_ingress_reload "$@"
      ;;
    secret)
      shift
      [ "${1:-}" = "inject" ] || die "USO: clientix-installer secret inject --stdin"
      shift
      cmd_secret_inject "$@"
      ;;
    status)
      cmd_status
      ;;
    help|--help|-h)
      echo "Uso: clientix-installer <install|update|rollback|ingress reload|secret inject|status|help>"
      ;;
    *)
      die "Comando desconhecido: ${1:-}"
      ;;
  esac
fi
