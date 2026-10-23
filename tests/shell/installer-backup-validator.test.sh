#!/usr/bin/env bash
# Verifies that the production backup validator can read a root-only checkpoint
# through a read-only mount without widening the host backup permissions.
set -euo pipefail
unset CLOUDFLARE_API_TOKEN

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d /tmp/clientix-backup-validator-test.XXXXXX)"
if [ -z "$WORK" ] || [ ! -d "$WORK" ] || [ "$WORK" = / ] || [[ "$WORK" != /tmp/clientix-backup-validator-test.* ]]; then
  echo "aborted: unsafe backup validator test sandbox" >&2
  exit 1
fi
trap 'case "$WORK" in /tmp/clientix-backup-validator-test.*) rm -rf -- "$WORK";; *) exit 1;; esac' EXIT

export CLIENTIX_DIR="$WORK/install"
mkdir -p "$CLIENTIX_DIR/backups"
source "$REPO_ROOT/distribution/installer/install.sh"

BACKUP_DIR="$CLIENTIX_DIR/backups"
MIGRATOR_IMAGE="localhost:5000/clientix-migrator@sha256:$(printf 'a%.0s' {1..64})"
SUPABASE_DB_ADMIN_URL="postgresql://admin:synthetic-only@localhost:5432/clientix"
KEEP_LAST_N_BACKUPS=2
TRACE_FILE="$WORK/docker-args.log"

docker() {
  if [ "${1:-}" = image ] && [ "${2:-}" = inspect ]; then
    return 0
  fi
  if [ "${1:-}" = run ]; then
    local args=" $* "
    [[ "$args" == *" --user 0:0 "* ]] || return 1
    [[ "$args" == *" --entrypoint pg_restore "* ]] || return 1
    [[ "$args" == *"$BACKUP_DIR:/backups:ro"* ]] || return 1
    printf '%s\n' "$args" >> "$TRACE_FILE"
    return 0
  fi
  return 1
}

run_docker_with_database() {
  printf 'synthetic-postgres-dump'
}

backup_path="$(run_backup 1.70.1 1.70.0)"
test -s "$backup_path"
test "$(stat -c '%a' "$backup_path")" = 600
grep -q -- '--user 0:0' "$TRACE_FILE"
grep -q -- ':/backups:ro' "$TRACE_FILE"
printf 'Backup validator checks: 4/4 PASS\n'
