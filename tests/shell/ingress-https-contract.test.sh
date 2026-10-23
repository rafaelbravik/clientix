#!/usr/bin/env bash
set -euo pipefail

RAIZ="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
source "$RAIZ/distribution/installer/ingress-contract.sh"

pass() { printf '  ✓ %s\n' "$1"; }
fail() { printf '  ✗ %s\n' "$1" >&2; exit 1; }

clientix_valid_public_domain "crm.cliente.com.br" || fail "hostname público válido recusado"
pass "aceita hostname público completo"

clientix_valid_acme_config direct "" || fail "modo ACME direto recusado"
clientix_valid_acme_config dns cloudflare || fail "modo Cloudflare DNS-01 recusado"
for mode in "direct:cloudflare" "dns:" "dns:route53" "unknown:"; do
  challenge="${mode%%:*}"
  provider="${mode#*:}"
  if clientix_valid_acme_config "$challenge" "$provider"; then
    fail "modo/provedor ACME ambíguo aceito: $mode"
  fi
done
pass "ACME exige seleção explícita de modo e limita DNS-01 ao provedor Cloudflare"

for invalid in "" "http://crm.cliente.com" "crm.cliente.com:443" "crm..cliente.com" "localhost" "crm.local" "crm.internal" "crm.test" "crm.invalid" "crm.example" "-crm.cliente.com" "crm-.cliente.com"; do
  if clientix_valid_public_domain "$invalid"; then
    fail "hostname inseguro ou malformado aceito: $invalid"
  fi
done
pass "recusa esquema, porta, rótulos inválidos e hostnames reservados"

clientix_valid_acme_email "ops@cliente.com.br" || fail "e-mail ACME válido recusado"
if clientix_valid_acme_email "ops cliente" || clientix_valid_acme_email "ops@localhost"; then
  fail "e-mail ACME inválido aceito"
fi
pass "valida o e-mail ACME"

clientix_is_https_origin_for_domain "https://crm.cliente.com.br" "crm.cliente.com.br" || fail "origem canônica recusada"
for origin in "http://crm.cliente.com.br" "https://outro.cliente.com.br" "https://crm.cliente.com.br/" "https://crm.cliente.com.br:8443"; do
  if clientix_is_https_origin_for_domain "$origin" "crm.cliente.com.br"; then
    fail "origem não canônica aceita: $origin"
  fi
done
pass "exige uma única origem HTTPS canônica sem porta ou caminho"

clientix_is_https_public_origin "https://hooks.cliente-webhooks.net" || fail "origem HTTPS pública dedicada ao webhook Meta recusada"
clientix_is_https_public_origin "https://hooks.cliente-webhooks.net/" || fail "origem HTTPS com barra final recusada"
for origin in "http://hooks.cliente-webhooks.net" "https://hooks.cliente-webhooks.net/path" "https://user@hooks.cliente-webhooks.net" "https://hooks.cliente-webhooks.net:8443" "https://hooks.internal"; do
  if clientix_is_https_public_origin "$origin"; then
    fail "origem insegura ou malformada para webhook Meta aceita: $origin"
  fi
done
pass "permite origem HTTPS pública separada para Meta e recusa HTTP, host interno e componentes de URL"

compose="$(cat "$RAIZ/distribution/installer/compose.yaml")"
app="$(sed -n '/^  app:/,/^  worker:/p' "$RAIZ/distribution/installer/compose.yaml")"
caddy="$(sed -n '/^  caddy:/,/^networks:/p' "$RAIZ/distribution/installer/compose.yaml")"
[[ "$app" != *$'\n    ports:'* ]] || fail "app continua publicado diretamente no host"
[[ "$app" == *'CLIENTIX_INGRESS_MODE: "production"'* ]] || fail "app não fixa ingress de produção"
[[ "$caddy" == *'"80:80"'* && "$caddy" == *'"443:443"'* ]] || fail "Caddy não publica 80/443"
[[ "$caddy" == *"caddy-data:/data"* && "$caddy" == *"caddy-config:/config"* ]] || fail "estado ACME não persiste"
[[ "$compose" != *'"${PORT:-3000}:3000"'* ]] || fail "porta interna do app continua pública"
pass "Compose comercial publica só o ingress e persiste estado ACME"

