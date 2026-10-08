#!/usr/bin/env bash
# Clientix Commercial Installer & Operational CLI
# Suporta: install, update, adopt, rollback, health, status
set -euo pipefail

INSTALL_DIR="${CLIENTIX_DIR:-/opt/clientix}"
INSTALLER_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
STATE_FILE="$INSTALL_DIR/state/release.json"
ENV_FILE="$INSTALL_DIR/.env"
COMPOSE_FILE="$INSTALL_DIR/compose.yaml"
BACKUP_DIR="$INSTALL_DIR/backups"
MANIFEST_FILE="$INSTALLER_DIR/release-manifest.json"

# Redaction helper
redact() {
  local str="$1"
  printf '%s' "$str" | sed -E 's/(postgres(ql)?:\/\/[^:]+:)[^@]+(@)/\1[REDACTED]\3/g'
}

log() {
  local clean
  clean="$(redact "$*")"
  echo "[clientix-installer] $(date -u +'%Y-%m-%dT%H:%M:%SZ') $clean"
}

log_err() {
  local clean
  clean="$(redact "$*")"
  echo "[clientix-installer:ERROR] $(date -u +'%Y-%m-%dT%H:%M:%SZ') $clean" >&2
}

die() {
  log_err "$*"
  exit 1
}

# 1. Preflight
preflight() {
  log "Executando verificações de pré-vôo (preflight)..."
  
  # Arquitetura
  local arch
  arch="$(uname -m 2>/dev/null || true)"
  case "$arch" in
    x86_64|amd64|aarch64|arm64) ;;
    *) die "ARQUITETURA_NAO_SUPORTADA: $arch. O Clientix suporta amd64 e arm64." ;;
  esac

  # Docker
  command -v docker >/dev/null 2>&1 || die "DOCKER_AUSENTE: Docker não está instalado ou acessível no PATH."
  docker info >/dev/null 2>&1 || die "DOCKER_INATIVO: Daemon do Docker não está rodando."

  # Compose
  docker compose version >/dev/null 2>&1 || die "DOCKER_COMPOSE_AUSENTE: Docker Compose v2 é obrigatório."

  # Espaço em disco (mínimo 2 GB livres no diretório de instalação)
  if [ -d "$INSTALL_DIR" ] || [ -d "$(dirname "$INSTALL_DIR")" ]; then
    local check_path="$INSTALL_DIR"
    [ -d "$check_path" ] || check_path="$(dirname "$INSTALL_DIR")"
    local free_kb
    free_kb="$(df -k "$check_path" 2>/dev/null | tail -1 | awk '{print $4}')"
    if [ -n "$free_kb" ] && [ "$free_kb" -lt 2097152 ]; then
      die "ESPACO_INSUFICIENTE: Menos de 2 GB de espaço livre em disco ($((free_kb / 1024)) MB disponível)."
    fi
  fi

  log "Preflight concluído com sucesso."
}

# 2. Inicialização de Estrutura de Diretórios
init_directories() {
  mkdir -p "$INSTALL_DIR/data" "$INSTALL_DIR/backups" "$INSTALL_DIR/state" "$INSTALL_DIR/licenses" "$INSTALL_DIR/logs"
  chmod 700 "$INSTALL_DIR/state" "$INSTALL_DIR/licenses" || true
}

