#!/usr/bin/env bash
# Exercises the health-state contract consumed by the real updater gate.
set -euo pipefail
unset CLOUDFLARE_API_TOKEN

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
source "$REPO_ROOT/distribution/installer/install.sh"
PASS=0
FAIL=0

compose() {
  [ "${1:-}" = ps ] && [ "${2:-}" = --format ] || return 2
  case "${CLIENTIX_TEST_PS_CASE:-}" in
    healthy)
      printf '%s\n' \
        '{"Service":"app","State":"running","Health":"healthy"}' \
        '{"Service":"worker","State":"running","Health":"healthy"}' \
        '{"Service":"scheduler","State":"running","Health":"healthy"}' \
        '{"Service":"caddy","State":"running"}'
      ;;
    app-unhealthy)
      printf '%s\n' \
        '{"Service":"app","State":"running","Health":"unhealthy"}' \
        '{"Service":"worker","State":"running","Health":"healthy"}' \
        '{"Service":"scheduler","State":"running","Health":"healthy"}' \
        '{"Service":"caddy","State":"running"}'
      ;;
    worker-unhealthy)
      printf '%s\n' \
        '{"Service":"app","State":"running","Health":"healthy"}' \
        '{"Service":"worker","State":"running","Health":"unhealthy"}' \
        '{"Service":"scheduler","State":"running","Health":"healthy"}' \
        '{"Service":"caddy","State":"running"}'
      ;;
    worker-health-missing)
      printf '%s\n' \
        '{"Service":"app","State":"running","Health":"healthy"}' \
        '{"Service":"worker","State":"running"}' \
        '{"Service":"scheduler","State":"running","Health":"healthy"}' \
        '{"Service":"caddy","State":"running"}'
      ;;
    scheduler-unhealthy)
      printf '%s\n' \
        '{"Service":"app","State":"running","Health":"healthy"}' \
        '{"Service":"worker","State":"running","Health":"healthy"}' \
        '{"Service":"scheduler","State":"running","Health":"unhealthy"}' \
        '{"Service":"caddy","State":"running"}'
      ;;
    caddy-unhealthy)
      printf '%s\n' \
        '{"Service":"app","State":"running","Health":"healthy"}' \
        '{"Service":"worker","State":"running","Health":"healthy"}' \
        '{"Service":"scheduler","State":"running","Health":"healthy"}' \
        '{"Service":"caddy","State":"running","Health":"unhealthy"}'
      ;;
    caddy-stopped)
      printf '%s\n' \
        '{"Service":"app","State":"running","Health":"healthy"}' \
        '{"Service":"worker","State":"running","Health":"healthy"}' \
        '{"Service":"scheduler","State":"running","Health":"healthy"}' \
        '{"Service":"caddy","State":"exited"}'
      ;;
    *) return 2 ;;
  esac
}

check_case() {
  local label="$1" expected="$2"
  CLIENTIX_TEST_PS_CASE="$label"
  if check_update_service_states; then
    [ "$expected" = pass ] && PASS=$((PASS + 1)) || FAIL=$((FAIL + 1))
  else
    [ "$expected" = fail ] && PASS=$((PASS + 1)) || FAIL=$((FAIL + 1))
  fi
}

check_case healthy pass
check_case app-unhealthy fail
check_case worker-unhealthy fail
check_case worker-health-missing fail
check_case scheduler-unhealthy fail
check_case caddy-unhealthy fail
check_case caddy-stopped fail

printf 'Updater health gate checks: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
