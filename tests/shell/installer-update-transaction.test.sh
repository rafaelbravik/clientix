#!/usr/bin/env bash
# Real install.sh update/rollback flow with signed TEST manifests and deterministic
# Docker/database adapters. No real Docker service, registry, DB, or secret is used.
set -euo pipefail
unset CLOUDFLARE_API_TOKEN
REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
WORK="$(mktemp -d /tmp/clientix-updater-test-lab.XXXXXX)"
if [ -z "$WORK" ] || [ ! -d "$WORK" ] || [ "$WORK" = / ] || [[ "$WORK" != /tmp/clientix-updater-test-lab.* ]]; then
  echo "aborted: unsafe updater test sandbox" >&2; exit 1
fi
trap 'case "$WORK" in /tmp/clientix-updater-test-lab.*) rm -rf -- "$WORK";; *) exit 1;; esac' EXIT

node - "$WORK" "$REPO_ROOT/distribution/installer/VERSION" <<'NODE'
const c=require("node:crypto"),fs=require("node:fs"),p=require("node:path");
const [root,versionFile]=process.argv.slice(2),version=fs.readFileSync(versionFile,"utf8").trim();
const {publicKey,privateKey}=c.generateKeyPairSync("ed25519"),keyId="clientix-test-release-fixture";
fs.writeFileSync(p.join(root,"test-private.pem"),privateKey.export({type:"pkcs8",format:"pem"}),{mode:0o600});
fs.writeFileSync(p.join(root,"test-public.pem"),publicKey.export({type:"spki",format:"pem"}),{mode:0o600});
function canon(v){if(v===null)return"null";if(typeof v==="boolean")return v?"true":"false";if(typeof v==="number")return JSON.stringify(Object.is(v,-0)?0:v);if(typeof v==="string")return JSON.stringify(v);if(Array.isArray(v))return`[${v.map(canon).join(",")}]`;return`{${Object.keys(v).sort().map(k=>`${JSON.stringify(k)}:${canon(v[k])}`).join(",")}}`;}
function images(ch){const out={};for(const k of ["app","worker","scheduler","voice_agent","migrator","caddy"]){const n=k.replaceAll("_","-");out[k]={repository:`localhost:5000/clientix-${n}`,tag:`test-${ch}`,digest:`sha256:${ch.repeat(64)}`};}return out;}
function make(file,id,ver,schema,ch,previous=[],strategy="none",ids=[],databaseStrategy=["contract","irreversible"].includes(strategy)?"operator":"preserve_schema"){const payload={release_id:id,release_version:ver,min_installer_version:version,schema_target:schema,released_at:"2026-10-23T12:00:00Z",created_at:"2026-10-23T12:00:00Z",architectures:["amd64"],compatibility:{compatible_previous_apps:previous,min_schema:"0516",max_schema:schema},images:images(ch),migration:{strategy,ids},rollback:{application:true,configuration:true,database_strategy:databaseStrategy,compatible_previous_apps:previous},required_backups:["configuration","database","release_state","image_state"],release_notes:{id,locale:"pt-BR",summary:"Fixture TEST local."}};const doc={payload,keyId,algorithm:"Ed25519",purpose:"release_manifest",signature:c.sign(null,Buffer.from(canon(payload)),privateKey).toString("base64url")};fs.writeFileSync(p.join(root,file),JSON.stringify(doc,null,2)+"\n",{mode:0o600});fs.writeFileSync(p.join(root,`images-${file}`),JSON.stringify(Object.fromEntries(Object.entries(payload.images).map(([k,v])=>[k,`${v.repository}@${v.digest}`]))));}
make("a.json","release-a-test","1.70.0","0516","a");
make("b.json","release-b-test","1.70.1","0517","b",["1.70.0"],"expand",["0517_expand_customer_ingress.sql"]);
make("irreversible.json","release-irreversible-test","1.70.1","0517","b",["1.70.0"],"irreversible",["0517_contract_customer_table.sql"]);
NODE

