#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${LOCAL_ENV_FILE:-.env.local}"
LOCAL_STACK_ID="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 10))' "$ROOT_DIR")"

json_value() {
  local key="$1"
  node -e 'let s=""; process.stdin.on("data", c => s += c).on("end", () => {
    const value = JSON.parse(s)[process.argv[1]];
    process.stdout.write(value == null ? "" : String(value));
  })' "$key"
}

env_value() {
  local key="$1"
  [[ -f "$ENV_FILE" ]] || return 0
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

upsert_env_value() {
  local key="$1" value="$2" tmp value_file
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  value_file="$(mktemp "${ENV_FILE}.value.XXXXXX")"
  printf '%s' "$value" > "$value_file"
  if [[ -f "$ENV_FILE" ]]; then
    awk -v key="$key" -v value_file="$value_file" '
      BEGIN { found = 0; getline value < value_file; close(value_file) }
      index($0, key "=") == 1 { print key "=" value; found = 1; next }
      { print }
      END { if (!found) print key "=" value }
    ' "$ENV_FILE" > "$tmp"
  else
    awk -v key="$key" -v value_file="$value_file" 'BEGIN { getline value < value_file; print key "=" value; close(value_file) }' > "$tmp"
  fi
  rm -f "$value_file"
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

ensure_bootstrap_token() {
  local token_file="$ROOT_DIR/.clientix-bootstrap-token" token stored
  token="$(env_value CLIENTIX_BOOTSTRAP_TOKEN)"
  if [[ -z "$token" && -s "$token_file" ]]; then
    token="$(tr -d '\r\n' < "$token_file")"
  fi
  if [[ -z "$token" ]]; then token="$(openssl rand -hex 32)"; fi
  [[ "${#token}" -ge 32 ]] || {
    printf 'CLIENTIX_BOOTSTRAP_TOKEN inválido: use ao menos 32 caracteres.\n' >&2
    exit 1
  }
  umask 077
  printf '%s\n' "$token" > "$token_file"
  chmod 600 "$token_file"
  upsert_env_value CLIENTIX_BOOTSTRAP_TOKEN "$token"
}

ensure_control_plane_environment() {
  local key_dir="$ROOT_DIR/.clientix-local/control-plane" key_id db_password pepper
  local private_json public_b64 database_url
  mkdir -p "$key_dir"
  chmod 700 "$ROOT_DIR/.clientix-local" "$key_dir"
  if [[ -e "$key_dir/license-private.pem" || -e "$key_dir/license-public.pem" ]]; then
    [[ -s "$key_dir/license-private.pem" && -s "$key_dir/license-public.pem" ]] || {
      printf 'Par de chaves do signer local incompleto; recusando rotação automática.\n' >&2
      return 1
    }
  else
    node - "$key_dir/license-private.pem" "$key_dir/license-public.pem" <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const [privatePath, publicPath] = process.argv.slice(2);
const pair = crypto.generateKeyPairSync("ed25519");
fs.writeFileSync(privatePath, pair.privateKey.export({ type: "pkcs8", format: "pem" }), { mode: 0o600 });
fs.writeFileSync(publicPath, pair.publicKey.export({ type: "spki", format: "pem" }), { mode: 0o600 });
NODE
  fi
  if ! node - "$key_dir/license-private.pem" "$key_dir/license-public.pem" >/dev/null 2>&1 <<'NODE'
const crypto = require("node:crypto");
const fs = require("node:fs");
const [privatePath, publicPath] = process.argv.slice(2);
const privateKey = crypto.createPrivateKey(fs.readFileSync(privatePath, "utf8"));
const configuredPublicKey = crypto.createPublicKey(fs.readFileSync(publicPath, "utf8"));
if (privateKey.asymmetricKeyType !== "ed25519" || configuredPublicKey.asymmetricKeyType !== "ed25519") process.exit(1);
const derived = crypto.createPublicKey(privateKey).export({ type: "spki", format: "der" });
const configured = configuredPublicKey.export({ type: "spki", format: "der" });
if (derived.length !== configured.length || !crypto.timingSafeEqual(derived, configured)) process.exit(1);
NODE
  then
    printf 'Par de chaves do signer local inválido ou divergente; nenhuma chave foi substituída.\n' >&2
    return 1
  fi
  chmod 600 "$key_dir/license-private.pem" "$key_dir/license-public.pem"
  key_id="clientix-certification-test-$LOCAL_STACK_ID"
  db_password="$(env_value CONTROL_PLANE_DB_PASSWORD)"
  [[ -n "$db_password" ]] || db_password="$(openssl rand -hex 32)"
  pepper="$(env_value CONTROL_PLANE_PEPPER)"
  [[ -n "$pepper" ]] || pepper="$(openssl rand -hex 32)"
  private_json="$(node - "$key_id" "$key_dir/license-private.pem" <<'NODE'
const fs = require("node:fs");
const [id, file] = process.argv.slice(2);
process.stdout.write(JSON.stringify({ [id]: fs.readFileSync(file, "utf8") }));
NODE
  )"
  public_b64="$(node - "$key_dir/license-public.pem" <<'NODE'
const fs = require("node:fs");
process.stdout.write(Buffer.from(fs.readFileSync(process.argv[2], "utf8"), "utf8").toString("base64"));
NODE
  )"
  database_url="postgres://clientix_vendor:${db_password}@control-plane-db:5432/clientix_control_plane"
  upsert_env_value CONTROL_PLANE_DB_PASSWORD "$db_password"
  upsert_env_value CONTROL_PLANE_PEPPER "$pepper"
  upsert_env_value CONTROL_PLANE_DATABASE_URL "$database_url"
  upsert_env_value CONTROL_PLANE_ACTIVE_LICENSE_KEY_ID "$key_id"
  upsert_env_value CONTROL_PLANE_LICENSE_SIGNING_KEYS_JSON "$private_json"
  upsert_env_value CLIENTIX_CERTIFICATION_KEY_ID "$key_id"
  upsert_env_value CLIENTIX_CERTIFICATION_PUBLIC_KEY_B64 "$public_b64"
}

