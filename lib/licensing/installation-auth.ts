import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { isValidInstallationId } from "./installation-id";

/**
 * Canonically validates whether an installation ID matches the Clientix format:
 * `inst_<UUIDv4>`
 */
export const isValidCanonicalInstallationId = isValidInstallationId;

/**
 * Standard Key Formats:
 * Private Key: PKCS8 PEM string
 * Public Key: SPKI PEM string
 */
export interface InstallationKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
}

/**
 * Generates a brand new Ed25519 keypair for the installation using Node.js crypto CSPRNG.
 */
export function generateInstallationKeyPair(): InstallationKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519", {
    publicKeyEncoding: {
      type: "spki",
      format: "pem",
    },
    privateKeyEncoding: {
      type: "pkcs8",
      format: "pem",
    },
  });

  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
  };
}

/**
 * Validates whether a given PEM string is a valid Ed25519 PKCS8 private key.
 */
export function isValidInstallationPrivateKey(pem: string): boolean {
  if (typeof pem !== "string" || !pem.includes("-----BEGIN PRIVATE KEY-----")) {
    return false;
  }
  try {
    const key = crypto.createPrivateKey(pem);
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

/**
 * Validates whether a given PEM string is a valid Ed25519 SPKI public key.
 */
export function isValidInstallationPublicKey(pem: string): boolean {
  if (typeof pem !== "string" || !pem.includes("-----BEGIN PUBLIC KEY-----")) {
    return false;
  }
  try {
    const key = crypto.createPublicKey(pem);
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
}

/**
 * Computes canonical SHA-256 fingerprint (64 hex characters) of a public key DER representation.
 */
export function computePublicKeyFingerprint(pem: string): string {
  const key = crypto.createPublicKey(pem);
  const der = key.export({ type: "spki", format: "der" });
  return crypto.createHash("sha256").update(der).digest("hex");
}

/**
 * Derives the SPKI public key PEM corresponding to a PKCS8 private key PEM.
 */
export function deriveInstallationPublicKey(privateKeyPem: string): string {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  const publicKey = crypto.createPublicKey(privateKey);
  return publicKey.export({ type: "spki", format: "pem" }) as string;
}

/**
 * Default production file path for persistent installation private key.
 */
export const DEFAULT_INSTALLATION_KEY_PATH = "/opt/clientix/state/installation.key";

/**
 * Loads an existing installation private key or creates and persists one atomically with mode 0600.
 *
 * Rules:
 * - If valid key exists: reuse existing.
 * - If file is missing: atomically generate and save with mode 0600.
 * - If file exists but is empty, truncated, or invalid: THROW EXPLICIT ERROR (Fail closed; NEVER regenerate silently).
 */
export async function getOrCreateInstallationPrivateKey(
  targetPath: string = DEFAULT_INSTALLATION_KEY_PATH,
): Promise<string> {
  try {
    const content = await fs.readFile(/*turbopackIgnore: true*/ targetPath, "utf-8");
    const trimmed = content.trim();

    if (trimmed.length === 0) {
      throw new Error(
        `Installation private key file exists but is empty or truncated ("${targetPath}"). Fail closed.`,
      );
    }

    if (!isValidInstallationPrivateKey(trimmed)) {
      throw new Error(
        `Installation private key file exists but is malformed or corrupted ("${targetPath}"). Fail closed.`,
      );
    }

    return trimmed;
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      throw err;
    }
  }

  // File does not exist: generate fresh keypair and persist atomically
  const { privateKeyPem } = generateInstallationKeyPair();
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });

  const tempPath = `${targetPath}.tmp.${crypto.randomBytes(8).toString("hex")}`;
  try {
    await fs.writeFile(tempPath, `${privateKeyPem.trim()}\n`, {
      encoding: "utf-8",
      mode: 0o600,
    });
    // Atomic rename
    await fs.rename(tempPath, targetPath);
    // Explicitly chmod target in case rename preserved parent umask peculiarities
    await fs.chmod(targetPath, 0o600).catch(() => {});
  } catch (writeErr) {
    await fs.unlink(tempPath).catch(() => {});
    throw writeErr;
  }

  return privateKeyPem.trim();
}