HARNESS="$WORK/installer-harness.sh"
cat > "$HARNESS" <<'HARNESS'
#!/usr/bin/env bash
set -euo pipefail
source "$REPO_ROOT/distribution/installer/install.sh"
eval "$(declare -f validate_manifest | sed '1s/validate_manifest/real_validate_manifest/')"
trace(){ printf '%s\n' "$*" >> "$CLIENTIX_TEST_TRACE"; }
validate_manifest(){ real_validate_manifest; trace "VERIFY:$VERIFIED_RELEASE_ID"; }
preflight(){ :; }; validate_external_config(){ :; }; validate_ingress_config(){ :; }
check_ingress_ports_available(){ :; }; validate_existing_runtime_config(){ :; }
validate_dns_ingress_release(){ :; }; validate_cloudflare_token_source(){ :; }
check_external_dependencies(){ trace EXTERNAL_DEPENDENCIES; }; registry_auth(){ :; }; registry_logout(){ :; }
validate_current_image_availability(){ trace PREVIOUS_DIGESTS_AVAILABLE; }
remove_legacy_cloudflare_secret_after_ready(){ :; }
compose(){ trace "COMPOSE:$*"; return 0; }
ensure_target_images(){
  trace PULL_DIGESTS
  [ "${CLIENTIX_TEST_FAIL_STEP:-}" != pull ] || return 1
  for ref in "$VERIFIED_IMAGE_APP" "$VERIFIED_IMAGE_WORKER" "$VERIFIED_IMAGE_SCHEDULER" "$VERIFIED_IMAGE_VOICE_AGENT" "$VERIFIED_IMAGE_MIGRATOR" "$VERIFIED_IMAGE_CADDY"; do
    [[ "$ref" =~ ^localhost:5000/clientix-[a-z-]+@sha256:[a-f0-9]{64}$ ]] || return 1
  done
}
run_backup(){ trace DATABASE_BACKUP; [ "${CLIENTIX_TEST_FAIL_STEP:-}" != backup ] || return 1; mkdir -p "$BACKUP_DIR"; local f="$BACKUP_DIR/test-backup-$(date -u +%s%N).dump"; printf 'synthetic-backup\n' > "$f"; chmod 600 "$f"; printf '%s\n' "$f"; }
status_json(){
  local target="${VERIFIED_SCHEMA_TARGET:-$UPDATE_TARGET_SCHEMA}" schema pending
  if [ ! -s "$CLIENTIX_TEST_DB_SCHEMA" ]; then printf '{"state_type":"FRESH_DATABASE","schema_evidence_valid":true,"current_schema":null,"target_baseline":"%s","pending_migrations":[]}\n' "$target"; return; fi
  schema="$(cat "$CLIENTIX_TEST_DB_SCHEMA")"
  if [ -n "${VERIFIED_MANIFEST_JSON:-}" ]; then pending="$(node -e 'const m=JSON.parse(process.argv[1]);process.stdout.write(JSON.stringify(Number(process.argv[2])<Number(m.schema_target)?m.migration.ids:[]))' "$VERIFIED_MANIFEST_JSON" "$schema")"; else pending='[]'; fi
  printf '{"state_type":"TRACKED_INSTALLATION","schema_evidence_valid":true,"current_schema":"%s","target_baseline":"%s","pending_migrations":%s}\n' "$schema" "$target" "$pending"
}
run_migrator_with_image(){ local image="$1" cmd="$2"; shift 2; if [ "$cmd" = status ] && [ "${1:-}" = --json ]; then status_json; return; fi; if [ "$cmd" = update ]; then trace MIGRATION_APPLY; [ "${CLIENTIX_TEST_FAIL_STEP:-}" != migration ] || return 1; printf '%s\n' "$VERIFIED_SCHEMA_TARGET" > "$CLIENTIX_TEST_DB_SCHEMA"; [ "${CLIENTIX_TEST_FAIL_STEP:-}" != crash-after-migration ] || kill -KILL "$$"; return; fi; return 0; }
run_migrator(){ local cmd="$1"; shift; if [ "$cmd" = status ] && [ "${1:-}" = --json ]; then status_json; return; fi; if [ "$cmd" = install ] || [ "$cmd" = adopt ]; then trace FRESH_INSTALL_MIGRATOR; printf '%s\n' "$VERIFIED_SCHEMA_TARGET" > "$CLIENTIX_TEST_DB_SCHEMA"; return; fi; run_migrator_with_image "$VERIFIED_IMAGE_MIGRATOR" "$cmd" "$@"; }
run_runtime_db_preflight(){ trace DB_HEALTH; }
check_health(){ local timeout="${1:-45}"; trace "HTTPS_HEALTH:$timeout"; if [ "${CLIENTIX_TEST_FAIL_STEP:-}" = health-target ] && [[ "${APP_IMAGE:-}" == *"sha256:$CLIENTIX_TEST_B_DIGEST" ]]; then return 1; fi; return 0; }
case "${1:-}" in
  install) shift; cmd_install "$@";;
  update) shift; cmd_update "$@";;
  rollback) shift; cmd_rollback "$@";;
  lock-hold) acquire_update_lock tx-lock-holder; : > "$CLIENTIX_TEST_LOCK_READY"; while [ ! -e "$CLIENTIX_TEST_LOCK_RELEASE" ]; do sleep 0.02; done; release_update_lock;;
  lock-check) acquire_update_lock tx-lock-contender; release_update_lock;;
  *) exit 2;;
