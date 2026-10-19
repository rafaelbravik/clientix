#!/usr/bin/env bash
# Regra única do kit para clientes libpq: plaintext só em loopback ou no
# serviço supabase-db da bridge privada single-server. Todo outro host valida
# certificado e hostname (verify-full), inclusive IPs RFC1918.

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
  if [[ "$authority" == \[* ]]; then
    host="${authority#\[}"
    host="${host%%\]*}"
  else
    host="${authority%%:*}"
  fi
  host="${host,,}"
  host="${host%.}"
  case "$host" in
    localhost|*.localhost|::1|0:0:0:0:0:0:0:1|supabase-db) printf '%s\n' local; return 0 ;;
  esac
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
  local raw="$1" class rest authority host base query part key value separator mode ca_path
  class="$(clientix_postgres_host_class "$raw")" || return 1
  rest="${raw#*://}"
  base="${raw%%\?*}"
  query=''
  if [[ "$raw" == *\?* ]]; then query="${raw#*\?}"; fi
  mode=verify-full
  [[ "$class" == local ]] && mode=disable
  local -a kept=()
  if [[ -n "$query" ]]; then
    IFS='&' read -r -a parts <<< "$query"
    for part in "${parts[@]}"; do
      key="${part%%=*}"
      if [[ "$key" == *%* ]]; then
        printf '%s\n' 'PostgreSQL URL contém parâmetro TLS codificado; normalize os parâmetros TLS da connection string.' >&2
        return 1
      fi
      case "${key,,}" in
        sslmode|sslrootcert|sslcert|sslkey|sslpassword) continue ;;
      esac
      kept+=("$part")
    done
  fi
  separator='?'
  if ((${#kept[@]} > 0)); then
    local IFS='&'
    base+="?${kept[*]}"
    separator='&'
  fi
  base+="${separator}sslmode=${mode}"
  if [[ "$class" == remote && -n "${POSTGRES_SSL_ROOT_CERT:-}" ]]; then
    ca_path="${CLIENTIX_PGSSLROOTCERT_PATH:-/tmp/clientix-postgres-root-ca.pem}"
    base+="&sslrootcert=$ca_path"
  fi
  printf '%s' "$base"
}

clientix_prepare_postgres_ca() {
  CLIENTIX_PG_CA_HOST_FILE=''
  if [[ -z "${POSTGRES_SSL_ROOT_CERT:-}" ]]; then return 0; fi
  local file
  umask 077
  file="$(mktemp "${TMPDIR:-/tmp}/clientix-postgres-ca.XXXXXX")" || return 1
  if ! printf '%s' "$POSTGRES_SSL_ROOT_CERT" | base64 -d > "$file" 2>/dev/null; then
    rm -f -- "$file"
    printf '%s\n' 'POSTGRES_SSL_ROOT_CERT deve ser PEM em base64 válido.' >&2
    return 1
  fi
  chmod 600 "$file" || { rm -f -- "$file"; return 1; }
  CLIENTIX_PG_CA_HOST_FILE="$file"
}

clientix_cleanup_postgres_ca() {
  if [[ -n "${CLIENTIX_PG_CA_HOST_FILE:-}" ]]; then
    rm -f -- "$CLIENTIX_PG_CA_HOST_FILE"
    CLIENTIX_PG_CA_HOST_FILE=''
  fi
}