ensure_vapid_keys() {
  local public_key private_key keys_json
  public_key="$(env_value VAPID_PUBLIC_KEY)"
  private_key="$(env_value VAPID_PRIVATE_KEY)"
  if [[ -n "$public_key" && -n "$private_key" ]]; then
    return
  fi
  keys_json="$(node -e 'const webpush = require("web-push"); process.stdout.write(JSON.stringify(webpush.generateVAPIDKeys()))')"
  public_key="$(printf '%s' "$keys_json" | node -e 'let s=""; process.stdin.on("data", c => s += c).on("end", () => process.stdout.write(JSON.parse(s).publicKey))')"
  private_key="$(printf '%s' "$keys_json" | node -e 'let s=""; process.stdin.on("data", c => s += c).on("end", () => process.stdout.write(JSON.parse(s).privateKey))')"
  printf '\n# Geradas automaticamente por local-env.sh; mantenha estas chaves para preservar as inscrições.\nVAPID_PUBLIC_KEY=%s\nVAPID_PRIVATE_KEY=%s\n' "$public_key" "$private_key" >> "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  printf 'Chaves VAPID geradas automaticamente em %s\n' "$ENV_FILE"
}

has_local_env() {
  [[ "$(env_value DESKCOMM_ENV_MODE)" == "local" ]] || return 1
  local key
  for key in NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY \
    SUPABASE_DB_URL INTERNAL_SECRET CPF_ENCRYPTION_KEY WAHA_BYO_ENCRYPTION_KEY AI_CRED_AES_KEY \
    WAHA_API_BASE_URL WAHA_API_KEY WAHA_WEBHOOK_BASE_URL UPSTASH_REDIS_REST_URL \
    UPSTASH_REDIS_REST_TOKEN WAHA_API_KEY_SHA512 SRH_TOKEN; do
    [[ -n "$(env_value "$key")" ]] || return 1
  done
}