esac
HARNESS
chmod 700 "$HARNESS"

make_install(){
  local name="$1" images
  local install="$WORK/$name"
  mkdir -p "$install/state" "$install/test-fixtures" "$install/test-trust/release-manifest"
  cp "$WORK/test-public.pem" "$install/test-trust/release-manifest/clientix-test-release-fixture.pem"
  cp "$WORK/a.json" "$install/test-fixtures/release-manifest.json"
  images="$(node -e 'process.stdout.write(JSON.stringify(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8"))))' "$WORK/images-a.json")"
  node - "$install/.env" "$images" <<'NODE'
const fs=require("node:fs"),[file,j]=process.argv.slice(2),images=JSON.parse(j);
const values={INSTALLATION_ID:"inst_123e4567-e89b-42d3-a456-426614174000",DOMAIN:"clientix-updater.test",ACME_EMAIL:"operator@example.test",CLIENTIX_ACME_CHALLENGE:"direct",NEXT_PUBLIC_APP_URL:"https://clientix-updater.test",NEXT_PUBLIC_ADMIN_URL:"https://clientix-updater.test/admin",NEXT_PUBLIC_SUPABASE_URL:"https://supabase.example.test",NEXT_PUBLIC_SUPABASE_ANON_KEY:"TEST_ONLY_ANON",SUPABASE_SERVICE_ROLE_KEY:"TEST_ONLY_SERVICE",INTERNAL_SECRET:"TEST_ONLY_INTERNAL",CPF_ENCRYPTION_KEY:"TEST_ONLY_CPF",WAHA_BYO_ENCRYPTION_KEY:"TEST_ONLY_WAHA",AI_CRED_AES_KEY:"TEST_ONLY_AI",SUPABASE_DB_URL:"postgresql://runtime:TEST_ONLY_DB_MARKER@127.0.0.1:5432/clientix",SUPABASE_DB_ADMIN_URL:"postgresql://admin:TEST_ONLY_DB_MARKER@127.0.0.1:5432/clientix",WAHA_API_BASE_URL:"https://waha.example.test",WAHA_API_KEY:"TEST_ONLY_WAHA_API",WAHA_WEBHOOK_BASE_URL:"https://clientix-updater.test/api/v1/webhooks/waha",UPSTASH_REDIS_REST_URL:"https://redis.example.test",UPSTASH_REDIS_REST_TOKEN:"TEST_ONLY_REDIS",...Object.fromEntries(Object.entries(images).map(([k,v])=>[`${k.toUpperCase()}_IMAGE`,v]))};
values.VOICE_AGENT_IMAGE=images.voice_agent;
fs.writeFileSync(file,Object.entries(values).map(([k,v])=>`${k}=${v}`).join("\n")+"\n",{mode:0o600});
NODE
  chmod 600 "$install/.env"
  printf '%s' "$install"
}
run_installer(){
  local name="$1" install="$2" mode="$3" fail="${4:-}"; shift "$(( $# >= 4 ? 4 : 3 ))"
  local code
  : > "$WORK/$name.trace"
  set +e
  env -u CLOUDFLARE_API_TOKEN REPO_ROOT="$REPO_ROOT" CLIENTIX_DIR="$install" CLIENTIX_INSTALLER_TEST_MODE=1 \
    CLIENTIX_TEST_DB_SCHEMA="$install.test-db-schema" CLIENTIX_TEST_TRACE="$WORK/$name.trace" \
    CLIENTIX_TEST_FAIL_STEP="$fail" CLIENTIX_TEST_B_DIGEST="$(printf 'b%.0s' {1..64})" \
    bash "$HARNESS" "$mode" --test-mode "$@" > "$WORK/$name.log" 2>&1
  code=$?
  set -e
  printf '%s' "$code"
}
PASS=0; FAIL=0
check(){ local name="$1";shift;if "$@";then printf '  ✓ %s\n' "$name";PASS=$((PASS+1));else printf '  ✗ %s\n' "$name";FAIL=$((FAIL+1));fi; }
release_version(){ node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).installed_version)' "$1/state/release.json"; }
release_schema(){ node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).schema_version)' "$1/state/release.json"; }
journal_state(){ node -e 'process.stdout.write(JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")).state)' "$1/state/update-journal.json"; }
before(){ local file="$1" first="$2" second="$3" a b; a="$(grep -n -m1 -F "$first" "$file"|cut -d: -f1)"||return 1; b="$(grep -n -m1 -F "$second" "$file"|cut -d: -f1)"||return 1; [ "$a" -lt "$b" ]; }
export -f release_version release_schema journal_state before

