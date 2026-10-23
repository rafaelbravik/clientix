#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_KEYS = ["app", "worker", "scheduler", "voice_agent", "migrator"];
const OPTIONAL_IMAGE_KEYS = ["caddy"];
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const REQUIRED_BACKUPS = ["configuration", "database", "release_state", "image_state"];
const OFFICIAL_KEY_ID = "clientix-release-2026-01";
const PRODUCTION_REPOSITORIES = {
  app: "ghcr.io/rafaelbravik/clientix-app",
  worker: "ghcr.io/rafaelbravik/clientix-worker",
  scheduler: "ghcr.io/rafaelbravik/clientix-scheduler",
  voice_agent: "ghcr.io/rafaelbravik/clientix-voice-agent",
  migrator: "ghcr.io/rafaelbravik/clientix-migrator",
  caddy: "ghcr.io/rafaelbravik/clientix-ingress",
};
const TEST_KEY_ID = "clientix-test-release-fixture";
const NUMERIC_ID = "(?:0|[1-9][0-9]*)";
const NON_NUMERIC_ID = "(?:[0-9]*[A-Za-z-][0-9A-Za-z-]*)";
const PRE_RELEASE_ID = `(?:${NUMERIC_ID}|${NON_NUMERIC_ID})`;
const SEMVER_RE = new RegExp(
  `^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(${PRE_RELEASE_ID}(?:\\.${PRE_RELEASE_ID})*))?(?:\\+([0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*))?$`,
);

export function parseSemVer(version) {
  if (typeof version !== "string") throw new Error("INVALID_SEMVER");
  const match = SEMVER_RE.exec(version);
  if (!match || match[0] !== version) throw new Error("INVALID_SEMVER");
  return {
    major: BigInt(match[1]),
    minor: BigInt(match[2]),
    patch: BigInt(match[3]),
    prerelease: match[4] ? match[4].split(".") : null,
  };
}

export function compareSemVer(left, right) {
  const a = parseSemVer(left);
  const b = parseSemVer(right);
  for (const field of ["major", "minor", "patch"]) {
    if (a[field] < b[field]) return -1;
    if (a[field] > b[field]) return 1;
  }
  if (a.prerelease === null && b.prerelease === null) return 0;
  if (a.prerelease === null) return 1;
  if (b.prerelease === null) return -1;
  const sharedLength = Math.min(a.prerelease.length, b.prerelease.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftId = a.prerelease[index];
    const rightId = b.prerelease[index];
    if (leftId === rightId) continue;
    const leftNumeric = /^\d+$/.test(leftId);
    const rightNumeric = /^\d+$/.test(rightId);
    if (leftNumeric && rightNumeric) {
      const leftNumber = BigInt(leftId);
      const rightNumber = BigInt(rightId);
      if (leftNumber < rightNumber) return -1;
      if (leftNumber > rightNumber) return 1;
      continue;
    }
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return leftId < rightId ? -1 : 1;
  }
  if (a.prerelease.length < b.prerelease.length) return -1;
  if (a.prerelease.length > b.prerelease.length) return 1;
  return 0;
}

function parseSchemaSequence(value) {
  if (typeof value !== "string" || !/^\d{4,6}$/.test(value) || value.length !== value.trim().length) {
    throw new Error("INVALID_MANIFEST_SCHEMA_RANGE");
  }
  return Number(value);
}

