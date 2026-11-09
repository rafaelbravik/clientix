#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

ENV_FILE="${LOCAL_ENV_FILE:-.env.local}"
LOCAL_STACK_ID="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 10))' "$ROOT_DIR")"
COMPOSE=(docker compose --project-name "clientix-$LOCAL_STACK_ID" -f docker-compose.local.yml --env-file "$ENV_FILE")

usage() {
  printf 'Uso: %s {up|down|restart|status|logs|supabase-status|reset}\n' "$0"
}

require_env() {
  if [[ ! -s "$ENV_FILE" ]]; then
    printf 'Erro: %s não existe. Execute ./ubuntu-local-installer.sh primeiro.\n' "$ENV_FILE" >&2
    exit 1
  fi
}

ensure_supabase() {
  if ! ./scripts/local-supabase.sh status >/dev/null 2>&1; then
    ./scripts/local-supabase.sh start
  else
    # Retenta a aplicação idempotente se a primeira inicialização do CLI tiver
    # subido o banco, mas parado antes de concluir baseline/ACL.
    ./scripts/local-supabase.sh apply-baseline
  fi
}

ensure_encryption_key() {
  local key db_url
  key="$(awk -F= '$1 == "NUVEMSHOP_OAUTH_ENCRYPTION_KEY" { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE")"
  if [[ -z "$key" ]]; then
    key="$(openssl rand -hex 32)"
    printf '\nNUVEMSHOP_OAUTH_ENCRYPTION_KEY=%s\n' "$key" >> "$ENV_FILE"
  fi
  db_url="$(./scripts/local-supabase.sh status | node -e 'let s=""; process.stdin.on("data", c => s += c).on("end", () => process.stdout.write(JSON.parse(s).DB_URL || ""))')"
  [[ -n "$db_url" ]] || { printf 'Erro: Supabase local não retornou DB_URL.\n' >&2; exit 1; }
  docker run --rm --network host postgres:15-alpine psql "$db_url" -v ON_ERROR_STOP=1 -c \
    "insert into private.app_secrets (name, value) values ('nuvemshop_oauth_key', '$key') on conflict (name) do update set value = excluded.value, updated_at = now();" \
    >/dev/null
}

control_plane_env_value() {
  local key="$1"
  awk -F= -v key="$key" '$1 == key { sub(/^[^=]*=/, ""); print; exit }' "$ENV_FILE"
}

start_control_plane_database() {
  local container_id health attempt
  "${COMPOSE[@]}" up -d control-plane-db
  for attempt in $(seq 1 60); do
    container_id="$("${COMPOSE[@]}" ps -q control-plane-db)"
    health="$(docker inspect -f '{{.State.Health.Status}}' "$container_id" 2>/dev/null || true)"
    if [[ "$health" == "healthy" ]]; then return 0; fi
    sleep 2
  done
  printf 'Control Plane PostgreSQL não ficou healthy; migrations e Vendor não foram iniciados.\n' >&2
  return 1
}

apply_control_plane_migrations() {
  local password pepper port database_url
  password="$(control_plane_env_value CONTROL_PLANE_DB_PASSWORD)"
  pepper="$(control_plane_env_value CONTROL_PLANE_PEPPER)"
  port="$(control_plane_env_value CONTROL_PLANE_DB_PORT)"
  [[ -n "$password" && -n "$pepper" && -n "$port" ]] || {
    printf 'Configuração local do Control Plane incompleta.\n' >&2
    return 1
  }
  database_url="postgres://clientix_vendor:${password}@127.0.0.1:${port}/clientix_control_plane"
  CONTROL_PLANE_DATABASE_URL="$database_url" \
    CONTROL_PLANE_PEPPER="$pepper" \
    CONTROL_PLANE_MIGRATIONS_APPROVED=yes \
    node ./node_modules/tsx/dist/cli.mjs control-plane/scripts/apply-migrations.ts
}

case "${1:-}" in
  up)
    ensure_supabase
    ./scripts/local-env.sh ensure
    require_env
    ensure_encryption_key
    start_control_plane_database
    apply_control_plane_migrations
    "${COMPOSE[@]}" up -d --build
    ;;
  down)
    "${COMPOSE[@]}" down
    ./scripts/local-supabase.sh stop || true
    ;;
  restart)
    require_env
    "${COMPOSE[@]}" restart
    ;;
  status)
    require_env
    ./scripts/local-supabase.sh status
    "${COMPOSE[@]}" ps
    ;;
  logs)
    require_env
    "${COMPOSE[@]}" logs -f --tail=200 "${2:-app}"
    ;;
  supabase-status)
    ./scripts/local-supabase.sh status
    ;;
  reset)
    require_env
    "${COMPOSE[@]}" down
    ./scripts/local-supabase.sh stop
    ./scripts/local-supabase.sh start
    "${COMPOSE[@]}" up -d
    ;;
  *)
    usage
    exit 2
    ;;
esac
