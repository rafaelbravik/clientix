import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { canonicalizeToBuffer } from "./canonicalize";
import { CLONE_STATUSES } from "./clone-status";
import { SignedLicenseDocumentSchema } from "./schema";
import { resolveTrustedKeys, verifyLicense } from "./verify";
import type { SignedLicenseDocument } from "./types";

const isoTimestamp = z.string().datetime({ offset: true });

export const LicenseServerResponsePayloadSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal("license_server_response"),
    response_type: z.enum(["activation", "validation"]),
    installation_id: z.string().min(1).max(100),
    request_nonce: z.string().min(16).max(128),
    license_id: z.string().min(1).max(100),
    license_status: z.enum(["ACTIVE", "SUSPENDED", "EXPIRED", "REVOKED"]),
    installation_status: z.enum([
      "ACTIVE",
      "SUSPENDED",
      "REVOKED",
      "DEACTIVATED",
      "TRANSFERRED",
      "DISABLED",
    ]),
    clone_status: z.enum(CLONE_STATUSES).optional(),
    instance_session_id: z
      .string()
      .regex(/^sess_[0-9a-f-]{36}$/i)
      .optional(),
    temporal_state: z.enum(["NOT_YET_VALID", "VALID", "GRACE", "EXPIRED"]),
    server_time: isoTimestamp,
    next_online_validation_at: isoTimestamp,
    offline_validation_tolerance_days: z.number().int().min(0).max(30),
    signed_license: SignedLicenseDocumentSchema,
  })
  .strict();

export const SignedLicenseServerResponseSchema = z
  .object({
    payload: LicenseServerResponsePayloadSchema,
    signature: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_-]+$/),
    algorithm: z.literal("Ed25519"),
    key_id: z.string().min(1).max(100),
  })
  .strict();

export type LicenseServerResponsePayload = z.infer<typeof LicenseServerResponsePayloadSchema>;
export type SignedLicenseServerResponse = z.infer<typeof SignedLicenseServerResponseSchema>;

export const AttestationChallengePayloadSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal("installation_attestation_challenge"),
    installation_id: z.string().min(1).max(100),
    license_id: z.string().min(1).max(100),
    instance_session_id: z.string().regex(/^sess_[0-9a-f-]{36}$/i),
    request_nonce: z.string().min(16).max(128),
    challenge: z.string().min(32).max(128),
    expires_at: isoTimestamp,
    server_time: isoTimestamp,
  })
  .strict();

export const SignedAttestationChallengeSchema = z
  .object({
    payload: AttestationChallengePayloadSchema,
    signature: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_-]+$/),
    algorithm: z.literal("Ed25519"),
    key_id: z.string().min(1).max(100),
  })
  .strict();

export type AttestationChallengePayload = z.infer<typeof AttestationChallengePayloadSchema>;
export type SignedAttestationChallenge = z.infer<typeof SignedAttestationChallengeSchema>;

export function verifyAttestationChallenge(
  input: unknown,
  options: {
    trustedKeys?: Record<string, string>;
    expectedInstallationId: string;
    expectedLicenseId: string;
    expectedSessionId: string;
    expectedNonce: string;
    now?: Date;
  },
): { valid: true; challenge: SignedAttestationChallenge } | { valid: false; reason: string } {
  const parsed = SignedAttestationChallengeSchema.safeParse(input);
  if (!parsed.success) return { valid: false, reason: "Desafio de instalação inválido." };
  const challenge = parsed.data;
  const payload = challenge.payload;
  if (
    payload.installation_id !== options.expectedInstallationId ||
    payload.license_id !== options.expectedLicenseId ||
    payload.instance_session_id !== options.expectedSessionId ||
    payload.request_nonce !== options.expectedNonce
  ) {
    return { valid: false, reason: "O desafio não corresponde a esta solicitação." };
  }
  const publicKeyPem = resolveTrustedKeys(options.trustedKeys)[challenge.key_id];
  if (!publicKeyPem) return { valid: false, reason: "Chave do License Server desconhecida." };
  const expiresAt = Date.parse(payload.expires_at);
  const serverTime = Date.parse(payload.server_time);
  if (
    !Number.isFinite(expiresAt) ||
    !Number.isFinite(serverTime) ||
    expiresAt <= serverTime ||
    expiresAt - serverTime > 60_000
  ) {
    return { valid: false, reason: "O desafio expirou ou tem datas inválidas." };
  }
  try {
    const publicKey = crypto.createPublicKey(publicKeyPem);
    const signatureBytes = decodeBase64Url(challenge.signature);
    if (
      publicKey.asymmetricKeyType !== "ed25519" ||
      signatureBytes.length !== 64 ||
      !crypto.verify(null, canonicalizeToBuffer(payload), publicKey, signatureBytes)
    ) {
      return { valid: false, reason: "A assinatura do desafio não confere." };
    }
  } catch {
    return { valid: false, reason: "Não foi possível validar a assinatura do desafio." };
  }
  return { valid: true, challenge };
}