function canonicalize(value) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object") {
    const fields = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize(value[key])}`);
    return `{${fields.join(",")}}`;
  }
  throw new TypeError("unsupported JSON value");
}

function validatePayload(payload, signerKeyId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("INVALID_MANIFEST_PAYLOAD");
  }

  for (const field of ["release_id", "release_version", "min_installer_version", "schema_target", "released_at", "created_at"]) {
    if (typeof payload[field] !== "string" || payload[field].length === 0) {
      throw new Error(`INVALID_MANIFEST_FIELD:${field}`);
    }
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(payload.release_id)) {
    throw new Error("INVALID_MANIFEST_RELEASE_ID");
  }
  try {
    parseSemVer(payload.release_version);
    parseSemVer(payload.min_installer_version);
  } catch {
    throw new Error("INVALID_MANIFEST_VERSION");
  }
  if (Number.isNaN(Date.parse(payload.released_at)) || Number.isNaN(Date.parse(payload.created_at)) ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(payload.created_at)) {
    throw new Error("INVALID_MANIFEST_SCHEMA_OR_DATE");
  }
  const targetSchema = parseSchemaSequence(payload.schema_target);
  if (!payload.compatibility || typeof payload.compatibility !== "object" || Array.isArray(payload.compatibility)) {
    throw new Error("INVALID_MANIFEST_COMPATIBILITY");
  }
  const minSchema = parseSchemaSequence(payload.compatibility.min_schema);
  const maxSchema = parseSchemaSequence(payload.compatibility.max_schema);
  if (minSchema > maxSchema || maxSchema > targetSchema) {
    throw new Error("INVALID_MANIFEST_SCHEMA_RANGE");
  }
  if (!Array.isArray(payload.compatibility.compatible_previous_apps) ||
      payload.compatibility.compatible_previous_apps.some((version) => {
        try { parseSemVer(version); return false; } catch { return true; }
      })) {
    throw new Error("INVALID_MANIFEST_COMPATIBILITY");
  }
  if (!Array.isArray(payload.architectures) || payload.architectures.length === 0 ||
      payload.architectures.some((arch) => !["amd64", "arm64"].includes(arch))) {
    throw new Error("INVALID_MANIFEST_FIELD:architectures");
  }
  const runtimeArch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "unsupported";
  if (!payload.architectures.includes(runtimeArch)) throw new Error("UNSUPPORTED_MANIFEST_ARCHITECTURE");
  if (!payload.images || typeof payload.images !== "object" || Array.isArray(payload.images)) {
    throw new Error("INVALID_MANIFEST_FIELD:images");
  }
  const allowedImageKeys = new Set([...IMAGE_KEYS, ...OPTIONAL_IMAGE_KEYS]);
  if (Object.keys(payload.images).some((key) => !allowedImageKeys.has(key))) {
    throw new Error("INVALID_MANIFEST_IMAGE_SET");
  }

  const imageRefs = {};
  for (const key of IMAGE_KEYS) {
    const image = payload.images[key];
    if (!image || typeof image !== "object" || Array.isArray(image)) {
      throw new Error(`INVALID_MANIFEST_IMAGE:${key}`);
    }
    const validRepository = typeof image.repository === "string" &&
      /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(image.repository);
    if (!validRepository) {
      throw new Error(`INVALID_MANIFEST_REPOSITORY:${key}`);
    }
    if (signerKeyId !== TEST_KEY_ID && image.repository !== PRODUCTION_REPOSITORIES[key]) {
      throw new Error(`UNAUTHORIZED_IMAGE_REPOSITORY:${key}`);
    }
    if (typeof image.tag !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(image.tag)) {
      throw new Error(`INVALID_MANIFEST_TAG:${key}`);
    }
    if (typeof image.digest !== "string" || !SHA256_RE.test(image.digest)) {
      throw new Error(`INVALID_MANIFEST_DIGEST:${key}`);
    }
    imageRefs[key] = `${image.repository}@${image.digest}`;
  }
  for (const key of OPTIONAL_IMAGE_KEYS) {
    if (payload.images[key] === undefined) continue;
    const image = payload.images[key];
    if (!image || typeof image !== "object" || Array.isArray(image)) {
      throw new Error(`INVALID_MANIFEST_IMAGE:${key}`);
    }
    const validRepository = typeof image.repository === "string" &&
      /^(?:[a-z0-9]+(?:[.-][a-z0-9]+)*(?::[0-9]+)?\/)?[a-z0-9]+(?:[._-][a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*$/.test(image.repository);
    if (!validRepository) {
      throw new Error(`INVALID_MANIFEST_REPOSITORY:${key}`);
    }
    if (signerKeyId !== TEST_KEY_ID && image.repository !== PRODUCTION_REPOSITORIES[key]) {
      throw new Error(`UNAUTHORIZED_IMAGE_REPOSITORY:${key}`);
    }
    if (typeof image.tag !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(image.tag)) {
      throw new Error(`INVALID_MANIFEST_TAG:${key}`);
    }
    if (typeof image.digest !== "string" || !SHA256_RE.test(image.digest)) {
      throw new Error(`INVALID_MANIFEST_DIGEST:${key}`);
    }
    imageRefs[key] = `${image.repository}@${image.digest}`;
  }

  if (!payload.migration || typeof payload.migration !== "object" || Array.isArray(payload.migration) ||
      !["none", "expand", "contract", "irreversible"].includes(payload.migration.strategy) ||
      !Array.isArray(payload.migration.ids) ||
      payload.migration.ids.some((id) => typeof id !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(id))) {
    throw new Error("INVALID_MANIFEST_MIGRATION_METADATA");
  }
  if (payload.migration.strategy === "none" && payload.migration.ids.length !== 0) {
    throw new Error("INVALID_MANIFEST_MIGRATION_METADATA");
  }
  if (payload.migration.strategy !== "none" && payload.migration.ids.length === 0) {
    throw new Error("INVALID_MANIFEST_MIGRATION_METADATA");
  }

  const rollback = payload.rollback;
  if (!rollback || typeof rollback !== "object" || Array.isArray(rollback) ||
      typeof rollback.application !== "boolean" || typeof rollback.configuration !== "boolean" ||
      !["preserve_schema", "operator"].includes(rollback.database_strategy) ||
      !Array.isArray(rollback.compatible_previous_apps) ||
      rollback.compatible_previous_apps.some((version) => {
        try { parseSemVer(version); return false; } catch { return true; }
      })) {
    throw new Error("INVALID_MANIFEST_ROLLBACK_METADATA");
  }
  if (["contract", "irreversible"].includes(payload.migration.strategy) && rollback.database_strategy !== "operator") {
    throw new Error("INVALID_MANIFEST_ROLLBACK_METADATA");
  }
  if (["none", "expand"].includes(payload.migration.strategy) && rollback.database_strategy !== "preserve_schema") {
    throw new Error("INVALID_MANIFEST_ROLLBACK_METADATA");
  }

  if (!Array.isArray(payload.required_backups) ||
      REQUIRED_BACKUPS.some((backup) => !payload.required_backups.includes(backup)) ||
      payload.required_backups.some((backup) => !REQUIRED_BACKUPS.includes(backup)) ||
      new Set(payload.required_backups).size !== payload.required_backups.length) {
    throw new Error("INVALID_MANIFEST_REQUIRED_BACKUPS");
  }
  const notes = payload.release_notes;
  if (!notes || typeof notes !== "object" || Array.isArray(notes) ||
      Object.keys(notes).some((key) => !["id", "locale", "summary"].includes(key)) ||
      typeof notes.id !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(notes.id) ||
      typeof notes.locale !== "string" || !/^[a-z]{2}-[A-Z]{2}$/.test(notes.locale) ||
      typeof notes.summary !== "string" || notes.summary.length > 240 || /[\u0000-\u001f]/.test(notes.summary)) {
    throw new Error("INVALID_MANIFEST_RELEASE_NOTES_METADATA");
  }
  return imageRefs;
}

export function evaluateSchemaCompatibility(payload, migratorStatus) {
  if (!migratorStatus || typeof migratorStatus !== "object" || Array.isArray(migratorStatus)) {
    return { allowed: false, reason: "MIGRATOR_STATUS_INVALID" };
  }
  if (migratorStatus.target_baseline !== payload.schema_target) {
    return { allowed: false, reason: "MIGRATOR_SCHEMA_TARGET_MISMATCH" };
  }
  if (migratorStatus.state_type === "FRESH_DATABASE") {
    if (migratorStatus.schema_evidence_valid !== true || migratorStatus.current_schema !== null) {
      return { allowed: false, reason: "MIGRATOR_STATUS_INVALID" };
    }
    return { allowed: true, current_schema: null, schema_target: payload.schema_target };
  }
  if (migratorStatus.state_type !== "TRACKED_INSTALLATION" || migratorStatus.schema_evidence_valid !== true) {
    return { allowed: false, reason: "CURRENT_SCHEMA_UNAVAILABLE" };
  }

  let currentSchema;
  let minSchema;
  let maxSchema;
  let targetSchema;
  try {
    currentSchema = parseSchemaSequence(migratorStatus.current_schema);
    minSchema = parseSchemaSequence(payload.compatibility?.min_schema);
    maxSchema = parseSchemaSequence(payload.compatibility?.max_schema);
    targetSchema = parseSchemaSequence(payload.schema_target);
  } catch {
    return { allowed: false, reason: "CURRENT_SCHEMA_UNAVAILABLE" };
  }
  if (currentSchema < minSchema) return { allowed: false, reason: "SCHEMA_TOO_OLD_FOR_DIRECT_UPDATE" };
  if (currentSchema > maxSchema) return { allowed: false, reason: "SCHEMA_NEWER_THAN_RELEASE" };
  if (targetSchema < currentSchema) return { allowed: false, reason: "SCHEMA_DOWNGRADE_UNSUPPORTED" };
  return {
    allowed: true,
    current_schema: String(currentSchema).padStart(4, "0"),
    schema_target: payload.schema_target,
  };
}

export function verifyReleaseManifestDocument(manifest, trustRoot, installerVersion, { testMode = false } = {}) {
  try {
    if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
      return { valid: false, reason: "INVALID_MANIFEST_DOCUMENT" };
    }
    if (typeof manifest.signature !== "string" || !/^[A-Za-z0-9_-]{86}$/.test(manifest.signature)) {
      return { valid: false, reason: "MANIFEST_SIGNATURE_MISSING_OR_MALFORMED" };
    }
    if (manifest.algorithm !== "Ed25519" || manifest.purpose !== "release_manifest") {
      return { valid: false, reason: "UNSUPPORTED_MANIFEST_SIGNATURE" };
    }
    if (typeof manifest.keyId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/.test(manifest.keyId)) {
      return { valid: false, reason: "INVALID_MANIFEST_KEY_ID" };
    }
    if (manifest.keyId !== OFFICIAL_KEY_ID && !(testMode && manifest.keyId === TEST_KEY_ID)) {
      return { valid: false, reason: "MANIFEST_KEY_UNTRUSTED" };
    }
    if (!trustRoot || !fs.existsSync(trustRoot)) {
      return { valid: false, reason: "MANIFEST_TRUST_ROOT_UNAVAILABLE" };
    }
    const keyPath = path.resolve(trustRoot, `${manifest.keyId}.pem`);
    if (path.dirname(keyPath) !== path.resolve(trustRoot) || !fs.existsSync(keyPath)) {
      return { valid: false, reason: "MANIFEST_KEY_UNTRUSTED" };
    }
    const keyStat = fs.lstatSync(keyPath);
    if (!keyStat.isFile() || keyStat.isSymbolicLink()) {
      return { valid: false, reason: "MANIFEST_KEY_UNTRUSTED" };
    }

    const publicKey = crypto.createPublicKey(fs.readFileSync(keyPath, "utf8"));
    if (publicKey.asymmetricKeyType !== "ed25519") {
      return { valid: false, reason: "MANIFEST_KEY_ALGORITHM_INVALID" };
    }
    const signature = Buffer.from(manifest.signature, "base64url");
    if (signature.length !== 64 || signature.toString("base64url") !== manifest.signature) {
      return { valid: false, reason: "MANIFEST_SIGNATURE_MALFORMED" };
    }
    let valid = false;
    try {
      // Authenticate the raw payload before reading semantic or compatibility fields.
      valid = crypto.verify(null, Buffer.from(canonicalize(manifest.payload), "utf8"), publicKey, signature);
    } catch {
      return { valid: false, reason: "INVALID_MANIFEST_PAYLOAD" };
    }
    if (!valid) return { valid: false, reason: "MANIFEST_SIGNATURE_INVALID" };

    let imageRefs;
    try {
      imageRefs = validatePayload(manifest.payload, manifest.keyId);
    } catch (error) {
      return { valid: false, reason: error instanceof Error ? error.message : "INVALID_MANIFEST_DOCUMENT" };
    }
    let installerComparison;
    try {
      installerComparison = compareSemVer(installerVersion, manifest.payload.min_installer_version);
    } catch {
      return { valid: false, reason: "INVALID_INSTALLER_VERSION" };
    }
    if (installerComparison < 0) {
      return { valid: false, reason: "INSTALLER_VERSION_UNSUPPORTED" };
    }

    return {
      valid: true,
      result: {
        payload_sha256: crypto.createHash("sha256").update(canonicalize(manifest.payload), "utf8").digest("hex"),
        release_id: manifest.payload.release_id,
        release_version: manifest.payload.release_version,
        created_at: manifest.payload.created_at,
        released_at: manifest.payload.released_at,
        min_installer_version: manifest.payload.min_installer_version,
        schema_target: manifest.payload.schema_target,
        compatibility: {
          min_schema: manifest.payload.compatibility.min_schema,
          max_schema: manifest.payload.compatibility.max_schema,
          compatible_previous_apps: manifest.payload.compatibility.compatible_previous_apps,
        },
        migration: manifest.payload.migration,
        rollback: manifest.payload.rollback,
        required_backups: manifest.payload.required_backups,
        release_notes: manifest.payload.release_notes,
        signer_key_id: manifest.keyId,
        signature: manifest.signature,
        images: imageRefs,
      },
    };
  } catch {
    return { valid: false, reason: "INVALID_MANIFEST_DOCUMENT" };
  }
}

function main() {
  const args = process.argv.slice(2);
  const testMode = args.at(-1) === "--test-mode";
  if (testMode) args.pop();
  const [command, manifestPath, trustRoot, installerVersion, statusPath] = args;
  if ((command !== "verify" && command !== "schema-check") || !manifestPath || !trustRoot || !installerVersion ||
      (command === "schema-check" && !statusPath)) {
    process.stderr.write("usage: verify-release-manifest.mjs verify <manifest.json> <trust-root-dir> <installer-version>\n");
    process.stderr.write("   or: verify-release-manifest.mjs schema-check <manifest.json> <trust-root-dir> <installer-version> <status.json|->\n");
    process.exitCode = 2;
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestPath === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(manifestPath, "utf8"));
  } catch {
    process.stderr.write("INVALID_MANIFEST_DOCUMENT\n");
    process.exitCode = 1;
    return;
  }
  const verification = verifyReleaseManifestDocument(manifest, trustRoot, installerVersion, { testMode });
  if (!verification.valid) {
    process.stderr.write(verification.reason + "\n");
    process.exitCode = 1;
    return;
  }
  if (command === "verify") {
    process.stdout.write(JSON.stringify(verification.result) + "\n");
    return;
  }

  let migratorStatus;
  try {
    const statusJson = statusPath === "-" ? fs.readFileSync(0, "utf8") : fs.readFileSync(statusPath, "utf8");
    migratorStatus = JSON.parse(statusJson);
  } catch {
    process.stderr.write("MIGRATOR_STATUS_INVALID\n");
    process.exitCode = 1;
    return;
  }
  const compatibility = evaluateSchemaCompatibility(manifest.payload, migratorStatus);
  if (!compatibility.allowed) {
    process.stderr.write(compatibility.reason + "\n");
    process.exitCode = 1;
    return;
  }
  process.stdout.write(JSON.stringify(compatibility) + "\n");
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main();
}