main_install="$(make_install main)"
install_status="$(run_installer fresh-install "$main_install" install)"
if [ "$install_status" -ne 0 ]; then sed -E 's#(postgres(ql)?://[^:/]+:)[^@]+@#\1[REDACTED]@#g' "$WORK/fresh-install.log" >&2; fi
check "fresh signed TEST install A exits zero" test "$install_status" = 0
check "fresh TEST install records version A and schema 0516" bash -c '[ "$(release_version "$1")" = 1.70.0 ] && [ "$(release_schema "$1")" = 0516 ]' _ "$main_install"

cp "$WORK/b.json" "$main_install/test-fixtures/release-manifest.json"
state_before="$(sha256sum "$main_install/.env" "$main_install/state/release.json")"
dry_status="$(run_installer dry-run "$main_install" update '' --dry-run)"
state_after="$(sha256sum "$main_install/.env" "$main_install/state/release.json")"
check "dry-run validates and returns zero" test "$dry_status" = 0
check "dry-run does not persist release/config/journal state" bash -c '[ "$1" = "$2" ] && [ ! -e "$3/state/update-journal.json" ]' _ "$state_before" "$state_after" "$main_install"

node - "$main_install/test-fixtures/release-manifest.json" <<'NODE'
const fs=require("node:fs"),f=process.argv[2],m=JSON.parse(fs.readFileSync(f,"utf8"));m.payload.release_notes.summary="changed without a new signature";fs.writeFileSync(f,JSON.stringify(m));
NODE
bad_signature="$(run_installer invalid-signature "$main_install" update)"
check "tampered signed manifest fails before pull" bash -c '[ "$1" -ne 0 ] && ! grep -q PULL_DIGESTS "$2"' _ "$bad_signature" "$WORK/invalid-signature.trace"
cp "$WORK/b.json" "$main_install/test-fixtures/release-manifest.json"

backup_failure="$(run_installer backup-failure "$main_install" update backup)"
check "backup failure is terminal pre-migration and precedes pull" bash -c '[ "$1" -ne 0 ] && ! grep -q PULL_DIGESTS "$2" && [ "$(journal_state "$3")" = FAILED_PRE_MIGRATION ]' _ "$backup_failure" "$WORK/backup-failure.trace" "$main_install"
pull_failure="$(run_installer pull-failure "$main_install" update pull)"
check "pull failure never starts migration" bash -c '[ "$1" -ne 0 ] && ! grep -q MIGRATION_APPLY "$2" && [ "$(journal_state "$3")" = FAILED_PRE_MIGRATION ]' _ "$pull_failure" "$WORK/pull-failure.trace" "$main_install"