caddyfile="$(cat "$RAIZ/distribution/installer/Caddyfile")"
dns_caddyfile="$(cat "$RAIZ/distribution/installer/Caddyfile.dns-cloudflare")"
dns_compose="$(cat "$RAIZ/distribution/installer/compose.dns-cloudflare.yaml")"
dns_ephemeral_compose="$(cat "$RAIZ/distribution/installer/compose.dns-cloudflare-ephemeral.yaml")"
[[ "$caddyfile" == *"protocols tls1.2 tls1.3"* ]] || fail "TLS 1.2/1.3 não está configurado"
[[ "$caddyfile" == *'Strict-Transport-Security "max-age=31536000"'* ]] || fail "HSTS não está configurado"
[[ "$caddyfile" == *"reverse_proxy app:3000"* ]] || fail "proxy não aponta ao app interno"
[[ "$dns_caddyfile" == *"dns cloudflare {file./run/secrets/cloudflare_api_token}"* ]] || fail "DNS-01 não lê o token por arquivo de runtime"
[[ "$dns_caddyfile" == *"disable_http_challenge"* && "$dns_caddyfile" == *"disable_tlsalpn_challenge"* ]] || fail "DNS-01 pode cair para desafio direto"
[[ "$dns_compose" == *'source: ${CLIENTIX_CLOUDFLARE_TOKEN_FILE:?DNS-01 external secret path is required}'* ]] || fail "DNS-01 não usa caminho externo configurado"
[[ "$dns_compose" == *"read_only: true"* && "$dns_compose" == *"create_host_path: false"* ]] || fail "arquivo externo não é montado read-only fail-closed"
[[ "$dns_compose" != *"state/secrets/cloudflare-api-token"* ]] || fail "Compose ainda aponta para segredo persistido no install dir"
[[ "$dns_ephemeral_compose" == *"/run/secrets:mode=0700"* ]] || fail "modo efêmero não usa tmpfs privado"
[[ "$dns_ephemeral_compose" == *"clientix-caddy-ephemeral-entrypoint"* ]] || fail "modo efêmero não aguarda a reinjeção do operador"
[[ "$dns_compose" == *'CADDY_IMAGE:?a signed release manifest'* ]] || fail "DNS-01 não exige imagem Caddy assinada"
pass "Caddy exige TLS moderno, HSTS e app na rede privada"

installer="$(cat "$RAIZ/distribution/installer/install.sh")"
[[ "$installer" == *"validate_ingress_config"* && "$installer" == *"HTTPS_INGRESS_NOT_READY"* ]] || fail "instalador não valida ingress e prontidão HTTPS"
[[ "$installer" == *"INGRESS_PORT_IN_USE"* ]] || fail "instalador não preflighta portas públicas"
[[ "$installer" == *"clientix_is_https_public_origin \"\$META_WEBHOOK_BASE_URL\""* ]] || fail "instalador não valida a origem Meta HTTPS"
[[ "$installer" == *"CLOUDFLARE_EXTERNAL_SECRET_INVALID"* && "$installer" == *"CLOUDFLARE_EPHEMERAL_STDIN_REQUIRED"* ]] || fail "DNS-01 não falha fechado sem uma origem de segredo válida"
[[ "$installer" == *"require_dns_caddy_image_digest"* ]] || fail "operações manuais DNS-01 não exigem digest de Caddy"
[[ "$installer" == *"CLOUDFLARE_TOKEN_ENV_FORBIDDEN"* ]] || fail "instalador não rejeita token em .env ou no ambiente"
[[ "$installer" == *"mode"*400* && "$installer" == *"mode"*600* ]] || fail "arquivo externo não exige permissões restritas"
[[ "$installer" == *"realpath -e"* && "$installer" == *"realpath -m"* ]] || fail "arquivo externo não é validado como caminho canônico fora do install dir"
[[ "$installer" == *"compose exec -T caddy"* && "$installer" == *"/run/secrets/cloudflare_api_token"* ]] || fail "modo efêmero não injeta por stdin no tmpfs do Caddy"
[[ "$installer" == *"--cloudflare-token-file"* && "$installer" == *"--cloudflare-token-stdin"* ]] || fail "CLI não oferece os dois modos explícitos"
[[ "$installer" == *"clientix-installer secret inject --stdin"* ]] || fail "modo efêmero não documenta reinjeção após restart"
[[ "$installer" == *"validate_dns_ingress_release"* && "$installer" == *"VERIFIED_IMAGE_CADDY"* ]] || fail "DNS-01 não exige Caddy do manifesto"
pass "instalação/atualização falham antes de aplicar migration sem ingress válido"

traefik="$(cat "$RAIZ/docker-compose.traefik.yml")"
[[ "$traefik" == *'traefik.tls.options.deskcomm-tls.minVersion: "VersionTLS12"'* ]] || fail "Traefik não fixa TLS 1.2 como mínimo"
[[ "$traefik" == *'traefik.tls.options.deskcomm-tls.maxVersion: "VersionTLS13"'* ]] || fail "Traefik não permite/fixa o teto TLS 1.3"
[[ "$traefik" == *'headers.stsSeconds: "31536000"'* ]] || fail "Traefik não envia HSTS na rota HTTPS"
pass "Traefik usa TLS 1.2/1.3 e HSTS na rota HTTPS"