export function attachAttestationChallengeSignature(
  payload: AttestationChallengePayload,
  privateKeyPem: string,
  keyId: string,
): SignedAttestationChallenge {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("License Server signing key must be Ed25519.");
  const signature = crypto
    .sign(null, canonicalizeToBuffer(payload), privateKey)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { payload, signature, algorithm: "Ed25519", key_id: keyId };
}

export const InstallationRecoveryPayloadSchema = z
  .object({
    version: z.literal(1),
    purpose: z.literal("installation_recovery"),
    installation_id: z.string().min(1).max(100),
    request_nonce: z.string().min(16).max(128),
    public_key_fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    clone_status: z.literal("NORMAL"),
    server_time: isoTimestamp,
  })
  .strict();

export const SignedInstallationRecoverySchema = z
  .object({
    payload: InstallationRecoveryPayloadSchema,
    signature: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_-]+$/),
    algorithm: z.literal("Ed25519"),
    key_id: z.string().min(1).max(100),
  })
  .strict();

export type InstallationRecoveryPayload = z.infer<typeof InstallationRecoveryPayloadSchema>;
export type SignedInstallationRecovery = z.infer<typeof SignedInstallationRecoverySchema>;

export function attachInstallationRecoverySignature(
  payload: InstallationRecoveryPayload,
  privateKeyPem: string,
  keyId: string,
): SignedInstallationRecovery {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("License Server signing key must be Ed25519.");
  const signature = crypto
    .sign(null, canonicalizeToBuffer(payload), privateKey)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { payload, signature, algorithm: "Ed25519", key_id: keyId };
}

export function verifyInstallationRecoveryResponse(
  input: unknown,
  expected: { installationId: string; requestNonce: string; publicKeyFingerprint: string },
  trustedKeys?: Record<string, string>,
): boolean {
  const parsed = SignedInstallationRecoverySchema.safeParse(input);
  if (!parsed.success) return false;
  const response = parsed.data;
  if (
    response.payload.installation_id !== expected.installationId ||
    response.payload.request_nonce !== expected.requestNonce ||
    response.payload.public_key_fingerprint !== expected.publicKeyFingerprint
  )
    return false;
  const keyPem = resolveTrustedKeys(trustedKeys)[response.key_id];
  if (!keyPem) return false;
  try {
    const key = crypto.createPublicKey(keyPem);
    return (
      key.asymmetricKeyType === "ed25519" &&
      crypto.verify(
        null,
        canonicalizeToBuffer(response.payload),
        key,
        decodeBase64Url(response.signature),
      )
    );
  } catch {
    return false;
  }
}

export interface VerifiedOnlineValidation {
  response: SignedLicenseServerResponse;
  verified_at: string;
}