# 3. Geração ou Preservação de Secrets e installation_id
setup_env() {
  if [ ! -f "$ENV_FILE" ]; then
    log "Criando novo arquivo .env com secrets gerados criptograficamente..."
    local inst_id nextauth enc_key cron_sec app_sec
    inst_id="$(od -x /dev/urandom 2>/dev/null | head -1 | awk '{print $2$3"-"$4"-"$5"-"$6"-"$7$8$9}' || date +%s%N)"
    nextauth="$(openssl rand -hex 32 2>/dev/null || echo "clx_sec_$(date +%s)")"
    enc_key="$(openssl rand -hex 32 2>/dev/null || echo "clx_enc_$(date +%s)")"
    cron_sec="$(openssl rand -hex 24 2>/dev/null || echo "clx_cron_$(date +%s)")"
    app_sec="$(openssl rand -hex 24 2>/dev/null || echo "clx_app_$(date +%s)")"

    sed \
      -e "s/^INSTALLATION_ID=.*/INSTALLATION_ID=${inst_id}/" \
      -e "s/^NEXTAUTH_SECRET=.*/NEXTAUTH_SECRET=${nextauth}/" \
      -e "s/^ENCRYPTION_KEY=.*/ENCRYPTION_KEY=${enc_key}/" \
      -e "s/^INTERNAL_CRON_SECRET=.*/INTERNAL_CRON_SECRET=${cron_sec}/" \
      -e "s/^INTERNAL_API_SECRET=.*/INTERNAL_API_SECRET=${app_sec}/" \
      -e "s/^IMPERSONATE_COOKIE_SECRET=.*/IMPERSONATE_COOKIE_SECRET=${nextauth}/" \
      "$INSTALLER_DIR/.env.example" > "$ENV_FILE"
    chmod 600 "$ENV_FILE"
  else
    log "Preservando arquivo .env e secrets existentes."
    # Fail-closed em caso de corrupção do INSTALLATION_ID em instalação existente
    if ! grep -q "^INSTALLATION_ID=" "$ENV_FILE" || [ -z "$(grep "^INSTALLATION_ID=" "$ENV_FILE" | cut -d= -f2)" ]; then
      die "CORRUPTED_INSTALLATION_ID: INSTALLATION_ID ausente ou vazio no .env de instalação existente. Intervenção manual obrigatória."
    fi
  fi
}

# 4. Carrega Variáveis de Ambiente
load_env() {
  [ -f "$ENV_FILE" ] || die "ENV_FILE_AUSENTE: $ENV_FILE não encontrado."
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
}

# 5. Validação de Evolução de Configuração (Check de Variáveis Obrigatórias)
validate_config_evolution() {
  log "Verificando consistência de variáveis obrigatórias contra .env.example..."
  local example="$INSTALLER_DIR/.env.example"
  if [ -f "$example" ] && [ -f "$ENV_FILE" ]; then
    local missing=()
    while IFS= read -r line || [ -n "$line" ]; do
      case "$line" in
        \#*|"") continue ;;
        *=*)
          local key="${line%%=*}"
          # Se for variável estritamente obrigatória
          case "$key" in
            DATABASE_URL|NEXTAUTH_SECRET|ENCRYPTION_KEY|INTERNAL_CRON_SECRET|INTERNAL_API_SECRET|INSTALLATION_ID)
              if ! grep -q "^${key}=" "$ENV_FILE" || [ -z "$(grep "^${key}=" "$ENV_FILE" | cut -d= -f2-)" ]; then
                missing+=("$key")
              fi
              ;;
          esac
          ;;
      esac
    done < "$example"

    if [ ${#missing[@]} -gt 0 ]; then
      die "MISSING_REQUIRED_CONFIG: Variáveis obrigatórias ausentes no .env: ${missing[*]}"
    fi
  fi
  log "Validação de configuração concluída: OK."
}

# 6. Autenticação Privada de Registro
registry_auth() {
  if [ -n "${REGISTRY_TOKEN:-}" ]; then
    local user="${REGISTRY_USERNAME:-token}"
    log "Autenticando no registro de imagens privado (sem expor credenciais)..."
    printf '%s' "$REGISTRY_TOKEN" | docker login ghcr.io -u "$user" --password-stdin >/dev/null 2>&1 || die "REGISTRY_AUTH_FAILED: Falha na autenticação do GHCR."
    log "Autenticação no registro concluída com sucesso."
  fi
}

registry_logout() {
  if [ -n "${REGISTRY_TOKEN:-}" ]; then
    docker logout ghcr.io >/dev/null 2>&1 || true
  fi
}

# 7. Validação de Manifesto de Release
validate_manifest() {
  [ -f "$MANIFEST_FILE" ] || die "MANIFEST_AUSENTE: release-manifest.json não encontrado."
  local ver target_schema
  ver="$(grep '"release_version":' "$MANIFEST_FILE" | awk -F'"' '{print $4}')"
  target_schema="$(grep '"schema_target":' "$MANIFEST_FILE" | awk -F'"' '{print $4}')"
  [ -n "$ver" ] || die "INVALID_MANIFEST: release_version não definida."
  [ -n "$target_schema" ] || die "INVALID_MANIFEST: schema_target não definido."

  # Valida se todas as 5 imagens canônicas estão declaradas
  for img_key in app worker scheduler voice_agent migrator; do
    if ! grep -q "\"$img_key\":" "$MANIFEST_FILE"; then
      die "INVALID_MANIFEST: Imagem obrigatória '$img_key' ausente no release-manifest.json."
    fi
  done
  log "Manifesto validado: Release $ver (Schema alvo: $target_schema)."
}

# 8. Verificação e Pull de Imagens Target com Validação de Digest
ensure_target_images() {
  log "Verificando disponibilidade e integridade das imagens do release..."
  local ver
  ver="$(grep '"release_version":' "$MANIFEST_FILE" | awk -F'"' '{print $4}')"

  # Mapeamento de chaves e imagens
  local images=("app" "worker" "scheduler" "voice_agent" "migrator")
  
  for img in "${images[@]}"; do
    local repo
    repo="$(grep -A3 "\"$img\":" "$MANIFEST_FILE" | grep '"repository":' | awk -F'"' '{print $4}')"
    local expected_digest
    expected_digest="$(grep -A4 "\"$img\":" "$MANIFEST_FILE" | grep '"digest":' | awk -F'"' '{print $4}')"

    if [ "${USE_LOCAL_IMAGES:-0}" = "1" ]; then
      local local_name="clientix-${img//_/-}:dev"
      [ "$img" = "app" ] && local_name="clientix-app:local-hardened"
      [ "$img" = "worker" ] && local_name="clientix-worker:local-hardened-v2"
      [ "$img" = "scheduler" ] && local_name="clientix-scheduler:local-hardened"
      [ "$img" = "voice_agent" ] && local_name="clientix-voice-agent:local-hardened-v2"
      [ "$img" = "migrator" ] && local_name="clientix-migrator:dev"

      log "Modo local: verificando imagem $local_name..."
      if ! docker image inspect "$local_name" >/dev/null 2>&1; then
        die "TARGET_IMAGE_UNAVAILABLE: Imagem local '$local_name' não encontrada no Docker daemon."
      fi
      continue
    fi

    local full_ref="$repo:$ver"
    if [ -n "$expected_digest" ]; then
      full_ref="$repo@$expected_digest"
    fi

    log "Realizando pull da imagem: $full_ref..."
    if ! docker pull "$full_ref" >/dev/null 2>&1; then
      die "TARGET_IMAGE_UNAVAILABLE: Falha ao obter imagem '$full_ref' do registro."
    fi

    # Verificação de digest se declarado
    if [ -n "$expected_digest" ]; then
      local actual_digest
      actual_digest="$(docker image inspect "$full_ref" --format '{{if .RepoDigests}}{{index .RepoDigests 0}}{{end}}' 2>/dev/null | sed 's/.*@//' || true)"
      if [ -n "$actual_digest" ] && [ "$actual_digest" != "$expected_digest" ]; then
        die "IMAGE_DIGEST_MISMATCH: Digest da imagem $repo diverge do manifesto! Esperado: $expected_digest, Real: $actual_digest"
      fi
    fi
  done

  log "Todas as imagens do release foram validadas com sucesso."
}

