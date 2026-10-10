#!/usr/bin/env bash
set -euo pipefail

is_valid_canonical_installation_id() {
  [[ "${1:-}" =~ ^inst_[[:xdigit:]]{8}-[[:xdigit:]]{4}-4[[:xdigit:]]{3}-[89aAbB][[:xdigit:]]{3}-[[:xdigit:]]{12}$ ]]
}

generate_installation_id() {
  local bytes variant_value variant uuid
  bytes="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
  [[ "$bytes" =~ ^[0-9a-f]{32}$ ]] || return 1

  variant_value=$((16#${bytes:16:1}))
  variant="$(printf '%x' $((8 + (variant_value & 3))))"
  uuid="${bytes:0:8}-${bytes:8:4}-4${bytes:13:3}-${variant}${bytes:17:3}-${bytes:20:12}"
  printf 'inst_%s\n' "$uuid"
}

if [[ "${BASH_SOURCE[0]}" == "$0" ]]; then
  generate_installation_id
fi