update_status="$(run_installer update-success "$main_install" update)"
if [ "$update_status" -ne 0 ]; then sed -E 's#(postgres(ql)?://[^:/]+:)[^@]+@#\1[REDACTED]@#g' "$WORK/update-success.log" >&2; fi
check "signed update A to B completes" test "$update_status" = 0
check "signature verification and backup happen before digest pull" bash -c 'before "$1" VERIFY:release-b-test PULL_DIGESTS && before "$1" DATABASE_BACKUP PULL_DIGESTS' _ "$WORK/update-success.trace"
check "pull and migration precede healthy committed state" bash -c 'before "$1" PULL_DIGESTS MIGRATION_APPLY && node - "$2" <<"NODE"
const j=JSON.parse(require("node:fs").readFileSync(process.argv[2],"utf8")),i=s=>j.events.findIndex(e=>e.state===s);if(!(i("HEALTHCHECKING")<i("COMMITTED")))process.exit(1);
NODE' _ "$WORK/update-success.trace" "$main_install/state/update-journal.json"
check "release B is committed at schema 0517" bash -c '[ "$(release_version "$1")" = 1.70.1 ] && [ "$(release_schema "$1")" = 0517 ] && [ "$(journal_state "$1")" = COMMITTED ]' _ "$main_install"

idempotent_status="$(run_installer idempotent "$main_install" update)"
check "healthy rerun is idempotent without backup/pull/migration" bash -c '[ "$1" = 0 ] && ! grep -Eq "DATABASE_BACKUP|PULL_DIGESTS|MIGRATION_APPLY" "$2"' _ "$idempotent_status" "$WORK/idempotent.trace"
rollback_status="$(run_installer rollback-success "$main_install" rollback)"
if [ "$rollback_status" -ne 0 ]; then sed -E 's#(postgres(ql)?://[^:/]+:)[^:/]+@#\1[REDACTED]@#g' "$WORK/rollback-success.log" >&2; fi
check "rollback restores A while preserving expanded schema" bash -c '[ "$1" = 0 ] && [ "$(release_version "$2")" = 1.70.0 ] && [ "$(release_schema "$2")" = 0517 ] && [ "$(journal_state "$2")" = ROLLED_BACK ]' _ "$rollback_status" "$main_install"
check "checkpoint retains A digest and journal records target B digest" node - "$main_install" <<'NODE'
const fs=require("node:fs"),p=require("node:path"),root=process.argv[2],j=JSON.parse(fs.readFileSync(`${root}/state/update-journal.json`,`utf8`));
const old=JSON.parse(fs.readFileSync(p.join(root,"backups/releases",j.transaction_id,"configuration/image-state.json"),"utf8"));
if(!old.app.endsWith(`sha256:${"a".repeat(64)}`)||!j.target_images.app.endsWith(`sha256:${"b".repeat(64)}`))process.exit(1);
NODE

health_install="$(make_install health-recovery)"
health_install_status="$(run_installer health-install "$health_install" install)"
cp "$WORK/b.json" "$health_install/test-fixtures/release-manifest.json"
health_failure="$(run_installer health-failure "$health_install" update health-target)"
check "post-migration health failure restores A and keeps schema 0517" bash -c '[ "$1" -ne 0 ] && [ "$(release_version "$2")" = 1.70.0 ] && [ "$(release_schema "$2")" = 0517 ] && [ "$(journal_state "$2")" = ROLLED_BACK ]' _ "$health_failure" "$health_install"

irreversible_install="$(make_install irreversible-recovery)"
irreversible_install_status="$(run_installer irreversible-install "$irreversible_install" install)"
check "irreversible recovery scenario starts from a fresh signed TEST A install" test "$irreversible_install_status" = 0
cp "$WORK/irreversible.json" "$irreversible_install/test-fixtures/release-manifest.json"
irreversible_unconfirmed="$(run_installer irreversible-unconfirmed "$irreversible_install" update)"
check "irreversible release requires signed release-id confirmation before backup or pull" bash -c '[ "$1" -ne 0 ] && grep -q IRREVERSIBLE_RELEASE_CONFIRMATION_REQUIRED "$2" && ! grep -Eq "DATABASE_BACKUP|PULL_DIGESTS|MIGRATION_APPLY" "$3"' _ "$irreversible_unconfirmed" "$WORK/irreversible-unconfirmed.log" "$WORK/irreversible-unconfirmed.trace"

