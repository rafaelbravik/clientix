#!/usr/bin/env bash

clientix_valid_public_domain() {
  local domain="${1:-}" tld
  [ -n "$domain" ] && [ "${#domain}" -le 253 ] || return 1
  [[ "$domain" =~ ^[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$ ]] || return 1
  [[ "$domain" =~ [A-Za-z] ]] || return 1
  tld="${domain##*.}"
  [[ "$tld" =~ ^[A-Za-z]{2,63}$ || "$tld" =~ ^xn--[A-Za-z0-9-]{2,59}$ ]] || return 1
  case "${tld,,}" in
    localhost|local|internal|test|invalid|example) return 1 ;;
  esac
}

clientix_valid_acme_email() {
  local email="${1:-}"
  [[ "$email" =~ ^[^@[:space:]]+@([A-Za-z0-9-]+\.)+[A-Za-z]{2,63}$ ]]
}

clientix_valid_acme_config() {
  local challenge="${1:-}" provider="${2:-}"
  case "$challenge:$provider" in
    direct:) return 0 ;;
    dns:cloudflare) return 0 ;;
    *) return 1 ;;
  esac
}

clientix_is_https_origin_for_domain() {
  local origin="${1:-}" domain="${2:-}"
  [ "$origin" = "https://$domain" ]
}

clientix_is_https_public_origin() {
  local origin="${1:-}" host
  [[ "$origin" == https://* ]] || return 1
  host="${origin#https://}"
  [[ "$host" == */ ]] && host="${host%/}"
  [[ "$host" != */* && "$host" != *\?* && "$host" != *#* && "$host" != *@* && "$host" != *:* ]] || return 1
  clientix_valid_public_domain "$host"
}