local_ip() {
  hostname -I 2>/dev/null | awk '{print $1}' || true
}

choose_port() {
  local port="${1:-3000}" docker_ports
  shift || true
  # Docker Desktop may reserve a published host port outside Windows' socket
  # table, so a successful Node bind probe alone is not sufficient there.
  docker_ports="$(docker ps -a --format '{{.Ports}}' 2>/dev/null \
    | grep -oE '[0-9]+(-[0-9]+)?->' \
    | sed 's/->$//' \
    | awk -F- 'NF == 1 { print $1; next } { for (port = $1; port <= $2; port++) print port }' \
    | sort -nu || true)"
  while [[ " $* " == *" $port "* ]] || grep -qxF "$port" <<<"$docker_ports" || ! node -e 'const net=require("node:net");const s=net.createServer();s.once("error",()=>process.exit(1));s.listen(Number(process.argv[1]),"0.0.0.0",()=>s.close(()=>process.exit(0)))' "$port" >/dev/null 2>&1; do
    port=$((port + 1))
  done
  printf '%s' "$port"
}

ensure_waha_port() {
  local existing app_port vendor_port control_plane_db_port waha_port ports_file
  existing="$(env_value WAHA_PORT)"
  [[ -n "$existing" ]] && return
  ports_file="$ROOT_DIR/.clientix-local/supabase-ports"
  app_port="$(awk -F= '$1 == "APP" { print $2 }' "$ports_file")"
  vendor_port="$(awk -F= '$1 == "VENDOR" { print $2 }' "$ports_file")"
  control_plane_db_port="$(awk -F= '$1 == "CONTROL_PLANE_DB" { print $2 }' "$ports_file")"
  [[ -n "$app_port" && -n "$vendor_port" && -n "$control_plane_db_port" ]] || {
    printf 'Erro: o alocador local não retornou as portas necessárias para WAHA.\n' >&2
    exit 1
  }
  waha_port="$(choose_port 3030 "$app_port" "$vendor_port" "$control_plane_db_port")"
  upsert_env_value WAHA_PORT "$waha_port"
}

ensure_worker_host_port() {
  local existing app_port vendor_port control_plane_db_port waha_port worker_host_port ports_file
  existing="$(env_value WORKER_HOST_PORT)"
  [[ -n "$existing" ]] && return
  ports_file="$ROOT_DIR/.clientix-local/supabase-ports"
  app_port="$(awk -F= '$1 == "APP" { print $2 }' "$ports_file")"
  vendor_port="$(awk -F= '$1 == "VENDOR" { print $2 }' "$ports_file")"
  control_plane_db_port="$(awk -F= '$1 == "CONTROL_PLANE_DB" { print $2 }' "$ports_file")"
  waha_port="$(env_value WAHA_PORT)"
  [[ -n "$app_port" && -n "$vendor_port" && -n "$control_plane_db_port" && -n "$waha_port" ]] || {
    printf 'Erro: o alocador local não retornou as portas necessárias para o worker.\n' >&2
    exit 1
  }
  worker_host_port="$(choose_port 8787 "$app_port" "$vendor_port" "$control_plane_db_port" "$waha_port")"
  upsert_env_value WORKER_HOST_PORT "$worker_host_port"
}