# 9. Execução do Standalone Migrator
run_migrator() {
  local cmd="$1"
  shift || true
  local mig_img="${MIGRATOR_IMAGE:-ghcr.io/rafaelbravik/clientix-migrator:1.0.0}"
  log "Executando clientix-migrator: $cmd..."

  if [ "${USE_LOCAL_IMAGES:-0}" = "1" ]; then
    mig_img="clientix-migrator:dev"
  fi

  docker run --rm \
    --network "${DOCKER_NETWORK:-host}" \
    -e DATABASE_URL="$DATABASE_URL" \
    -e BACKUP_ACK="${BACKUP_ACK:-1}" \
    "$mig_img" "$cmd" "$@"
}

# 10. Backup Lógico do Banco de Dados
run_backup() {
  local target_ver="$1"
  local current_ver="${2:-unknown}"
  local ts
  ts="$(date -u +'%Y%m%d_%H%M%S')"
  local bkp_file="$BACKUP_DIR/backup_${current_ver}_to_${target_ver}_${ts}.dump"
  log "Iniciando backup antes de mutação de banco: $bkp_file..."

  docker run --rm \
    --network "${DOCKER_NETWORK:-host}" \
    postgres:17-alpine \
    pg_dump "$DATABASE_URL" -Fc > "$bkp_file" || die "BACKUP_FAILED: Falha ao executar pg_dump do banco."

  if [ ! -s "$bkp_file" ]; then
    die "BACKUP_INVALID: Arquivo de backup está vazio ou não foi gerado."
  fi

  # Valida integridade via pg_restore --list
  docker run --rm \
    -v "$BACKUP_DIR:/backups:ro" \
    postgres:17-alpine \
    pg_restore --list "/backups/$(basename "$bkp_file")" >/dev/null 2>&1 || die "BACKUP_CORRUPTED: pg_restore falhou ao ler o catálogo do backup."

  # Calcula checksum sha256 do arquivo de backup
  local bkp_sha256
  bkp_sha256="$(sha256sum "$bkp_file" 2>/dev/null | awk '{print $1}' || true)"
  log "Backup lógico concluído e validado com sucesso (SHA-256: $bkp_sha256)."

  # Rotação segura de backups (mantém os últimos N)
  local keep="${KEEP_LAST_N_BACKUPS:-5}"
  local count
  count="$(find "$BACKUP_DIR" -name "*.dump" | wc -l)"
  if [ "$count" -gt "$keep" ]; then
    log "Aplicando retenção de backups (mantendo os últimos $keep)..."
    find "$BACKUP_DIR" -name "*.dump" -type f | sort | head -n -"$keep" | xargs rm -f || true
  fi

  echo "$bkp_file"
}

