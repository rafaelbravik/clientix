#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { compareSemVer, parseSemVer } from "./verify-release-manifest.mjs";

export const UPDATE_STATES = Object.freeze([
  "PREFLIGHT_OK",
  "CHECKPOINT_CREATED",
  "IMAGES_PULLED",
  "CONFIG_PREPARED",
  "MIGRATION_STARTED",
  "MIGRATIONS_APPLIED",
  "SERVICES_STARTED",
  "HEALTHCHECKING",
  "COMMITTED",
  "FAILED_PRE_MIGRATION",
  "FAILED_POST_MIGRATION",
  "ROLLBACK_IN_PROGRESS",
  "ROLLED_BACK",
  "MANUAL_RECOVERY_REQUIRED",
]);

const TERMINAL_FOR_NEW_UPDATE = new Set(["COMMITTED", "FAILED_PRE_MIGRATION", "ROLLED_BACK"]);
const OFFICIAL_RELEASE_KEY_ID = "clientix-release-2026-01";
const TEST_RELEASE_KEY_ID = "clientix-test-release-fixture";
const IMAGE_REPOSITORIES = Object.freeze({
  app: "ghcr.io/rafaelbravik/clientix-app",
  worker: "ghcr.io/rafaelbravik/clientix-worker",
  scheduler: "ghcr.io/rafaelbravik/clientix-scheduler",
  voice_agent: "ghcr.io/rafaelbravik/clientix-voice-agent",
  migrator: "ghcr.io/rafaelbravik/clientix-migrator",
  caddy: "ghcr.io/rafaelbravik/clientix-ingress",
});
const REQUIRED_IMAGE_KEYS = Object.keys(IMAGE_REPOSITORIES);
const REQUIRED_HEALTH_GATES = ["app", "worker", "scheduler", "caddy", "database", "redis", "waha", "critical_route", "https"];
const JOURNAL_FIELDS = new Set([
  "transaction_id", "state", "source_version", "target_version", "source_schema", "target_schema",
  "schema_after", "release_id", "source_release_id", "signer_key_id", "source_images", "target_images",
  "checkpoint_id", "database_backup_sha256", "database_action", "exit_code", "error_code", "updated_at", "events",
]);
const JOURNAL_EVENT_FIELDS = new Set(["state", "updated_at", "error_code", "schema_after", "database_action", "exit_code"]);
const STATE_TRANSITIONS = {
  PREFLIGHT_OK: ["CHECKPOINT_CREATED", "FAILED_PRE_MIGRATION", "MANUAL_RECOVERY_REQUIRED"],
  CHECKPOINT_CREATED: ["IMAGES_PULLED", "FAILED_PRE_MIGRATION", "ROLLBACK_IN_PROGRESS", "MANUAL_RECOVERY_REQUIRED"],
  IMAGES_PULLED: ["CONFIG_PREPARED", "FAILED_PRE_MIGRATION", "ROLLBACK_IN_PROGRESS", "MANUAL_RECOVERY_REQUIRED"],
  CONFIG_PREPARED: ["MIGRATION_STARTED", "FAILED_PRE_MIGRATION", "ROLLBACK_IN_PROGRESS", "MANUAL_RECOVERY_REQUIRED"],
  MIGRATION_STARTED: ["MIGRATIONS_APPLIED", "FAILED_POST_MIGRATION", "ROLLBACK_IN_PROGRESS", "MANUAL_RECOVERY_REQUIRED"],
  MIGRATIONS_APPLIED: ["SERVICES_STARTED", "FAILED_POST_MIGRATION", "ROLLBACK_IN_PROGRESS", "MANUAL_RECOVERY_REQUIRED"],
  SERVICES_STARTED: ["HEALTHCHECKING", "FAILED_POST_MIGRATION", "ROLLBACK_IN_PROGRESS", "MANUAL_RECOVERY_REQUIRED"],
  HEALTHCHECKING: ["COMMITTED", "FAILED_POST_MIGRATION", "ROLLBACK_IN_PROGRESS", "MANUAL_RECOVERY_REQUIRED"],
  COMMITTED: ["ROLLBACK_IN_PROGRESS", "MANUAL_RECOVERY_REQUIRED"],
  FAILED_POST_MIGRATION: ["ROLLBACK_IN_PROGRESS", "MANUAL_RECOVERY_REQUIRED"],
  ROLLBACK_IN_PROGRESS: ["ROLLED_BACK", "MANUAL_RECOVERY_REQUIRED"],
};

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isObject(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function validateImages(images, { allowTestRegistry = false } = {}) {
  if (!isObject(images) || REQUIRED_IMAGE_KEYS.some((key) => typeof images[key] !== "string") ||
      Object.keys(images).some((key) => !REQUIRED_IMAGE_KEYS.includes(key))) {
    fail("IMAGE_SET_INVALID");
  }
  const result = {};
  for (const key of REQUIRED_IMAGE_KEYS) {
    const ref = images[key];
    const match = /^([^@\s]+)@(sha256:[a-f0-9]{64})$/.exec(ref);
    if (!match) fail(`IMAGE_DIGEST_INVALID_${key.toUpperCase()}`);
    if (match[1] !== IMAGE_REPOSITORIES[key] &&
        !(allowTestRegistry && /^(?:localhost|127\.0\.0\.1)(?::\d+)?\/clientix-[a-z-]+$/.test(match[1]))) {
      fail(`IMAGE_REPOSITORY_UNAUTHORIZED_${key.toUpperCase()}`);
    }
    result[key] = ref;
  }
  return result;
}

function sameImages(left, right) {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
}

const RUNTIME_CONFIG_KEYS = Object.freeze([
  "APP_IMAGE",
  "WORKER_IMAGE",
  "SCHEDULER_IMAGE",
  "VOICE_AGENT_IMAGE",
  "MIGRATOR_IMAGE",
  "CADDY_IMAGE",
  "CLIENTIX_ACME_CHALLENGE",
  "CLIENTIX_ACME_DNS_PROVIDER",
  "CLIENTIX_ACME_SECRET_MODE",
  "CLIENTIX_CLOUDFLARE_TOKEN_FILE",
]);
const COMPOSE_SNAPSHOT_FILES = Object.freeze([
  "compose.yaml",
  "compose.dns-cloudflare.yaml",
  "compose.dns-cloudflare-ephemeral.yaml",
  "Caddyfile",
  "Caddyfile.dns-cloudflare",
]);

function writeAtomic(filePath, bytes, mode = 0o600) {
  const directory = path.dirname(filePath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(temporary, "wx", mode);
  try {
    fs.writeFileSync(fd, bytes);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.renameSync(temporary, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  try {
    const fdDir = fs.openSync(directory, "r");
    try { fs.fsyncSync(fdDir); } finally { fs.closeSync(fdDir); }
  } catch {}
}

function readJsonFile(filePath, errorCode) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { fail(errorCode); }
}

function safeRegularFile(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    return stat.isFile() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function checkpointPath(installDir, transactionId) {
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(transactionId)) fail("UPDATE_TRANSACTION_ID_INVALID");
  const root = path.resolve(installDir);
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) fail("INSTALL_DIRECTORY_UNSAFE");
  const backupRoot = path.resolve(root, "backups", "releases");
  const result = path.resolve(backupRoot, transactionId);
  if (!result.startsWith(`${backupRoot}${path.sep}`)) fail("CHECKPOINT_PATH_INVALID");
  for (const directory of [path.join(root, "backups"), backupRoot]) {
    try {
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) fail("CHECKPOINT_PATH_UNSAFE");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  try {
    if (fs.lstatSync(result).isSymbolicLink()) fail("CHECKPOINT_PATH_UNSAFE");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return { root, backupRoot, result };
}

export function createReleaseCheckpoint(installDir, transactionId, {
  currentImages,
  runtimeConfig,
  verifiedManifest,
  signedManifest,
  plan,
  allowTestMode = false,
}) {
  const { root, backupRoot, result } = checkpointPath(installDir, transactionId);
  if (!isObject(runtimeConfig)) fail("CHECKPOINT_RUNTIME_CONFIG_INVALID");
  if (Object.keys(runtimeConfig).some((key) => !RUNTIME_CONFIG_KEYS.includes(key))) fail("CHECKPOINT_RUNTIME_CONFIG_KEYS_INVALID");
  for (const key of RUNTIME_CONFIG_KEYS) {
    if (typeof runtimeConfig[key] !== "string") fail("CHECKPOINT_RUNTIME_CONFIG_VALUE_INVALID");
  }
  const testAuthority = allowTestMode && verifiedManifest?.signer_key_id === TEST_RELEASE_KEY_ID;
  if (verifiedManifest?.signer_key_id !== OFFICIAL_RELEASE_KEY_ID && !testAuthority) fail("RELEASE_SIGNER_UNTRUSTED");
  const images = validateImages(currentImages, { allowTestRegistry: testAuthority });
  const sourceIsLegacy = plan?.source_authentication === "legacy_digest_pinned";
  if (!isObject(verifiedManifest) || !isObject(signedManifest) || !isObject(plan) ||
      signedManifest.keyId !== verifiedManifest.signer_key_id ||
      signedManifest.signature !== verifiedManifest.signature ||
      signedManifest.payload?.release_id !== verifiedManifest.release_id ||
      verifiedManifest.payload_sha256 !== crypto.createHash("sha256").update(JSON.stringify(canonical(signedManifest.payload)), "utf8").digest("hex") ||
      !sameImages(validateImages(plan.source_images, { allowTestRegistry: testAuthority }), images) ||
      !sameImages(validateImages(plan.target_images, { allowTestRegistry: testAuthority }),
        validateImages(verifiedManifest.images, { allowTestRegistry: testAuthority }))) {
    fail("CHECKPOINT_METADATA_INVALID");
  }
  const challenge = runtimeConfig.CLIENTIX_ACME_CHALLENGE || "direct";
  const secretMode = runtimeConfig.CLIENTIX_ACME_SECRET_MODE || "external";
  const tokenFile = runtimeConfig.CLIENTIX_CLOUDFLARE_TOKEN_FILE || "";
  if (!["direct", "dns"].includes(challenge) || !["external", "ephemeral"].includes(secretMode) ||
      (secretMode === "ephemeral" && tokenFile !== "") ||
      (secretMode === "external" && tokenFile !== "" && !path.isAbsolute(tokenFile))) {
    fail("CHECKPOINT_DNS_SECRET_CONFIG_INVALID");
  }
  const runtimeImages = Object.fromEntries(REQUIRED_IMAGE_KEYS.map((key) => {
    const configKey = `${key === "voice_agent" ? "VOICE_AGENT" : key.toUpperCase()}_IMAGE`;
    return [key, runtimeConfig[configKey]];
  }));
  if (!sameImages(validateImages(runtimeImages, { allowTestRegistry: testAuthority }), images)) {
    fail("CHECKPOINT_RUNTIME_IMAGE_MISMATCH");
  }
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  if (fs.existsSync(result)) fail("CHECKPOINT_ALREADY_EXISTS");
  fs.mkdirSync(result, { mode: 0o700 });
  try {
    const configDir = path.join(result, "configuration");
    const stateDir = path.join(result, "release-state");
    fs.mkdirSync(configDir, { mode: 0o700 });
    fs.mkdirSync(stateDir, { mode: 0o700 });
    const releaseState = path.join(root, "state", "release.json");
    if (!safeRegularFile(releaseState)) fail("CURRENT_RELEASE_STATE_UNAVAILABLE");
    const currentRelease = readJsonFile(releaseState, "CURRENT_RELEASE_STATE_INVALID");
    if (sourceIsLegacy !== !currentRelease.signer_key_id) fail("CHECKPOINT_SOURCE_AUTHENTICATION_INVALID");
    fs.copyFileSync(releaseState, path.join(stateDir, "release.json"), fs.constants.COPYFILE_EXCL);
    const currentManifest = path.join(root, "state", "current-release-manifest.json");
    if (safeRegularFile(currentManifest)) {
      if (sourceIsLegacy) fail("LEGACY_STATE_MANIFEST_MISMATCH");
      fs.copyFileSync(currentManifest, path.join(stateDir, "current-release-manifest.json"), fs.constants.COPYFILE_EXCL);
    } else if (!sourceIsLegacy) {
      fail("CURRENT_RELEASE_MANIFEST_UNAVAILABLE");
    }
    for (const name of COMPOSE_SNAPSHOT_FILES) {
      const source = path.join(root, name);
      if (!safeRegularFile(source)) continue;
      fs.copyFileSync(source, path.join(configDir, name), fs.constants.COPYFILE_EXCL);
    }
    if (!safeRegularFile(path.join(configDir, "compose.yaml"))) fail("CHECKPOINT_COMPOSE_UNAVAILABLE");
    writeAtomic(path.join(configDir, "runtime-config.json"), `${JSON.stringify(runtimeConfig, null, 2)}\n`);
    writeAtomic(path.join(configDir, "image-state.json"), `${JSON.stringify(images, null, 2)}\n`);
    writeAtomic(path.join(result, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
    writeAtomic(path.join(result, "target-release.json"), `${JSON.stringify({
      verified: verifiedManifest,
      signed: signedManifest,
    }, null, 2)}\n`);
    return { checkpoint_id: transactionId, path: result, complete: true, database_backup: false };
  } catch (error) {
    try { fs.rmSync(result, { recursive: true, force: true }); } catch {}
    throw error;
  }
}

export async function recordCheckpointDatabaseBackup(installDir, transactionId, backup) {
  const { root, result } = checkpointPath(installDir, transactionId);
  if (!isObject(backup) || typeof backup.path !== "string" || !/^[a-f0-9]{64}$/.test(backup.sha256) ||
      !Number.isSafeInteger(backup.size_bytes) || backup.size_bytes < 1) fail("DATABASE_BACKUP_METADATA_INVALID");
  const backupFile = path.resolve(backup.path);
  const installBackupRoot = path.resolve(root, "backups");
  if (!backupFile.startsWith(`${installBackupRoot}${path.sep}`) || !safeRegularFile(backupFile)) {
    fail("DATABASE_BACKUP_PATH_INVALID");
  }
  const stat = fs.statSync(backupFile);
  if (stat.size !== backup.size_bytes) fail("DATABASE_BACKUP_SIZE_MISMATCH");
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(backupFile)) hash.update(chunk);
  const digest = hash.digest("hex");
  if (digest !== backup.sha256) fail("DATABASE_BACKUP_DIGEST_MISMATCH");
  if (!fs.existsSync(result) || !safeRegularFile(path.join(result, "plan.json"))) fail("CHECKPOINT_NOT_FOUND");
  writeAtomic(path.join(result, "database-backup.json"), `${JSON.stringify({
    path: path.relative(root, backupFile).split(path.sep).join("/"),
    sha256: digest,
    size_bytes: stat.size,
  }, null, 2)}\n`);
  return { database_backup: true, sha256: digest, size_bytes: stat.size };
}

export async function verifyCheckpointDatabaseBackup(installDir, transactionId) {
  const { root, result } = checkpointPath(installDir, transactionId);
  const metadataPath = path.join(result, "database-backup.json");
  if (!safeRegularFile(metadataPath)) fail("DATABASE_BACKUP_UNAVAILABLE");
  const metadata = readJsonFile(metadataPath, "DATABASE_BACKUP_METADATA_INVALID");
  if (!isObject(metadata) || typeof metadata.path !== "string" ||
      !/^[a-f0-9]{64}$/.test(metadata.sha256) || !Number.isSafeInteger(metadata.size_bytes) || metadata.size_bytes < 1) {
    fail("DATABASE_BACKUP_METADATA_INVALID");
  }
  const backupPath = path.resolve(root, metadata.path);
  const backupRoot = path.resolve(root, "backups");
  if (!backupPath.startsWith(`${backupRoot}${path.sep}`) || !safeRegularFile(backupPath)) fail("DATABASE_BACKUP_UNAVAILABLE");
  const stat = fs.statSync(backupPath);
  if (stat.size !== metadata.size_bytes) fail("DATABASE_BACKUP_SIZE_MISMATCH");
  const hash = crypto.createHash("sha256");
  for await (const chunk of fs.createReadStream(backupPath)) hash.update(chunk);
  const digest = hash.digest("hex");
  if (digest !== metadata.sha256) fail("DATABASE_BACKUP_DIGEST_MISMATCH");
  return { path: backupPath, sha256: digest, size_bytes: stat.size };
}

export function readReleaseCheckpoint(installDir, transactionId, { allowTestMode = false } = {}) {
  const { result } = checkpointPath(installDir, transactionId);
  const configDir = path.join(result, "configuration");
  const releaseDir = path.join(result, "release-state");
  if (!safeRegularFile(path.join(configDir, "runtime-config.json")) ||
      !safeRegularFile(path.join(configDir, "image-state.json")) ||
      !safeRegularFile(path.join(releaseDir, "release.json"))) fail("CHECKPOINT_INVALID");
  const runtimeConfig = readJsonFile(path.join(configDir, "runtime-config.json"), "CHECKPOINT_INVALID");
  const targetReleasePath = path.join(result, "target-release.json");
  const targetRelease = safeRegularFile(targetReleasePath) ? readJsonFile(targetReleasePath, "CHECKPOINT_INVALID") : null;
  const testAuthority = allowTestMode && targetRelease?.verified?.signer_key_id === TEST_RELEASE_KEY_ID;
  if (targetRelease?.verified?.signer_key_id !== OFFICIAL_RELEASE_KEY_ID && !testAuthority) fail("RELEASE_SIGNER_UNTRUSTED");
  const images = validateImages(readJsonFile(path.join(configDir, "image-state.json"), "CHECKPOINT_INVALID"), { allowTestRegistry: testAuthority });
  if (!isObject(runtimeConfig) || Object.keys(runtimeConfig).some((key) => !RUNTIME_CONFIG_KEYS.includes(key))) {
    fail("CHECKPOINT_INVALID");
  }
  for (const key of RUNTIME_CONFIG_KEYS) if (typeof runtimeConfig[key] !== "string") fail("CHECKPOINT_INVALID");
  const releaseState = readJsonFile(path.join(releaseDir, "release.json"), "CHECKPOINT_INVALID");
  const planPath = path.join(result, "plan.json");
  const plan = safeRegularFile(planPath) ? readJsonFile(planPath, "CHECKPOINT_INVALID") : null;
  const databaseBackupPath = path.join(result, "database-backup.json");
  const databaseBackup = safeRegularFile(databaseBackupPath) ? readJsonFile(databaseBackupPath, "CHECKPOINT_INVALID") : null;
  const legacySource = plan?.source_authentication === "legacy_digest_pinned";
  if (legacySource !== !releaseState.signer_key_id) fail("CHECKPOINT_SOURCE_AUTHENTICATION_INVALID");
  return { path: result, runtime_config: runtimeConfig, images, release_state: releaseState, plan, target_release: targetRelease, database_backup: databaseBackup, legacy_source: legacySource };
}

function copyFileAtomically(source, target) {
  if (!safeRegularFile(source)) fail("CHECKPOINT_FILE_INVALID");
  const temporary = `${target}.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`;
  fs.copyFileSync(source, temporary, fs.constants.COPYFILE_EXCL);
  try { fs.renameSync(temporary, target); } catch (error) { try { fs.unlinkSync(temporary); } catch {} throw error; }
}

export function restoreReleaseCheckpoint(installDir, transactionId, schemaVersion, { allowTestMode = false } = {}) {
  const { root, result } = checkpointPath(installDir, transactionId);
  if (schemaVersion !== undefined && !/^\d{4,6}$/.test(schemaVersion)) fail("CURRENT_SCHEMA_INVALID");
  const checkpoint = readReleaseCheckpoint(root, transactionId, { allowTestMode });
  const configDir = path.join(result, "configuration");
  for (const name of COMPOSE_SNAPSHOT_FILES) {
    const source = path.join(configDir, name);
    if (safeRegularFile(source)) copyFileAtomically(source, path.join(root, name));
  }
  const stateDir = path.join(root, "state");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const savedStatePath = path.join(result, "release-state", "release.json");
  const restoredState = readJsonFile(savedStatePath, "CHECKPOINT_INVALID");
  if (schemaVersion) restoredState.schema_version = schemaVersion;
  restoredState.last_rollback_at = new Date().toISOString();
  restoredState.last_rollback_checkpoint = transactionId;
  writeAtomic(path.join(stateDir, "release.json"), `${JSON.stringify(restoredState, null, 2)}\n`);
  const savedManifest = path.join(result, "release-state", "current-release-manifest.json");
  const currentManifest = path.join(stateDir, "current-release-manifest.json");
  if (safeRegularFile(savedManifest)) copyFileAtomically(savedManifest, currentManifest);
  else if (fs.existsSync(currentManifest)) fs.unlinkSync(currentManifest);
  return checkpoint;
}

export function commitReleaseState(installDir, manifestPath, verifiedManifest, {
  installationId,
  transactionId = null,
  schemaVersion = verifiedManifest?.schema_target,
  databaseBackupPath = null,
  databaseBackupSha256 = null,
  allowTestMode = false,
}) {
  if (!isObject(verifiedManifest) || !safeRegularFile(manifestPath) ||
      typeof installationId !== "string" || !/^inst_[0-9a-f-]{36}$/.test(installationId) ||
    !/^\d{4,6}$/.test(schemaVersion)) fail("RELEASE_STATE_INPUT_INVALID");
  const testAuthority = allowTestMode && verifiedManifest.signer_key_id === TEST_RELEASE_KEY_ID;
  if (verifiedManifest.signer_key_id !== OFFICIAL_RELEASE_KEY_ID && !testAuthority) fail("RELEASE_SIGNER_UNTRUSTED");
  const stateDir = path.join(path.resolve(installDir), "state");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const statePath = path.join(stateDir, "release.json");
  const previous = fs.existsSync(statePath) ? readJsonFile(statePath, "CURRENT_RELEASE_STATE_INVALID") : null;
  if (previous && !isObject(previous)) fail("CURRENT_RELEASE_STATE_INVALID");
  const signedManifest = readJsonFile(manifestPath, "SIGNED_MANIFEST_UNAVAILABLE");
  if (signedManifest.keyId !== verifiedManifest.signer_key_id || signedManifest.signature !== verifiedManifest.signature ||
      signedManifest.payload?.release_id !== verifiedManifest.release_id ||
      verifiedManifest.payload_sha256 !== crypto.createHash("sha256").update(JSON.stringify(canonical(signedManifest.payload)), "utf8").digest("hex")) {
    fail("SIGNED_MANIFEST_CHANGED_AFTER_VERIFY");
  }
  const now = new Date().toISOString();
  const next = {
    installed_version: verifiedManifest.release_version,
    release_id: verifiedManifest.release_id,
    previous_version: previous?.installed_version ?? null,
    schema_version: schemaVersion,
    installation_id: installationId,
    installed_at: previous?.installed_at ?? now,
    last_successful_update: now,
    images: validateImages(verifiedManifest.images, { allowTestRegistry: testAuthority }),
    compatibility: verifiedManifest.compatibility,
    migration: verifiedManifest.migration,
    rollback: verifiedManifest.rollback,
    signer_key_id: verifiedManifest.signer_key_id,
    manifest_signature: verifiedManifest.signature,
    update_checkpoint_id: transactionId,
    database_backup: databaseBackupPath ? {
      path: path.relative(path.resolve(installDir), path.resolve(databaseBackupPath)).split(path.sep).join("/"),
      sha256: databaseBackupSha256,
    } : null,
  };
  copyFileAtomically(manifestPath, path.join(stateDir, "current-release-manifest.json"));
  writeAtomic(statePath, `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function createUpdatePlan({
  currentRelease,
  currentImages,
  currentSchema,
  manifest,
  confirmIrreversibleReleaseId = "",
  allowTestMode = false,
  allowLegacySource = false,
}) {
  if (!isObject(currentRelease) || typeof currentRelease.installed_version !== "string") {
    fail("CURRENT_RELEASE_STATE_INVALID");
  }
  if (!isObject(manifest) || typeof manifest.release_id !== "string" ||
      typeof manifest.release_version !== "string" || !isObject(manifest.compatibility) ||
      !isObject(manifest.migration) || !isObject(manifest.rollback)) {
    fail("VERIFIED_RELEASE_MANIFEST_INVALID");
  }
  try {
    parseSemVer(currentRelease.installed_version);
    parseSemVer(manifest.release_version);
  } catch {
    fail("RELEASE_VERSION_INVALID");
  }
  const sourceTestAuthority = allowTestMode && currentRelease.signer_key_id === TEST_RELEASE_KEY_ID;
  const targetTestAuthority = allowTestMode && manifest.signer_key_id === TEST_RELEASE_KEY_ID;
  const sourceIsLegacy = !currentRelease.signer_key_id && allowLegacySource;
  if (currentRelease.signer_key_id !== OFFICIAL_RELEASE_KEY_ID && !sourceTestAuthority && !sourceIsLegacy) {
    fail("CURRENT_RELEASE_SIGNER_UNTRUSTED");
  }
  if (manifest.signer_key_id !== OFFICIAL_RELEASE_KEY_ID && !targetTestAuthority) fail("RELEASE_SIGNER_UNTRUSTED");
  const sourceImages = validateImages(currentImages, { allowTestRegistry: sourceTestAuthority });
  const targetImages = validateImages(manifest.images, { allowTestRegistry: targetTestAuthority });
  const currentVersion = currentRelease.installed_version;
  const relation = compareSemVer(manifest.release_version, currentVersion);
  const currentSchemaSequence = Number(currentSchema);
  const targetSchemaSequence = Number(manifest.schema_target);
  if (!/^\d{4,6}$/.test(String(currentSchema)) || !/^\d{4,6}$/.test(manifest.schema_target) ||
      !Number.isInteger(currentSchemaSequence) || !Number.isInteger(targetSchemaSequence)) {
    fail("CURRENT_SCHEMA_INVALID");
  }

  if (relation < 0) fail("RELEASE_DOWNGRADE_BLOCKED");
  if (relation === 0) {
    if ((!currentRelease.release_id || manifest.release_id === currentRelease.release_id) &&
        targetSchemaSequence === currentSchemaSequence && sameImages(sourceImages, targetImages)) {
      return {
        idempotent: true,
        source_version: currentVersion,
        target_version: manifest.release_version,
        release_id: manifest.release_id,
        source_schema: String(currentSchema).padStart(4, "0"),
        target_schema: manifest.schema_target,
        source_images: sourceImages,
        target_images: targetImages,
        source_authentication: sourceIsLegacy ? "legacy_digest_pinned" : "signed_manifest",
        rollback: manifest.rollback,
        migration: manifest.migration,
      };
    }
    fail("RELEASE_VERSION_REUSED");
  }

  if (!Array.isArray(manifest.compatibility.compatible_previous_apps) ||
      !manifest.compatibility.compatible_previous_apps.includes(currentVersion)) {
    fail("PREVIOUS_APPLICATION_NOT_DECLARED_COMPATIBLE");
  }
  const minSchema = Number(manifest.compatibility.min_schema);
  const maxSchema = Number(manifest.compatibility.max_schema);
  if (!/^\d{4,6}$/.test(String(manifest.compatibility.min_schema)) ||
      !/^\d{4,6}$/.test(String(manifest.compatibility.max_schema)) ||
      currentSchemaSequence < minSchema || currentSchemaSequence > maxSchema ||
      targetSchemaSequence < currentSchemaSequence) {
    fail("SCHEMA_COMPATIBILITY_BLOCKED");
  }
  if (!["none", "expand", "contract", "irreversible"].includes(manifest.migration.strategy) ||
      !Array.isArray(manifest.migration.ids)) {
    fail("MIGRATION_METADATA_INVALID");
  }
  if (manifest.migration.strategy === "none" && targetSchemaSequence !== currentSchemaSequence) {
    fail("SCHEMA_CHANGE_WITHOUT_MIGRATION_METADATA");
  }
  if (manifest.migration.strategy !== "none" && targetSchemaSequence === currentSchemaSequence) {
    fail("MIGRATION_WITHOUT_SCHEMA_ADVANCE");
  }
  if (manifest.rollback.application !== true || manifest.rollback.configuration !== true) {
    if (!["contract", "irreversible"].includes(manifest.migration.strategy)) {
      fail("APPLICATION_ROLLBACK_NOT_DECLARED");
    }
  }
  if (["none", "expand"].includes(manifest.migration.strategy) &&
      (manifest.rollback.database_strategy !== "preserve_schema" ||
       !manifest.rollback.compatible_previous_apps?.includes(currentVersion))) {
    fail("ROLLBACK_COMPATIBILITY_NOT_DECLARED");
  }
  if (["contract", "irreversible"].includes(manifest.migration.strategy)) {
    if (manifest.rollback.database_strategy !== "operator") fail("IRREVERSIBLE_ROLLBACK_POLICY_INVALID");
    if (confirmIrreversibleReleaseId !== manifest.release_id) fail("IRREVERSIBLE_RELEASE_CONFIRMATION_REQUIRED");
  }

  const backups = new Set(manifest.required_backups ?? []);
  for (const required of ["configuration", "database", "release_state", "image_state"]) {
    if (!backups.has(required)) fail(`REQUIRED_BACKUP_NOT_DECLARED_${required.toUpperCase()}`);
  }

  return {
    idempotent: false,
    release_id: manifest.release_id,
    source_version: currentVersion,
    target_version: manifest.release_version,
    source_schema: String(currentSchema).padStart(4, "0"),
    target_schema: manifest.schema_target,
    source_images: sourceImages,
    target_images: targetImages,
    source_authentication: sourceIsLegacy ? "legacy_digest_pinned" : "signed_manifest",
    migration: manifest.migration,
    rollback: manifest.rollback,
    rollback_compatible: ["none", "expand"].includes(manifest.migration.strategy) &&
      manifest.rollback.application === true && manifest.rollback.configuration === true &&
      manifest.rollback.database_strategy === "preserve_schema" &&
      manifest.rollback.compatible_previous_apps.includes(currentVersion),
    database_backup_required: true,
  };
}

export function assertJournalTransition(previousState, nextState) {
  if (!UPDATE_STATES.includes(nextState)) fail("UPDATE_JOURNAL_STATE_INVALID");
  if (!previousState) {
    if (nextState !== "PREFLIGHT_OK") fail("UPDATE_JOURNAL_TRANSITION_INVALID");
    return;
  }
  if (!UPDATE_STATES.includes(previousState) || !STATE_TRANSITIONS[previousState]?.includes(nextState)) {
    fail("UPDATE_JOURNAL_TRANSITION_INVALID");
  }
}

export function validateTargetMigrationPlan(status, manifest) {
  if (!isObject(status) || !isObject(manifest) ||
      status.state_type !== "TRACKED_INSTALLATION" || status.schema_evidence_valid !== true ||
      status.target_baseline !== manifest.schema_target || !Array.isArray(status.pending_migrations) ||
      !isObject(manifest.migration) || !Array.isArray(manifest.migration.ids)) {
    fail("MIGRATION_PLAN_EVIDENCE_INVALID");
  }
  const pending = status.pending_migrations;
  const declared = manifest.migration.ids;
  if (pending.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id)) ||
      new Set(pending).size !== pending.length ||
      new Set(declared).size !== declared.length ||
      JSON.stringify([...pending].sort()) !== JSON.stringify([...declared].sort())) {
    fail("MIGRATION_PLAN_MISMATCH");
  }
  if ((manifest.migration.strategy === "none" && pending.length !== 0) ||
      (manifest.migration.strategy !== "none" && pending.length === 0)) {
    fail("MIGRATION_PLAN_STRATEGY_MISMATCH");
  }
  return { schema_target: manifest.schema_target, migration_ids: [...pending].sort(), strategy: manifest.migration.strategy };
}

function validateJournalData(data) {
  const inspectKeys = (value) => {
    if (Array.isArray(value)) return value.some(inspectKeys);
    if (!isObject(value)) return false;
    return Object.entries(value).some(([key, nested]) =>
      /(?:token|password|authorization|private[_-]?key|credential|secret_value)/i.test(key) || inspectKeys(nested));
  };
  if (inspectKeys(data)) fail("UPDATE_JOURNAL_SENSITIVE_FIELD_FORBIDDEN");
  if (!isObject(data) || Object.keys(data).some((key) => !JOURNAL_FIELDS.has(key)) ||
      !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(data.transaction_id ?? "") ||
      !UPDATE_STATES.includes(data.state) || typeof data.source_version !== "string" ||
      typeof data.target_version !== "string" || typeof data.updated_at !== "string" ||
      !Number.isFinite(Date.parse(data.updated_at)) ||
      !/^\d{4,6}$/.test(data.source_schema ?? "") || !/^\d{4,6}$/.test(data.target_schema ?? "")) {
    fail("UPDATE_JOURNAL_INVALID");
  }
  try {
    parseSemVer(data.source_version);
    parseSemVer(data.target_version);
  } catch {
    fail("UPDATE_JOURNAL_INVALID");
  }
  if (Number(data.target_schema) < Number(data.source_schema) ||
      (data.release_id !== undefined && (typeof data.release_id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(data.release_id))) ||
      (data.source_release_id !== undefined && data.source_release_id !== null &&
        (typeof data.source_release_id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(data.source_release_id))) ||
      (data.signer_key_id !== undefined && ![OFFICIAL_RELEASE_KEY_ID, TEST_RELEASE_KEY_ID].includes(data.signer_key_id)) ||
      (data.exit_code !== undefined && (!Number.isInteger(data.exit_code) || data.exit_code < 0 || data.exit_code > 255)) ||
      (data.schema_after !== undefined && !/^\d{4,6}$/.test(data.schema_after)) ||
      (data.database_backup_sha256 !== undefined && !/^[a-f0-9]{64}$/.test(data.database_backup_sha256)) ||
      (data.database_action !== undefined && !["PRESERVED_NEW_SCHEMA", "OPERATOR_INTERVENTION_REQUIRED"].includes(data.database_action)) ||
      (data.checkpoint_id !== undefined && !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(data.checkpoint_id)) ||
      (data.error_code !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/.test(data.error_code))) {
    fail("UPDATE_JOURNAL_INVALID");
  }
  const allowTestRegistry = data.signer_key_id === TEST_RELEASE_KEY_ID;
  if (data.source_images !== undefined) validateImages(data.source_images, { allowTestRegistry });
  if (data.target_images !== undefined) validateImages(data.target_images, { allowTestRegistry });
  if (data.events !== undefined && (!Array.isArray(data.events) || data.events.length === 0 || data.events.some((event) =>
    !isObject(event) || Object.keys(event).some((key) => !JOURNAL_EVENT_FIELDS.has(key)) ||
    !UPDATE_STATES.includes(event.state) || typeof event.updated_at !== "string" || !Number.isFinite(Date.parse(event.updated_at)) ||
    (event.error_code !== undefined && !/^[A-Z][A-Z0-9_]{0,63}$/.test(event.error_code)) ||
    (event.schema_after !== undefined && !/^\d{4,6}$/.test(event.schema_after)) ||
    (event.database_action !== undefined && !["PRESERVED_NEW_SCHEMA", "OPERATOR_INTERVENTION_REQUIRED"].includes(event.database_action)) ||
    (event.exit_code !== undefined && (!Number.isInteger(event.exit_code) || event.exit_code < 0 || event.exit_code > 255))))) {
    fail("UPDATE_JOURNAL_INVALID");
  }
  if (data.events !== undefined) {
    if (data.events[0].state !== "PREFLIGHT_OK" || data.events.at(-1).state !== data.state ||
        data.events.at(-1).updated_at !== data.updated_at) fail("UPDATE_JOURNAL_INVALID");
    for (let index = 1; index < data.events.length; index += 1) {
      assertJournalTransition(data.events[index - 1].state, data.events[index].state);
    }
  }
  return data;
}

export function writeUpdateJournal(installDir, event) {
  const stateDir = path.resolve(installDir, "state");
  const journalPath = path.join(stateDir, "update-journal.json");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  let previous = null;
  if (fs.existsSync(journalPath)) {
    try { previous = JSON.parse(fs.readFileSync(journalPath, "utf8")); } catch { fail("UPDATE_JOURNAL_CORRUPTED"); }
    validateJournalData(previous);
    if (previous.transaction_id !== event.transaction_id) {
      if (!TERMINAL_FOR_NEW_UPDATE.has(previous.state)) fail("UPDATE_RECOVERY_REQUIRED");
      assertJournalTransition(null, event.state);
    } else {
      assertJournalTransition(previous.state, event.state);
      for (const field of ["source_version", "target_version", "source_schema", "target_schema", "release_id", "source_release_id", "signer_key_id", "source_images", "target_images"]) {
        if (JSON.stringify(canonical(previous[field])) !== JSON.stringify(canonical(event[field]))) fail("UPDATE_JOURNAL_IDENTITY_CHANGED");
      }
    }
  } else {
    assertJournalTransition(null, event.state);
  }
  const timestamp = new Date().toISOString();
  const previousEvents = previous?.transaction_id === event.transaction_id && Array.isArray(previous.events)
    ? previous.events
    : [];
  const entry = {
    state: event.state,
    updated_at: timestamp,
    ...(event.error_code ? { error_code: event.error_code } : {}),
    ...(event.schema_after ? { schema_after: event.schema_after } : {}),
    ...(event.database_action ? { database_action: event.database_action } : {}),
    ...(event.exit_code !== undefined ? { exit_code: event.exit_code } : {}),
  };
  const next = validateJournalData({ ...event, updated_at: timestamp, events: [...previousEvents, entry] });
  const temporary = path.join(stateDir, `.update-journal.${process.pid}.${crypto.randomBytes(6).toString("hex")}.tmp`);
  const file = fs.openSync(temporary, "wx", 0o600);
  try {
    fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    fs.fsyncSync(file);
  } finally {
    fs.closeSync(file);
  }
  try {
    fs.renameSync(temporary, journalPath);
  } catch (error) {
    try { fs.unlinkSync(temporary); } catch {}
    throw error;
  }
  try {
    const directory = fs.openSync(stateDir, "r");
    try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  } catch {}
  return next;
}

export function readUpdateJournal(installDir) {
  const journalPath = path.join(path.resolve(installDir), "state", "update-journal.json");
  if (!fs.existsSync(journalPath)) return null;
  if (!safeRegularFile(journalPath)) fail("UPDATE_JOURNAL_PATH_UNSAFE");
  let data;
  try { data = JSON.parse(fs.readFileSync(journalPath, "utf8")); } catch { fail("UPDATE_JOURNAL_CORRUPTED"); }
  return validateJournalData(data);
}

export function classifyInterruptedUpdate(journal, plan, observedSchema = null) {
  if (!journal || TERMINAL_FOR_NEW_UPDATE.has(journal.state)) return { recovery: "NONE" };
  if (journal.state === "MANUAL_RECOVERY_REQUIRED" || journal.state === "FAILED_POST_MIGRATION") {
    return { recovery: "OPERATOR_REQUIRED", reason: journal.state };
  }
  const beforeMigration = ["PREFLIGHT_OK", "CHECKPOINT_CREATED", "IMAGES_PULLED", "CONFIG_PREPARED"].includes(journal.state);
  if (beforeMigration) return { recovery: "SAFE_PRE_MIGRATION_ROLLBACK" };
  const compatibleSchema = typeof observedSchema === "string" && /^\d{4,6}$/.test(observedSchema) &&
    Number(observedSchema) >= Number(plan?.source_schema) && Number(observedSchema) <= Number(plan?.target_schema);
  if (plan?.rollback_compatible && compatibleSchema) {
    return { recovery: "ROLLBACK_APPLICATION_KEEP_SCHEMA", schema: observedSchema };
  }
  return { recovery: "OPERATOR_REQUIRED", reason: "MIGRATION_STATE_OR_SCHEMA_UNPROVEN" };
}

function sanitizedErrorCode(error) {
  const code = error?.code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? code : "UPDATE_STEP_FAILED";
}

function assertHealthy(health) {
  for (const gate of REQUIRED_HEALTH_GATES) {
    if (health?.[gate] !== true) fail(`HEALTH_GATE_FAILED_${gate.toUpperCase()}`);
  }
}

export async function runUpdateTransaction(plan, operations, { transactionId, now = () => new Date().toISOString(), failAt } = {}) {
  if (plan?.idempotent) {
    const health = await operations.checkHealth(plan, { current: true });
    assertHealthy(health);
    return { result: "IDEMPOTENT", exit_code: 0, state: "COMMITTED" };
  }
  if (!transactionId || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(transactionId)) fail("UPDATE_TRANSACTION_ID_INVALID");
  let state = null;
  let schemaAfterMigration = null;
  let configMayHaveChanged = false;
  const record = async (next, extra = {}) => {
    assertJournalTransition(state, next);
    state = next;
    await operations.journal({
      transaction_id: transactionId,
      state,
      source_version: plan.source_version,
      target_version: plan.target_version,
      source_schema: plan.source_schema,
      schema_after: schemaAfterMigration,
      release_id: plan.release_id,
      updated_at: now(),
      ...extra,
    });
  };
  const step = async (name, fn) => {
    if (failAt) await failAt(name);
    return fn();
  };

  try {
    await step("verify-manifest", () => operations.verifyManifest(plan));
    await step("preflight", () => operations.preflight(plan));
    await record("PREFLIGHT_OK");
    const checkpoint = await step("checkpoint", () => operations.checkpoint(plan, transactionId));
    if (!checkpoint || checkpoint.complete !== true || checkpoint.database_backup !== true ||
        checkpoint.configuration !== true || checkpoint.release_state !== true || checkpoint.image_state !== true) {
      fail("CHECKPOINT_INCOMPLETE");
    }
    await record("CHECKPOINT_CREATED", { checkpoint_id: transactionId, database_backup_sha256: checkpoint.database_backup_sha256 });
    await step("pull", () => operations.pullImages(plan.target_images));
    await step("verify-digests", () => operations.verifyDigests(plan.target_images));
    await record("IMAGES_PULLED", { target_images: plan.target_images });
    await step("config", async () => {
      await operations.applyTargetConfig(plan, transactionId);
      configMayHaveChanged = true;
    });
    await record("CONFIG_PREPARED");
    await record("MIGRATION_STARTED");
    const migrationResult = await step("migration", () => operations.applyMigrations(plan));
    schemaAfterMigration = migrationResult?.schema ?? plan.target_schema;
    await record("MIGRATIONS_APPLIED");
    await step("start", () => operations.startServices(plan.target_images));
    await record("SERVICES_STARTED");
    await record("HEALTHCHECKING");
    const health = await step("health", () => operations.checkHealth(plan, { current: false }));
    assertHealthy(health);
    await step("commit", () => operations.commit(plan, transactionId, schemaAfterMigration));
    await record("COMMITTED", { schema_after: schemaAfterMigration });
    return { result: "COMMITTED", exit_code: 0, state };
  } catch (error) {
    const errorCode = sanitizedErrorCode(error);
    if (!state) {
      return { result: "FAILED_PRE_MIGRATION", exit_code: 1, state: null, error_code: errorCode };
    }
    const migrationStarted = ["MIGRATION_STARTED", "MIGRATIONS_APPLIED", "SERVICES_STARTED", "HEALTHCHECKING"].includes(state);
    if (!migrationStarted) {
      if (configMayHaveChanged) {
        try {
          await operations.restoreConfig(plan, transactionId, { preserveDatabase: true });
          await operations.startServices(plan.source_images);
        } catch {
          await record("MANUAL_RECOVERY_REQUIRED", { error_code: "PRE_MIGRATION_RESTORE_FAILED" });
          return { result: "MANUAL_RECOVERY_REQUIRED", exit_code: 1, state, error_code: "PRE_MIGRATION_RESTORE_FAILED" };
        }
      }
      await record("FAILED_PRE_MIGRATION", { error_code: errorCode });
      return { result: "FAILED_PRE_MIGRATION", exit_code: 1, state, error_code: errorCode };
    }

    if (schemaAfterMigration === null && operations.inspectSchema) {
      try { schemaAfterMigration = await operations.inspectSchema(plan); } catch {}
    }
    const knownCompatibleSchema = typeof schemaAfterMigration === "string" &&
      /^\d{4,6}$/.test(schemaAfterMigration) &&
      Number(schemaAfterMigration) >= Number(plan.source_schema) &&
      Number(schemaAfterMigration) <= Number(plan.target_schema);
    if (plan.rollback_compatible && knownCompatibleSchema) {
      try {
        await record("ROLLBACK_IN_PROGRESS", { error_code: errorCode });
        await operations.restoreConfig(plan, transactionId, { preserveDatabase: true, schema: schemaAfterMigration });
        await operations.startServices(plan.source_images);
        assertHealthy(await operations.checkHealth(plan, { current: true, rollback: true }));
        await operations.recordRolledBackState(plan, transactionId, schemaAfterMigration);
        await record("ROLLED_BACK", { error_code: errorCode, schema_after: schemaAfterMigration, database_action: "PRESERVED_NEW_SCHEMA" });
        return { result: "ROLLED_BACK", exit_code: 1, state, error_code: errorCode, schema_after: schemaAfterMigration };
      } catch {
        if (state === "ROLLBACK_IN_PROGRESS") {
          await record("MANUAL_RECOVERY_REQUIRED", { error_code: "AUTOMATIC_ROLLBACK_FAILED", schema_after: schemaAfterMigration });
        }
        return { result: "MANUAL_RECOVERY_REQUIRED", exit_code: 1, state, error_code: "AUTOMATIC_ROLLBACK_FAILED", schema_after: schemaAfterMigration };
      }
    }
    if (state !== "FAILED_POST_MIGRATION") await record("FAILED_POST_MIGRATION", { error_code: errorCode, schema_after: schemaAfterMigration });
    await record("MANUAL_RECOVERY_REQUIRED", {
      error_code: errorCode,
      schema_after: schemaAfterMigration,
      database_action: "OPERATOR_INTERVENTION_REQUIRED",
    });
    return { result: "MANUAL_RECOVERY_REQUIRED", exit_code: 1, state, error_code: errorCode, schema_after: schemaAfterMigration };
  }
}

function main(argv) {
  const [command, installDir, ...rest] = argv;
  if (command === "journal") {
    const [transactionId, state, sourceVersion, targetVersion, sourceSchema, targetSchema, errorCode = "", schemaAfter = "", exitCode = "", metadataJson = ""] = rest;
    let metadata = {};
    if (metadataJson) {
      try { metadata = JSON.parse(metadataJson); } catch { fail("UPDATE_JOURNAL_METADATA_INVALID"); }
      if (!isObject(metadata)) fail("UPDATE_JOURNAL_METADATA_INVALID");
    }
    const event = {
      ...metadata,
      transaction_id: transactionId,
      state,
      source_version: sourceVersion,
      target_version: targetVersion,
      source_schema: sourceSchema,
      target_schema: targetSchema,
      error_code: errorCode || undefined,
      schema_after: schemaAfter || undefined,
      exit_code: exitCode === "" ? undefined : Number(exitCode),
    };
    const next = writeUpdateJournal(installDir, event);
    process.stdout.write(`${next.state}\n`);
    return;
  }
  if (command === "read-journal") {
    const journal = readUpdateJournal(installDir);
    process.stdout.write(`${JSON.stringify(journal)}\n`);
    return;
  }
  if (command === "validate-migrations") {
    const [manifestJson] = rest;
    let status;
    let manifest;
    try {
      status = JSON.parse(fs.readFileSync(0, "utf8"));
      manifest = JSON.parse(manifestJson);
    } catch {
      fail("MIGRATION_PLAN_EVIDENCE_INVALID");
    }
    process.stdout.write(`${JSON.stringify(validateTargetMigrationPlan(status, manifest))}\n`);
    return;
  }
  if (command === "read-checkpoint") {
    const [transactionId, mode = ""] = rest;
    if (mode && mode !== "--test-mode") fail("TEST_MODE_INVALID");
    process.stdout.write(`${JSON.stringify(readReleaseCheckpoint(installDir, transactionId, { allowTestMode: mode === "--test-mode" }))}\n`);
    return;
  }
  if (command === "plan") {
    const [confirmation = "", mode = ""] = rest;
    if (mode && mode !== "--test-mode") fail("TEST_MODE_INVALID");
    let input;
    try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch { fail("UPDATE_PLAN_INPUT_INVALID"); }
    const state = readJsonFile(path.join(path.resolve(installDir), "state", "release.json"), "CURRENT_RELEASE_STATE_INVALID");
    const status = input?.migrator_status;
    if (!isObject(status) || status.state_type !== "TRACKED_INSTALLATION" ||
        status.schema_evidence_valid !== true || typeof status.current_schema !== "string") {
      fail("CURRENT_DATABASE_SCHEMA_UNAVAILABLE");
    }
    const result = createUpdatePlan({
      currentRelease: state,
      currentImages: input.current_images,
      currentSchema: status.current_schema,
      manifest: input.verified_manifest,
      confirmIrreversibleReleaseId: confirmation,
      allowTestMode: mode === "--test-mode",
      allowLegacySource: input.legacy_source === true,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "checkpoint") {
    const [transactionId, mode = ""] = rest;
    if (mode && mode !== "--test-mode") fail("TEST_MODE_INVALID");
    let input;
    try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch { fail("CHECKPOINT_INPUT_INVALID"); }
    const result = createReleaseCheckpoint(installDir, transactionId, {
      currentImages: input?.current_images,
      runtimeConfig: input?.runtime_config,
      verifiedManifest: input?.verified_manifest,
      signedManifest: input?.signed_manifest,
      plan: input?.plan,
      allowTestMode: mode === "--test-mode",
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "record-db") {
    const [transactionId] = rest;
    let input;
    try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch { fail("DATABASE_BACKUP_METADATA_INVALID"); }
    recordCheckpointDatabaseBackup(installDir, transactionId, input).then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch((error) => {
      process.stderr.write(`${sanitizedErrorCode(error)}\n`);
      process.exitCode = 1;
    });
    return;
  }
  if (command === "verify-db") {
    const [transactionId] = rest;
    verifyCheckpointDatabaseBackup(installDir, transactionId).then((result) => {
      process.stdout.write(`${JSON.stringify(result)}\n`);
    }).catch((error) => {
      process.stderr.write(`${sanitizedErrorCode(error)}\n`);
      process.exitCode = 1;
    });
    return;
  }
  if (command === "restore") {
    const [transactionId, schema = "", mode = ""] = rest;
    if (mode && mode !== "--test-mode") fail("TEST_MODE_INVALID");
    const result = restoreReleaseCheckpoint(installDir, transactionId, schema || undefined, { allowTestMode: mode === "--test-mode" });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "commit-state") {
    const [manifestPath, transactionId = "", schema = "", databaseBackupPath = "", backupSha256 = "", mode = ""] = rest;
    if (mode && mode !== "--test-mode") fail("TEST_MODE_INVALID");
    let input;
    try { input = JSON.parse(fs.readFileSync(0, "utf8")); } catch { fail("RELEASE_STATE_INPUT_INVALID"); }
    const result = commitReleaseState(installDir, manifestPath, input?.verified_manifest, {
      installationId: input?.installation_id,
      transactionId: transactionId || null,
      schemaVersion: schema,
      databaseBackupPath: databaseBackupPath || null,
      databaseBackupSha256: backupSha256 || null,
      allowTestMode: mode === "--test-mode",
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stderr.write("usage: release-update-transaction.mjs journal <install-dir> <transaction-id> <state> <source-version> <target-version> <source-schema> <target-schema> [error-code]\n");
  process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    const code = sanitizedErrorCode(error);
    process.stderr.write(`${code}\n`);
    process.exitCode = 1;
  }
}