ensure_local_installation_identity() {
  local installation_id stored_id identity_file tmp
  identity_file="$ROOT_DIR/.clientix-local/runtime/licensing/installation_id"
  mkdir -p "$(dirname "$identity_file")"
  installation_id="$(env_value INSTALLATION_ID)"
  if [[ -e "$identity_file" ]]; then
    stored_id="$(tr -d '\r\n' < "$identity_file")"
    [[ "$stored_id" =~ ^inst_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] || {
      printf 'Installation ID local persistido inválido; nenhuma identidade foi substituída.\n' >&2
      return 1
    }
    [[ -z "$installation_id" || "$installation_id" == "$stored_id" ]] || {
      printf 'INSTALLATION_ID local diverge do estado persistido; nenhuma identidade foi substituída.\n' >&2
      return 1
    }
    installation_id="$stored_id"
  else
    [[ -n "$installation_id" ]] || installation_id="inst_$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"
    [[ "$installation_id" =~ ^inst_[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89aAbB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$ ]] || {
      printf 'INSTALLATION_ID local inválido; recusando criar estado persistido.\n' >&2
      return 1
    }
    tmp="$(mktemp "${identity_file}.XXXXXX")"
    umask 077
    printf '%s\n' "$installation_id" > "$tmp"
    chmod 600 "$tmp"
    mv "$tmp" "$identity_file"
  fi
  [[ "$(env_value INSTALLATION_ID)" == "$installation_id" ]] || upsert_env_value INSTALLATION_ID "$installation_id"
}

generate() {
  local status vm_ip app_port vendor_port control_plane_db_port waha_port worker_host_port api_url server_api_url app_url db_url admin_db_url anon_key service_role_key ports_file
  status="$(./scripts/local-supabase.sh status)"
  api_url="$(printf '%s' "$status" | json_value API_URL)"
  [[ -n "$api_url" ]] || {
    printf 'Erro: o Supabase local não retornou API_URL.\n' >&2
    exit 1
  }
  anon_key="$(printf '%s' "$status" | json_value ANON_KEY)"
  service_role_key="$(printf '%s' "$status" | json_value SERVICE_ROLE_KEY)"
  admin_db_url="$(printf '%s' "$status" | json_value DB_URL)"
  db_url="$(./scripts/local-supabase.sh worker-db-url)"
  [[ -n "$anon_key" && -n "$service_role_key" && -n "$db_url" && -n "$admin_db_url" ]] || {
    printf 'Erro: o Supabase local não retornou as credenciais necessárias.\n' >&2
    exit 1
  }

  vm_ip="$(local_ip)"
  [[ -n "$vm_ip" ]] || vm_ip="127.0.0.1"
  db_url="${db_url/127.0.0.1/host.docker.internal}"
  admin_db_url="${admin_db_url/127.0.0.1/host.docker.internal}"
  ports_file="$ROOT_DIR/.clientix-local/supabase-ports"
  app_port="$(awk -F= '$1 == "APP" { print $2 }' "$ports_file")"
  vendor_port="$(awk -F= '$1 == "VENDOR" { print $2 }' "$ports_file")"
  control_plane_db_port="$(awk -F= '$1 == "CONTROL_PLANE_DB" { print $2 }' "$ports_file")"
  waha_port="$(choose_port 3030 "$app_port" "$vendor_port" "$control_plane_db_port")"
  worker_host_port="$(choose_port 8787 "$app_port" "$vendor_port" "$control_plane_db_port" "$waha_port")"
  [[ -n "$app_port" && -n "$vendor_port" && -n "$control_plane_db_port" && -n "$waha_port" && -n "$worker_host_port" ]] || {
    printf 'Erro: o alocador local não retornou as portas necessárias.\n' >&2
    exit 1
  }
  api_url="${api_url/127.0.0.1/$vm_ip}"
  server_api_url="${api_url/$vm_ip/host.docker.internal}"
  app_url="http://127.0.0.1:${app_port}"
  admin_url="http://127.0.0.1:${vendor_port}"

  if [[ -f "$ENV_FILE" ]] && [[ "$(env_value DESKCOMM_ENV_MODE)" != "local" ]]; then
    local backup
    backup="${ENV_FILE}.cloud-backup"
    if [[ ! -e "$backup" ]]; then
      cp --preserve=mode "$ENV_FILE" "$backup"
      chmod 600 "$backup"
      printf 'Backup do ambiente anterior: %s\n' "$backup"
    fi
  fi

  # A chave do WAHA nasce ALEATÓRIA e é derivada UMA vez: o heredoc abaixo é
  # sem aspas, então dois `$(openssl rand)` produziriam valores diferentes na
  # chave e no hash, e o app tomaria 401. Sem knob: nenhum terceiro precisa
  # conhecê-la, e um `${WAHA_API_KEY:-...}` herdaria a chave da nuvem de quem
  # tiver a variável exportada no shell.
  local waha_key
  waha_key="$(openssl rand -hex 24)"

  local tmp
  tmp="$(mktemp "${ENV_FILE}.XXXXXX")"
  umask 077
  cat > "$tmp" <<EOF
DESKCOMM_ENV_MODE=local
NODE_ENV=production
CLIENTIX_ALLOW_INSECURE_HTTP=true
NEXT_PUBLIC_SUPABASE_URL=$api_url
NEXT_PUBLIC_SUPABASE_ANON_KEY=$anon_key
SUPABASE_SERVICE_ROLE_KEY=$service_role_key
SUPABASE_DB_URL=$db_url
SUPABASE_DB_ADMIN_URL=$admin_db_url
SUPABASE_SERVER_URL=$server_api_url
CLIENTIX_BOOTSTRAP_TOKEN=

NEXT_PUBLIC_APP_URL=$app_url
NEXT_PUBLIC_ADMIN_URL=$admin_url
CLIENTIX_ADMIN_ORIGIN=$admin_url
WAHA_WEBHOOK_BASE_URL=http://app:3000

INTERNAL_SECRET=$(openssl rand -hex 32)
INTERNAL_CRON_SECRET=$(openssl rand -hex 32)
CPF_ENCRYPTION_KEY=$(openssl rand -base64 32)
WAHA_BYO_ENCRYPTION_KEY=$(openssl rand -base64 32)
AI_CRED_AES_KEY=$(openssl rand -base64 32)
NUVEMSHOP_OAUTH_ENCRYPTION_KEY=$(openssl rand -hex 32)

WAHA_API_BASE_URL=http://waha:3000
WAHA_API_KEY=$waha_key
WAHA_API_KEY_SHA512=$(printf '%s' "$waha_key" | sha512sum | awk '{print $1}')
WAHA_HMAC_SECRET=$(openssl rand -hex 32)
WAHA_WEBHOOK_REQUIRE_SIGNATURE=false
WHATSAPP_RESTART_ALL_SESSIONS=True

UPSTASH_REDIS_REST_URL=http://srh:80
UPSTASH_REDIS_REST_TOKEN=deskcomm-local-redis
SRH_TOKEN=deskcomm-local-redis
LGPD_SIGNING_KEY=$(openssl rand -hex 32)
APP_PORT=$app_port
VENDOR_PORT=$vendor_port
CONTROL_PLANE_DB_PORT=$control_plane_db_port
WAHA_PORT=$waha_port
WORKER_HOST_PORT=$worker_host_port
CLIENTIX_LICENSE_SERVER_URL=http://vendor:3000
SENTRY_DSN=
EOF
  mv "$tmp" "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  ensure_bootstrap_token
  ensure_control_plane_environment
  ensure_local_installation_identity
  printf 'Ambiente local gerado em %s\n' "$ENV_FILE"
  printf 'Aplicação: %s\n' "$app_url"
}

case "${1:-ensure}" in
  ensure)
    if ! has_local_env; then generate; fi
    ensure_bootstrap_token
    ensure_control_plane_environment
    ensure_local_installation_identity
    ensure_vapid_keys
    ensure_waha_port
    ensure_worker_host_port
    ;;
  generate|force)
    generate
    ;;
  *)
    printf 'Uso: %s {ensure|generate}\n' "$0"
    exit 2
    ;;
esac