# 11. Verificação de Saúde (Health Check com HTTP Probe)
check_health() {
  local timeout="${1:-45}"
  log "Aguardando boot e saúde da aplicação (HTTP probe / timeout: ${timeout}s)..."
  local elapsed=0
  local port="${PORT:-3000}"

  while [ $elapsed -lt $timeout ]; do
    # Probe HTTP real (200 OK ou redirect esperado)
    local http_code
    http_code="$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:${port}/login" 2>/dev/null || true)"
    if [ "$http_code" = "200" ] || [ "$http_code" = "307" ] || [ "$http_code" = "308" ]; then
      log "Aplicação Clientix respondendo com sucesso (HTTP $http_code)."
      
      # Verifica se contêineres vitais continuam ativos sem loop de restart
      local stopped
      stopped="$(docker compose -f "$COMPOSE_FILE" ps --status exited -q 2>/dev/null || true)"
      if [ -n "$stopped" ]; then
        die "CONTAINER_CRASH_DETECTED: Um ou mais serviços falharam no boot."
      fi
      return 0
    fi
    sleep 3
    elapsed=$((elapsed + 3))
  done

  die "HEALTH_CHECK_FAILED: Aplicação não respondeu HTTP na porta $port após ${timeout}s."
}

# 12. Comando: install
cmd_install() {
  preflight
  init_directories
  setup_env
  load_env
  validate_config_evolution
  validate_manifest

  cp "$INSTALLER_DIR/compose.yaml" "$COMPOSE_FILE"

  if [ -f "$STATE_FILE" ]; then
    log "ALREADY_INSTALLED: Instalação existente detectada no estado. Para atualizar, use 'clientix-installer update'."
    exit 0
  fi

  registry_auth
  ensure_target_images
  registry_logout

  log "Verificando estado do banco de dados..."
  local status_json
  status_json="$(run_migrator status --json)"
  local state_type
  state_type="$(printf '%s' "$status_json" | grep '"state_type":' | awk -F'"' '{print $4}')"

  log "Estado do banco detectado: $state_type"
  if [ "$state_type" = "FRESH_DATABASE" ]; then
    run_migrator install
  elif [ "$state_type" = "EXISTING_UNTRACKED_INSTALLATION" ]; then
    if [ "${ALLOW_ADOPT:-0}" = "1" ] || [ "${1:-}" = "--adopt" ]; then
      log "Adotando instalação existente expressamente permitida..."
      run_migrator adopt
    else
      die "EXISTING_DATABASE_REQUIRES_CONFIRMATION: Banco existente não rastreado. Execute com '--adopt' ou defina ALLOW_ADOPT=1."
    fi
  else
    log "Banco já rastreado. Executando check de sanidade..."
    run_migrator check
  fi

  log "Subindo serviços Clientix..."
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d

  check_health 45

  local ver="1.0.0"
  ver="$(grep '"release_version":' "$MANIFEST_FILE" | awk -F'"' '{print $4}')"
  local schema_ver
  schema_ver="$(grep '"schema_target":' "$MANIFEST_FILE" | awk -F'"' '{print $4}')"

  cat <<EOF > "$STATE_FILE.tmp"
{
  "installed_version": "$ver",
  "previous_version": null,
  "schema_version": "$schema_ver",
  "installation_id": "$INSTALLATION_ID",
  "installed_at": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "last_successful_update": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')"
}
EOF
  mv "$STATE_FILE.tmp" "$STATE_FILE"
  chmod 600 "$STATE_FILE"

  log "INSTALACAO CONCLUIDA COM SUCESSO! Versao: $ver (ID: $INSTALLATION_ID)"
}

