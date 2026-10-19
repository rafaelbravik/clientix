#!/usr/bin/env bash
# Normaliza URLs libpq sem permitir downgrade remoto por sslmode da URI.
clientix_postgres_host_class() {
  local raw="$1" rest authority host first second third fourth octet
  if [[ ! "$raw" =~ ^postgres(ql)?:// ]]; then
    printf '%s\n' 'PostgreSQL URL inválida; esperado postgres:// ou postgresql://.' >&2
    return 1
  fi
  rest="${raw#*://}"
  authority="${rest%%/*}"
  authority="${authority%%\?*}"
  authority="${authority##*@}"
  if [[ "$authority" == \[* ]]; then host="${authority#\[}"; host="${host%%\]*}"; else host="${authority%%:*}"; fi
  host="${host,,}"
  host="${host%.}"
  case "$host" in localhost|*.localhost|::1|0:0:0:0:0:0:0:1|supabase-db) printf '%s\n' local; return 0 ;; esac
  if [[ "$host" =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]]; then
    IFS=. read -r first second third fourth <<< "$host"
    if (( 10#$first == 127 )); then
      for octet in "$first" "$second" "$third" "$fourth"; do
        if (( 10#$octet > 255 )); then printf '%s\n' remote; return 0; fi
      done
      printf '%s\n' local
      return 0
    fi
  fi
  printf '%s\n' remote
}

clientix_postgres_url_for_libpq() {
  local raw="$1" class base query part key separator mode ca_path
  class="$(clientix_postgres_host_class "$raw")" || return 1
  base="${raw%%\?*}"
  query=''
  if [[ "$raw" == *\?* ]]; then query="${raw#*\?}"; fi
  mode=verify-full
  [[ "$class" == local ]] && mode=disable
  local -a kept=()
  if [[ -n "$query" ]]; then
    local -a parts=()
    IFS='&' read -r -a parts <<< "$query"
    for part in "${parts[@]}"; do
      key="${part%%=*}"
      if [[ "$key" == *%* ]]; then
        printf '%s\n' 'PostgreSQL URL contém parâmetro TLS codificado; normalize os parâmetros TLS da connection string.' >&2
        return 1
      fi
      case "${key,,}" in sslmode|sslrootcert|sslcert|sslkey|sslpassword) continue ;; esac
      kept+=("$part")
    done
  fi
  separator='?'
  if ((${#kept[@]} > 0)); then local IFS='&'; base+="?${kept[*]}"; separator='&'; fi
  base+="${separator}sslmode=${mode}"
  if [[ "$class" == remote && -n "${POSTGRES_SSL_ROOT_CERT:-}" ]]; then
    ca_path="${CLIENTIX_PGSSLROOTCERT_PATH:-/tmp/clientix-postgres-root-ca.pem}"
    base+="&sslrootcert=$ca_path"
  fi
  printf '%s' "$base"
}
