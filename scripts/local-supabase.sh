#!/usr/bin/env bash
set -Eeuo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

LOCAL_STATE_DIR="$ROOT_DIR/.clientix-local"
LOCAL_SUPABASE_DIR="$LOCAL_STATE_DIR"
LOCAL_STACK_ID="$(node -e 'process.stdout.write(require("node:crypto").createHash("sha256").update(process.argv[1]).digest("hex").slice(0, 10))' "$ROOT_DIR")"
LOCAL_PROJECT_ID="clientix-$LOCAL_STACK_ID"

ensure_local_config() {
  local ports_file="$LOCAL_STATE_DIR/supabase-ports"
  mkdir -p "$LOCAL_SUPABASE_DIR/supabase" "$LOCAL_STATE_DIR"
  if [[ ! -s "$ports_file" ]]; then
    node - "$ports_file" <<'NODE'
const fs = require("node:fs");
const net = require("node:net");
const crypto = require("node:crypto");
const target = process.argv[2];
const root = process.cwd();
const id = Number.parseInt(crypto.createHash("sha256").update(root).digest("hex").slice(0, 6), 16);
const start = 54000 + (id % 2500);
const canBind = (port) => new Promise((resolve) => {
  const server = net.createServer();
  server.once("error", () => resolve(false));
  server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
});
(async () => {
  const choose = async (initial, count = 1) => {
    for (let port = initial; port < 65530; port++) {
      const available = await Promise.all(Array.from({ length: count }, (_, index) => canBind(port + index)));
      if (available.every(Boolean)) return port;
    }
    throw new Error("Não há portas locais suficientes.");
  };
(async () => {
  for (let offset = 0; offset < 2500; offset++) {
    const api = start + offset;
    if (api + 3 > 65535) continue;
    const available = await Promise.all([api, api + 1, api + 2, api + 3].map(canBind));
    if (available.every(Boolean)) {
      const app = await choose(3000);
      const vendor = await choose(Math.max(3100, app + 1));
      const controlPlaneDb = await choose(55432);
      fs.writeFileSync(target, `API=${api}\nDB=${api + 1}\nSTUDIO=${api + 2}\nSMTP=${api + 3}\nAPP=${app}\nVENDOR=${vendor}\nCONTROL_PLANE_DB=${controlPlaneDb}\n`, { mode: 0o600 });
      process.exit(0);
    }
  }
  process.stderr.write("Não há quatro portas locais livres para o Supabase.\n");
  process.exit(1);
})().catch(() => process.exit(1));
})().catch(() => process.exit(1));
NODE
  fi
  # Arquivo local simples criado pelo bloco acima; não contém credenciais.
  local api_port db_port studio_port smtp_port app_port vendor_port control_plane_db_port
  api_port="$(awk -F= '$1 == "API" { print $2 }' "$ports_file")"
  db_port="$(awk -F= '$1 == "DB" { print $2 }' "$ports_file")"
  studio_port="$(awk -F= '$1 == "STUDIO" { print $2 }' "$ports_file")"
  smtp_port="$(awk -F= '$1 == "SMTP" { print $2 }' "$ports_file")"
  app_port="$(awk -F= '$1 == "APP" { print $2 }' "$ports_file")"
  vendor_port="$(awk -F= '$1 == "VENDOR" { print $2 }' "$ports_file")"
  control_plane_db_port="$(awk -F= '$1 == "CONTROL_PLANE_DB" { print $2 }' "$ports_file")"
  node - "$ROOT_DIR/supabase/config.toml" "$LOCAL_SUPABASE_DIR/supabase/config.toml" \
    "$LOCAL_PROJECT_ID" "$api_port" "$db_port" "$studio_port" "$smtp_port" "$app_port" "$vendor_port" <<'NODE'
const fs = require("node:fs");
const [source, target, project, api, db, studio, smtp, app, vendor] = process.argv.slice(2);
let config = fs.readFileSync(source, "utf8");
config = config.replace(/^project_id\s*=\s*"[^"]+"/m, `project_id = ${JSON.stringify(project)}`);
for (const [section, port] of [["api", api], ["db", db], ["studio", studio], ["local_smtp", smtp]]) {
  const start = config.indexOf(`[${section}]`);
  if (start < 0) throw new Error(`Seção Supabase ausente: ${section}`);
  const end = config.indexOf("\n[", start + 1);
  const stop = end < 0 ? config.length : end;
  const block = config.slice(start, stop).replace(/^(port\s*=\s*)\d+/m, `$1${port}`);
  config = config.slice(0, start) + block + config.slice(stop);
}
config = config.replace(/api_url\s*=\s*"http:\/\/127\.0\.0\.1:\d+"/, `api_url = ${JSON.stringify(`http://127.0.0.1:${api}`)}`);
config = config.replace(/site_url\s*=\s*"http:\/\/localhost:\d+"/, `site_url = ${JSON.stringify(`http://localhost:${app}`)}`);
config = config.replaceAll("http://localhost:3000", `http://localhost:${app}`);
config = config.replaceAll("http://localhost:3001", `http://localhost:${vendor}`);
fs.writeFileSync(target, config, { mode: 0o600 });
NODE
  if [[ -d "$ROOT_DIR/supabase/templates" ]]; then
    rm -rf "$LOCAL_SUPABASE_DIR/supabase/templates"
    cp -R "$ROOT_DIR/supabase/templates" "$LOCAL_SUPABASE_DIR/supabase/templates"
  fi
}

cli() {
  ensure_local_config
  npm exec --yes --package=supabase@3.1.0 -- supabase "$@" --workdir "$LOCAL_SUPABASE_DIR"
}

json_value() {
  local key="$1"
  node -e 'let s=""; process.stdin.on("data", c => s += c).on("end", () => {
    const v = JSON.parse(s)[process.argv[1]];
    process.stdout.write(v == null ? "" : String(v));
  })' "$key"
}

