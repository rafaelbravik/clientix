#!/bin/sh
set -eu

clientix_wait_for_dns_secret() {
  secret_file="${1:-/run/secrets/cloudflare_api_token}"
  printf '%s\n' '[clientix-caddy] aguardando reinjeção do segredo DNS-01 em tmpfs' >&2
  while [ ! -f "$secret_file" ] || [ ! -s "$secret_file" ] || [ -L "$secret_file" ]; do
    sleep 1
  done
}

if [ "${0##*/}" = "clientix-caddy-ephemeral-entrypoint" ]; then
  clientix_wait_for_dns_secret "${1:-/run/secrets/cloudflare_api_token}"
  exec /usr/bin/caddy run --config /etc/caddy/Caddyfile --adapter caddyfile
fi
