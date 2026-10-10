#!/usr/bin/env node
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const IMAGE_KEYS = ["app", "worker", "scheduler", "voice_agent", "migrator"];
const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
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

function validatePayload(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("INVALID_MANIFEST_PAYLOAD");
  }

  for (const field of ["release_version", "min_installer_version", "schema_target", "released_at"]) {
    if (typeof payload[field] !== "string" || payload[field].length === 0) {
      throw new Error(`INVALID_MANIFEST_FIELD:${field}`);
    }
  }
  try {
    parseSemVer(payload.release_version);
    parseSemVer(payload.min_installer_version);
  } catch {
    throw new Error("INVALID_MANIFEST_VERSION");
  }
  if (Number.isNaN(Date.parse(payload.released_at))) {
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
  if (!Array.isArray(payload.architectures) || payload.architectures.length === 0 ||
      payload.architectures.some((arch) => !["amd64", "arm64"].includes(arch))) {
    throw new Error("INVALID_MANIFEST_FIELD:architectures");
  }
  const runtimeArch = process.arch === "x64" ? "amd64" : process.arch === "arm64" ? "arm64" : "unsupported";
  if (!payload.architectures.includes(runtimeArch)) throw new Error("UNSUPPORTED_MANIFEST_ARCHITECTURE");
  if (!payload.images || typeof payload.images !== "object" || Array.isArray(payload.images)) {
    throw new Error("INVALID_MANIFEST_FIELD:images");
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
    if (typeof image.tag !== "string" || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/.test(image.tag)) {
      throw new Error(`INVALID_MANIFEST_TAG:${key}`);
    }
    if (typeof image.digest !== "string" || !SHA256_RE.test(image.digest)) {
      throw new Error(`INVALID_MANIFEST_DIGEST:${key}`);
    }
    imageRefs[key] = `${image.repository}@${image.digest}`;
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

export function verifyReleaseManifestDocument(manifest, trustRoot, installerVersion) {
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
      imageRefs = validatePayload(manifest.payload);
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
        release_version: manifest.payload.release_version,
        min_installer_version: manifest.payload.min_installer_version,
        schema_target: manifest.payload.schema_target,
        compatibility: {
          min_schema: manifest.payload.compatibility.min_schema,
          max_schema: manifest.payload.compatibility.max_schema,
        },
        images: imageRefs,
      },
    };
  } catch {
    return { valid: false, reason: "INVALID_MANIFEST_DOCUMENT" };
  }
}

function main() {
  const [, , command, manifestPath, trustRoot, installerVersion, statusPath] = process.argv;
  if ((command !== "verify" && command !== "schema-check") || !manifestPath || !trustRoot || !installerVersion ||
      (command === "schema-check" && !statusPath)) {
    process.stderr.write("usage: verify-release-manifest.mjs verify <manifest.json> <trust-root-dir> <installer-version>\n");
    process.stderr.write("   or: verify-release-manifest.mjs schema-check <manifest.json> <trust-root-dir> <installer-version> <status.json|->\n");
    process.exitCode = 2;
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch {
    process.stderr.write("INVALID_MANIFEST_DOCUMENT\n");
    process.exitCode = 1;
    return;
  }
  const verification = verifyReleaseManifestDocument(manifest, trustRoot, installerVersion);
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