# 13. Comando: update
cmd_update() {
  preflight
  load_env
  validate_config_evolution
  validate_manifest

  [ -f "$STATE_FILE" ] || die "ESTADO_NAO_ENCONTRADO: Nenhuma instalação anterior encontrada para atualizar."
  local current_ver
  current_ver="$(grep '"installed_version":' "$STATE_FILE" | awk -F'"' '{print $4}')"
  local target_ver
  target_ver="$(grep '"release_version":' "$MANIFEST_FILE" | awk -F'"' '{print $4}')"
  local schema_ver
  schema_ver="$(grep '"schema_target":' "$MANIFEST_FILE" | awk -F'"' '{print $4}')"

  log "Iniciando processo de atualização de $current_ver para $target_ver..."

  # Autenticação e download prévio de TODAS as imagens antes de qualquer mutação
  registry_auth
  ensure_target_images
  registry_logout

  # Backup obrigatório pré-migration
  local bkp_path
  bkp_path="$(run_backup "$target_ver" "$current_ver")"
  local bkp_sha256
  bkp_sha256="$(sha256sum "$bkp_path" 2>/dev/null | awk '{print $1}' || echo "uncalculated")"

  # Executa migrações incrementais
  run_migrator update --backup-ack

  # Atualiza compose e reinicia serviços
  cp "$INSTALLER_DIR/compose.yaml" "$COMPOSE_FILE"
  docker compose -f "$COMPOSE_FILE" --env-file "$ENV_FILE" up -d

  # Valida saúde
  check_health 45

  # Promove estado atômico
  cat <<EOF > "$STATE_FILE.tmp"
{
  "installed_version": "$target_ver",
  "previous_version": "$current_ver",
  "schema_version": "$schema_ver",
  "installation_id": "$INSTALLATION_ID",
  "last_successful_update": "$(date -u +'%Y-%m-%dT%H:%M:%SZ')",
  "last_backup": "$bkp_path",
  "backup_sha256": "$bkp_sha256"
}
EOF
  mv "$STATE_FILE.tmp" "$STATE_FILE"
  chmod 600 "$STATE_FILE"

  log "ATUALIZACAO CONCLUIDA COM SUCESSO para $target_ver!"
}

# 14. Comando: status
cmd_status() {
  load_env
  log "Inspecionando instalação Clientix em $INSTALL_DIR..."
  if [ -f "$STATE_FILE" ]; then
    echo "--- ESTADO DA VERSÃO ---"
    cat "$STATE_FILE"
    echo ""
  else
    log "Nenhum arquivo de estado encontrado em $STATE_FILE."
  fi

  local license_path="$INSTALL_DIR/licenses/license.json"
  if [ -f "$license_path" ]; then
    echo "--- LICENÇA COMERCIAL DETECTADA ---"
    local lic_id cust_name exp_at lic_type
    lic_id="$(grep '"license_id":' "$license_path" 2>/dev/null | awk -F'"' '{print $4}' || echo "desconhecido")"
    cust_name="$(grep '"name":' "$license_path" 2>/dev/null | awk -F'"' '{print $4}' || echo "desconhecido")"
    lic_type="$(grep '"license_type":' "$license_path" 2>/dev/null | awk -F'"' '{print $4}' || echo "desconhecido")"
    exp_at="$(grep '"expires_at":' "$license_path" 2>/dev/null | awk -F'"' '{print $4}' || echo "desconhecido")"
    echo "  ID da Licença: $lic_id"
    echo "  Cliente: $cust_name"
    echo "  Tipo: $lic_type"
    echo "  Expiração: $exp_at"
    echo ""
  else
    log "Arquivo de licença não encontrado em $license_path (Modo não licenciado / restrito)."
  fi

  echo "--- ESTADO DOS SERVIÇOS DOCKER ---"
  docker compose -f "$COMPOSE_FILE" ps 2>/dev/null || true
}

# Main CLI Dispatcher
case "${1:-help}" in
  install)
    shift
    cmd_install "$@"
    ;;
  update)
    shift
    cmd_update "$@"
    ;;
  status)
    cmd_status
    ;;
  help|--help|-h)
    echo "Uso: clientix-installer <install|update|status|help>"
    exit 0
    ;;
  *)
    die "Comando desconhecido: ${1:-}"
    ;;
esac