start_without_legacy_migrations() {
  # O workdir operacional contém apenas config/seed local: migrations
  # históricas nunca são aplicadas automaticamente. O baseline vem depois.
  if ! cli start "$@" >/dev/null; then
    printf 'Supabase CLI 3.1.0 não iniciou o stack local.\n' >&2
    return 1
  fi
}

status_json() { cli status -o json; }

apply_baseline() {
  local db_url
  db_url="$(status_json | json_value DB_URL)"
  [[ -n "$db_url" && "$db_url" != "null" ]] || {
    printf 'Supabase não retornou DB_URL.\n' >&2
    return 1
  }
  docker run --rm --network host postgres:15-alpine \
    psql "$db_url" -q -v ON_ERROR_STOP=1 -c \
    'create extension if not exists "uuid-ossp";
     create extension if not exists pgcrypto;
     create extension if not exists vector;
     create extension if not exists citext;
     create extension if not exists pg_trgm;'
  provision_agent_worker "$db_url"
  MSYS_NO_PATHCONV=1 docker run --rm --network host \
    -v "$ROOT_DIR/supabase/baseline.sql:/tmp/deskcomm-baseline.sql:ro" \
    postgres:15-alpine \
    psql "$db_url" -q -v ON_ERROR_STOP=1 -f /tmp/deskcomm-baseline.sql
}

provision_agent_worker() {
  local db_url="$1" password_file="$LOCAL_STATE_DIR/agent-worker-password" password sql_file worker_url
  umask 077
  if [[ ! -s "$password_file" ]]; then
    openssl rand -hex 32 > "$password_file"
  fi
  chmod 600 "$password_file"
  password="$(tr -d '\r\n' < "$password_file")"
  [[ "$password" =~ ^[0-9a-f]{64}$ ]] || {
    printf 'A credencial local agent_worker está inválida; nenhuma baseline foi aplicada.\n' >&2
    return 1
  }
  sql_file="$(mktemp "$LOCAL_STATE_DIR/agent-worker-provision.XXXXXX.sql")"
  cat > "$sql_file" <<SQL
SELECT format('CREATE ROLE agent_worker LOGIN NOINHERIT BYPASSRLS PASSWORD %L', '$password')
 WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'agent_worker')
\gexec
ALTER ROLE agent_worker WITH LOGIN NOINHERIT BYPASSRLS PASSWORD '$password';
SQL
  chmod 600 "$sql_file"
  if ! MSYS_NO_PATHCONV=1 docker run --rm --network host \
    -v "$sql_file:/tmp/agent-worker-provision.sql:ro" postgres:15-alpine \
    psql "$db_url" -q -v ON_ERROR_STOP=1 -f /tmp/agent-worker-provision.sql >/dev/null 2>&1; then
    rm -f -- "$sql_file"
    printf 'Falha ao provisionar agent_worker; baseline não foi aplicada.\n' >&2
    return 1
  fi
  rm -f -- "$sql_file"
  worker_url="$(printf '%s\n%s' "$db_url" "$password" | node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{const [database,password]=s.split("\n");const u=new URL(database);u.username="agent_worker";u.password=password;process.stdout.write(u.toString())})')"
  printf '%s' "$worker_url" > "$LOCAL_STATE_DIR/agent-worker-db-url"
  chmod 600 "$LOCAL_STATE_DIR/agent-worker-db-url"
}

case "${1:-}" in
  start)
    start_without_legacy_migrations
    apply_baseline
    ;;
  status)
    status_json
    ;;
  apply-baseline)
    apply_baseline
    ;;
  worker-db-url)
    [[ -s "$LOCAL_STATE_DIR/agent-worker-db-url" ]] || {
      printf 'agent_worker ainda não foi provisionado. Execute local:up.\n' >&2
      exit 1
    }
    cat "$LOCAL_STATE_DIR/agent-worker-db-url"
    ;;
  stop)
    cli stop
    ;;
  *)
    printf 'Uso: %s {start|status|apply-baseline|stop}\n' "$0"
    exit 2
    ;;
esac