export function verifyLicenseServerResponse(
  input: unknown,
  options: {
    trustedKeys?: Record<string, string>;
    expectedInstallationId?: string;
    expectedNonce?: string;
    now?: Date;
  } = {},
): { valid: true; response: SignedLicenseServerResponse } | { valid: false; reason: string } {
  const parsed = SignedLicenseServerResponseSchema.safeParse(input);
  if (!parsed.success) return { valid: false, reason: "Resposta do License Server inválida." };

  const response = parsed.data;
  const publicKeyPem = resolveTrustedKeys(options.trustedKeys)[response.key_id];
  if (!publicKeyPem)
    return { valid: false, reason: "Chave de resposta do License Server desconhecida." };
  if (
    options.expectedInstallationId &&
    response.payload.installation_id !== options.expectedInstallationId
  ) {
    return { valid: false, reason: "A resposta online pertence a outra instalação." };
  }
  if (options.expectedNonce && response.payload.request_nonce !== options.expectedNonce) {
    return { valid: false, reason: "A resposta online não está vinculada a esta solicitação." };
  }
  if (
    response.payload.signed_license.payload.installation_id !== response.payload.installation_id ||
    response.payload.signed_license.payload.license_id !== response.payload.license_id
  ) {
    return { valid: false, reason: "A licença assinada não corresponde à resposta online." };
  }

  const licenseVerification = verifyLicense(response.payload.signed_license, {
    expectedInstallationId: response.payload.installation_id,
    trustedKeys: options.trustedKeys,
    now: options.now,
  });
  if (!licenseVerification.cryptographic_valid) {
    return { valid: false, reason: "A assinatura da licença retornada não é válida." };
  }

  try {
    const signatureBytes = decodeBase64Url(response.signature);
    const publicKey = crypto.createPublicKey(publicKeyPem);
    if (publicKey.asymmetricKeyType !== "ed25519" || signatureBytes.length !== 64) {
      return { valid: false, reason: "A assinatura da resposta online está malformada." };
    }
    const signatureValid = crypto.verify(
      null,
      canonicalizeToBuffer(response.payload),
      publicKey,
      signatureBytes,
    );
    if (!signatureValid)
      return { valid: false, reason: "A assinatura da resposta online não confere." };
  } catch {
    return { valid: false, reason: "Não foi possível verificar a resposta online." };
  }

  return { valid: true, response };
}

export function defaultOnlineValidationCachePath(licensePath: string): string {
  return (
    process.env.CLIENTIX_LICENSE_ONLINE_CACHE_PATH?.trim() ||
    path.join(path.dirname(licensePath), "online-validation.json")
  );
}

export async function writeOnlineValidationCache(
  response: SignedLicenseServerResponse,
  cachePath: string,
  verifiedAt = response.payload.server_time,
): Promise<void> {
  const directory = path.dirname(cachePath);
  await fs.mkdir(directory, { recursive: true });
  const tempPath = `${cachePath}.tmp.${process.pid}.${crypto.randomUUID()}`;
  const document: VerifiedOnlineValidation = { response, verified_at: verifiedAt };
  let exists = false;
  try {
    const handle = await fs.open(tempPath, "wx", 0o640);
    exists = true;
    try {
      await handle.writeFile(JSON.stringify(document), { encoding: "utf8" });
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fs.rename(tempPath, cachePath);
    exists = false;
    await fs.chmod(cachePath, 0o640).catch(() => undefined);
  } finally {
    if (exists) await fs.unlink(tempPath).catch(() => undefined);
  }
}

export async function readVerifiedOnlineValidationCache(
  cachePath: string,
  options: {
    expectedInstallationId?: string;
    now?: Date;
    trustedKeys?: Record<string, string>;
  } = {},
): Promise<VerifiedOnlineValidation | null> {
  try {
    const stat = await fs.stat(cachePath);
    if (stat.size > 128 * 1024) return null;
    const raw = await fs.readFile(cachePath, "utf8");
    const candidate = JSON.parse(raw) as { response?: unknown; verified_at?: unknown };
    if (
      typeof candidate.verified_at !== "string" ||
      !isoTimestamp.safeParse(candidate.verified_at).success
    ) {
      return null;
    }
    const result = verifyLicenseServerResponse(candidate.response, options);
    if (!result.valid) return null;
    return { response: result.response, verified_at: candidate.verified_at };
  } catch {
    return null;
  }
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("invalid base64url");
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64 + "=".repeat((4 - (base64.length % 4)) % 4), "base64");
}

export function attachLicenseServerResponseSignature(
  payload: LicenseServerResponsePayload,
  privateKeyPem: string,
  keyId: string,
): SignedLicenseServerResponse {
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519")
    throw new Error("License Server signing key must be Ed25519.");
  const signature = crypto
    .sign(null, canonicalizeToBuffer(payload), privateKey)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  return { payload, signature, algorithm: "Ed25519", key_id: keyId };
}

export type { SignedLicenseDocument };