/** Creates (or resumes) a protected candidate key for vendor-authorized recovery. */
export async function getOrCreatePendingInstallationKeyPair(
  targetPath: string = DEFAULT_INSTALLATION_KEY_PATH,
): Promise<InstallationKeyPair> {
  const pendingPath = `${targetPath}.pending`;
  try {
    const privateKeyPem = (await fs.readFile(pendingPath, "utf-8")).trim();
    if (!isValidInstallationPrivateKey(privateKeyPem))
      throw new Error("Pending installation key is invalid.");
    return {
      privateKeyPem,
      publicKeyPem: deriveInstallationPublicKey(privateKeyPem).trim(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const pair = generateInstallationKeyPair();
  await fs.mkdir(path.dirname(targetPath), { recursive: true });
  try {
    const handle = await fs.open(pendingPath, "wx", 0o600);
    try {
      await handle.writeFile(`${pair.privateKeyPem.trim()}\n`, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.chmod(pendingPath, 0o600).catch(() => undefined);
    return {
      privateKeyPem: pair.privateKeyPem.trim(),
      publicKeyPem: pair.publicKeyPem.trim(),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    return getOrCreatePendingInstallationKeyPair(targetPath);
  }
}

/** Atomically makes an already-authorized candidate key the installation key. */
export async function commitPendingInstallationPrivateKey(
  targetPath: string = DEFAULT_INSTALLATION_KEY_PATH,
): Promise<void> {
  const pendingPath = `${targetPath}.pending`;
  const candidate = (await fs.readFile(pendingPath, "utf-8")).trim();
  if (!isValidInstallationPrivateKey(candidate))
    throw new Error("Pending installation key is invalid.");
  await fs.rename(pendingPath, targetPath);
  await fs.chmod(targetPath, 0o600).catch(() => undefined);
}

/**
 * Activation Code Primitives:
 * Minimum 256 bits of entropy (32 CSPRNG bytes).
 * Canonical format: `ACT_${base64url}`
 */
export function generateActivationCode(): string {
  const bytes = crypto.randomBytes(32);
  const b64url = bytes
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return `ACT_${b64url}`;
}

/**
 * Derives the HMAC-SHA256 digest of an activation code using a secret pepper.
 * Returns a 64-char hexadecimal string.
 */
export function deriveActivationCodeDigest(rawCode: string, pepper: string): string {
  if (!rawCode || typeof rawCode !== "string") {
    throw new Error("Activation code must be a non-empty string");
  }
  if (!pepper || typeof pepper !== "string") {
    throw new Error("Pepper must be a non-empty secret string");
  }

  return crypto.createHmac("sha256", pepper).update(rawCode.trim(), "utf-8").digest("hex");
}

/**
 * Timing-safe comparison of activation code digests.
 */
export function timingSafeEqualDigests(digestA: string, digestB: string): boolean {
  if (typeof digestA !== "string" || typeof digestB !== "string") {
    return false;
  }
  const bufA = Buffer.from(digestA, "utf-8");
  const bufB = Buffer.from(digestB, "utf-8");
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Canonical Request Signing Primitives:
 */

/**
 * Normalizes an HTTP URL path:
 * - Extracts pathname and sorted query parameters
 * - Strips redundant slashes and trailing slashes (except root "/")
 * - Percent-encodes deterministically
 */
export function normalizeCanonicalPath(rawPath: string): string {
  let pathname = rawPath;
  let search = "";

  const qIdx = rawPath.indexOf("?");
  if (qIdx !== -1) {
    pathname = rawPath.slice(0, qIdx);
    search = rawPath.slice(qIdx + 1);
  }

  // Normalize slashes
  pathname = pathname.replace(/\/+/g, "/");
  if (pathname.length > 1 && pathname.endsWith("/")) {
    pathname = pathname.slice(0, -1);
  }
  if (!pathname.startsWith("/")) {
    pathname = `/${pathname}`;
  }

  if (search.length === 0) {
    return pathname;
  }

  // Canonicalize query parameters: sort by key, then value
  const params = new URLSearchParams(search);
  params.sort();
  return `${pathname}?${params.toString()}`;
}

/**
 * Calculates SHA-256 of raw body bytes.
 * Returns 64-char hex string.
 */
export function computeRawBodySha256(body: string | Buffer | null | undefined): string {
  const hash = crypto.createHash("sha256");
  if (body) {
    if (Buffer.isBuffer(body)) {
      hash.update(body);
    } else {
      hash.update(Buffer.from(body, "utf-8"));
    }
  }
  return hash.digest("hex");
}

/**
 * Generates CSPRNG Nonce (16 bytes, hex encoded = 32 hex chars).
 */
export function generateRequestNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Builds the canonical string-to-sign for installation request authentication.
 * Delimiter: LF ('\n')
 * Fields in order:
 * 1. installation_id
 * 2. timestamp (Unix seconds string)
 * 3. nonce
 * 4. method (UPPERCASE)
 * 5. normalized_path
 * 6. body_sha256 (64 hex characters)
 */
export function buildInstallationStringToSign(params: {
  installationId: string;
  timestamp: number;
  nonce: string;
  method: string;
  path: string;
  bodySha256: string;
}): string {
  const method = params.method.toUpperCase();
  const normalizedPath = normalizeCanonicalPath(params.path);
  return [
    params.installationId,
    params.timestamp.toString(),
    params.nonce,
    method,
    normalizedPath,
    params.bodySha256,
  ].join("\n");
}

/**
 * Signs the request using the installation's Ed25519 private key.
 * Returns signature in base64url format.
 */
export function createInstallationRequestSignature(params: {
  installationId: string;
  timestamp: number;
  nonce: string;
  method: string;
  path: string;
  body?: string | Buffer | null;
  privateKeyPem: string;
}): string {
  const bodySha256 = computeRawBodySha256(params.body);
  const stringToSign = buildInstallationStringToSign({
    installationId: params.installationId,
    timestamp: params.timestamp,
    nonce: params.nonce,
    method: params.method,
    path: params.path,
    bodySha256,
  });

  const privateKey = crypto.createPrivateKey(params.privateKeyPem);
  const sigBuffer = crypto.sign(null, Buffer.from(stringToSign, "utf-8"), privateKey);

  return sigBuffer.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Verifier Interface for Replay Protection Nonces.
 */
export interface NonceStore {
  /**
   * Attempts to record a nonce. Returns true if successfully consumed, false if already seen / replayed.
   */
  consumeNonce(
    installationId: string,
    nonce: string,
    expiresAtUnixSeconds: number,
    currentUnixSeconds?: number,
  ): Promise<boolean>;
}

/**
 * In-memory NonceStore for tests and ephemeral use.
 */
export class MemoryNonceStore implements NonceStore {
  private seen = new Map<string, number>();

  async consumeNonce(
    installationId: string,
    nonce: string,
    expiresAtUnixSeconds: number,
    currentUnixSeconds?: number,
  ): Promise<boolean> {
    const now = currentUnixSeconds ?? Math.floor(Date.now() / 1000);
    // Cleanup expired nonces (only delete if expiresAt <= now)
    for (const [key, exp] of this.seen.entries()) {
      if (exp <= now) {
        this.seen.delete(key);
      }
    }

    const key = `${installationId}:${nonce}`;
    if (this.seen.has(key)) {
      return false; // Replayed
    }
    this.seen.set(key, expiresAtUnixSeconds);
    return true;
  }
}

export interface VerifyRequestParams {
  installationId: string;
  timestamp: number;
  nonce: string;
  method: string;
  path: string;
  body?: string | Buffer | null;
  signatureBase64url: string;
  publicKeyPem: string;
  nonceStore?: NonceStore;
  currentTimestampUnixSeconds?: number;
  allowedClockSkewSeconds?: number;
}

export type VerifyRequestResult =
  | { ok: true; code?: never }
  | {
      ok: false;
      code:
        | "INVALID_INSTALLATION_ID"
        | "INVALID_TIMESTAMP"
        | "REPLAY_DETECTED"
        | "INVALID_SIGNATURE"
        | "MALFORMED_REQUEST";
    };

/**
 * Verifies an incoming installation request signature, clock skew, and nonce.
 */
export async function verifyInstallationRequestSignature(
  params: VerifyRequestParams,
): Promise<VerifyRequestResult> {
  // 1. Validate installation_id format
  if (!isValidCanonicalInstallationId(params.installationId)) {
    return { ok: false, code: "INVALID_INSTALLATION_ID" };
  }

  // 2. Validate timestamp skew (default +-300 seconds)
  const now = params.currentTimestampUnixSeconds ?? Math.floor(Date.now() / 1000);
  const allowedSkew = params.allowedClockSkewSeconds ?? 300;

  if (Math.abs(now - params.timestamp) > allowedSkew) {
    return { ok: false, code: "INVALID_TIMESTAMP" };
  }

  // 3. Nonce verification against replay
  if (params.nonceStore) {
    const nonceExpiresAt = params.timestamp + allowedSkew + 60; // Retain until window definitively expires
    const consumed = await params.nonceStore.consumeNonce(
      params.installationId,
      params.nonce,
      nonceExpiresAt,
      now,
    );
    if (!consumed) {
      return { ok: false, code: "REPLAY_DETECTED" };
    }
  }

  // 4. Verify Ed25519 signature
  try {
    const bodySha256 = computeRawBodySha256(params.body);
    const stringToSign = buildInstallationStringToSign({
      installationId: params.installationId,
      timestamp: params.timestamp,
      nonce: params.nonce,
      method: params.method,
      path: params.path,
      bodySha256,
    });

    let b64 = params.signatureBase64url.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) {
      b64 += "=";
    }
    const sigBuffer = Buffer.from(b64, "base64");
    if (sigBuffer.length !== 64) {
      return { ok: false, code: "INVALID_SIGNATURE" };
    }

    const publicKey = crypto.createPublicKey(params.publicKeyPem);
    const isValid = crypto.verify(null, Buffer.from(stringToSign, "utf-8"), publicKey, sigBuffer);

    if (!isValid) {
      return { ok: false, code: "INVALID_SIGNATURE" };
    }

    return { ok: true };
  } catch {
    return { ok: false, code: "MALFORMED_REQUEST" };
  }
}

/**
 * Control Plane Temporal State Calculator:
 * Pure function that maps timestamps to temporal license states.
 * States: NOT_YET_VALID | VALID | GRACE | EXPIRED
 */
export type TemporalLicenseState = "NOT_YET_VALID" | "VALID" | "GRACE" | "EXPIRED";

export function resolveTemporalLicenseState(params: {
  validFrom: Date | string;
  expiresAt: Date | string | null;
  graceDays: number;
  now?: Date;
}): TemporalLicenseState {
  const currentDate = params.now ?? new Date();
  const currentMs = currentDate.getTime();

  const validFromMs =
    typeof params.validFrom === "string"
      ? Date.parse(params.validFrom)
      : params.validFrom.getTime();

  if (currentMs < validFromMs) {
    return "NOT_YET_VALID";
  }

  // If expiresAt is null => Perpetual license
  if (params.expiresAt === null) {
    return "VALID";
  }

  const expiresAtMs =
    typeof params.expiresAt === "string"
      ? Date.parse(params.expiresAt)
      : params.expiresAt.getTime();

  if (currentMs < expiresAtMs) {
    return "VALID";
  }

  // Check Grace period: [expires_at, grace_until) is GRACE, >= grace_until is EXPIRED
  const graceMs = params.graceDays * 24 * 60 * 60 * 1000;
  if (currentMs < expiresAtMs + graceMs) {
    return "GRACE";
  }

  return "EXPIRED";
}