irreversible_failure="$(run_installer irreversible-health-failure "$irreversible_install" update health-target --confirm-irreversible release-irreversible-test)"
check "irreversible post-migration health failure records manual recovery without false rollback" bash -c '[ "$1" -ne 0 ] && [ "$(journal_state "$2")" = MANUAL_RECOVERY_REQUIRED ] && [ "$(release_version "$2")" = 1.70.0 ] && [ "$(cat "$2.test-db-schema")" = 0517 ] && [ "$(grep -c "^COMPOSE:up -d$" "$3/irreversible-health-failure.trace")" = 1 ]' _ "$irreversible_failure" "$irreversible_install" "$WORK"
manual_rollback="$(run_installer irreversible-manual-rollback "$irreversible_install" rollback)"
check "rollback CLI preserves MANUAL_RECOVERY_REQUIRED and refuses database rollback" bash -c '[ "$1" -ne 0 ] && grep -q ROLLBACK_REQUIRES_OPERATOR_INTERVENTION "$2" && [ "$(journal_state "$3")" = MANUAL_RECOVERY_REQUIRED ] && [ "$(cat "$3.test-db-schema")" = 0517 ]' _ "$manual_rollback" "$WORK/irreversible-manual-rollback.log" "$irreversible_install"

check "journal/checkpoint/logs contain no synthetic DB credential marker" node - "$main_install" "$WORK" <<'NODE'
const fs=require("node:fs"),p=require("node:path"),[root,work]=process.argv.slice(2),marker="TEST_ONLY_DB_MARKER",files=[];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=p.join(dir,e.name);if(e.isDirectory())walk(f);else files.push(f);}}
walk(p.join(root,"backups/releases"));files.push(p.join(root,"state/update-journal.json"),p.join(work,"update-success.log"),p.join(work,"rollback-success.log"),p.join(work,"irreversible-health-failure.log"),p.join(work,"irreversible-manual-rollback.log"));
for(const file of files)if(fs.readFileSync(file,"utf8").includes(marker))process.exit(1);
NODE

crash_install="$(make_install crash-resume)"
crash_install_status="$(run_installer crash-install "$crash_install" install)"
cp "$WORK/b.json" "$crash_install/test-fixtures/release-manifest.json"
crash_status="$(run_installer crash-update "$crash_install" update crash-after-migration 2>/dev/null)"
resume_status="$(run_installer crash-resume "$crash_install" rollback)"
if [ "$crash_status" -ne 137 ] || [ "$resume_status" -ne 0 ]; then sed -E 's#(postgres(ql)?://[^:/]+:)[^:/]+@#\1[REDACTED]@#g' "$WORK/crash-update.log" >&2; sed -E 's#(postgres(ql)?://[^:/]+:)[^:/]+@#\1[REDACTED]@#g' "$WORK/crash-resume.log" >&2; fi
check "journal recovery rolls back after updater process death" bash -c '[ "$1" -eq 137 ] && [ "$2" = 0 ] && [ "$(release_version "$3")" = 1.70.0 ] && [ "$(release_schema "$3")" = 0517 ] && [ "$(journal_state "$3")" = ROLLED_BACK ]' _ "$crash_status" "$resume_status" "$crash_install"
check "stale lock metadata is reclaimed only after flock is free" grep -q UPDATE_STALE_LOCK_METADATA "$WORK/crash-resume.log"

lock_install="$(make_install lock)"
mkdir -p "$lock_install/state"
ready="$WORK/lock.ready"; release="$WORK/lock.release"
env -u CLOUDFLARE_API_TOKEN REPO_ROOT="$REPO_ROOT" CLIENTIX_DIR="$lock_install" CLIENTIX_INSTALLER_TEST_MODE=1 \
  CLIENTIX_TEST_DB_SCHEMA="$lock_install.test-db-schema" CLIENTIX_TEST_TRACE="$WORK/lock-holder.trace" \
  CLIENTIX_TEST_LOCK_READY="$ready" CLIENTIX_TEST_LOCK_RELEASE="$release" \
  bash "$HARNESS" lock-hold > "$WORK/lock-holder.log" 2>&1 &
holder="$!"
for _ in $(seq 1 200); do [ -e "$ready" ] && break; sleep 0.01; done
lock_status="$(run_installer lock-contender "$lock_install" lock-check)"
: > "$release"
wait "$holder"
check "flock blocks a concurrent updater" test "$lock_status" -ne 0

printf '\nUpdater shell checks: %d passed, %d failed\n' "$PASS" "$FAIL"
[ "$FAIL" -eq 0 ]
