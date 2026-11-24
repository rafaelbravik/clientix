#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"
source hostgator-setup-kit/_common.sh

tmp="$(mktemp -d)"
log="$tmp/docker.log"
mkdir -m 755 "$tmp/.docker"
printf '{}\n' > "$tmp/.docker/config.json"
chmod 644 "$tmp/.docker/config.json"
HOME="$tmp"
export HOME
trap 'rm -rf "$tmp"' EXIT

docker() {
  if [ "${GHCR_DOCKER_MODE:-ok}" = "ok" ]; then
    echo "$*" >> "$log"
    return 0
  fi
  echo 'denied: requested access to the resource is denied' >&2
  return 1
}

IMG_NS="ghcr.io/exemplo"
status="$(ghcr_status clientix-app 1.2.3)"
[ "$status" = "200" ]
[ "$(cat "$log")" = "manifest inspect ghcr.io/exemplo/clientix-app:1.2.3" ]

GHCR_DOCKER_MODE=denied
export GHCR_DOCKER_MODE
[ "$(ghcr_status clientix-app stable)" = "403" ]
if output="$(garantir_acesso_ghcr 1 2>&1)"; then
  echo "❌ modo --yes não recusou GHCR sem credenciais"
  exit 1
fi
case "$output" in
  *"docker login ghcr.io --username SEU_USUARIO"*) ;;
  *) echo "❌ instrução de login não apareceu"; exit 1 ;;
esac

grep -Fq 'read -r -s -p' hostgator-setup-kit/_common.sh
grep -Fq -- '--password-stdin' hostgator-setup-kit/_common.sh
[ "$(stat -c '%a' "$HOME/.docker")" = "700" ]
[ "$(stat -c '%a' "$HOME/.docker/config.json")" = "600" ]
grep -Fq 'chmod 700 "$docker_config_dir"' hostgator-setup-kit/_common.sh
grep -Fq 'chmod 600 "$DOCKER_CONFIG/config.json"' hostgator-setup-kit/_common.sh

echo "✅ autenticação privada do GHCR validada sem rede nem daemon"
