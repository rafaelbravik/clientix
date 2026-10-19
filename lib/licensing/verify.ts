import type {
  SignedLicenseDocument,
  VerifyLicenseOptions,
  VerifyLicenseResult,
} from "./types";
import {
  SignedLicenseDocumentSchema,
  MAX_LICENSE_DOCUMENT_BYTES,
  DEFAULT_GRACE_PERIOD_DAYS,
  CURRENT_LICENSE_VERSION,
} from "./schema";
import { canonicalizeToBuffer } from "./canonicalize";
import { verifyEd25519Signature } from "./crypto";
import { computeTemporalLicenseState } from "./state";
import { DEFAULT_TRUSTED_KEYS } from "./trusted-keys";

export { DEFAULT_TRUSTED_KEYS } from "./trusted-keys";

/**
 * Resolves trusted keys.
 *
 * THREAT MODEL & TRUST ROOT POLICY:
 * In production (NODE_ENV === "production"), the vendor trust root (DEFAULT_TRUSTED_KEYS)
 * is authoritative. Arbitrary environment injection of public keys is restricted to development
 * and test environments, preventing an unauthorized VPS root operator from overriding the trust root.
 */
function resolveTrustedKeys(optionsTrustedKeys?: Record<string, string>): Record<string, string> {
  // Explicit programmatic options take precedence (used in testing & unit test suites)
  if (optionsTrustedKeys && Object.keys(optionsTrustedKeys).length > 0) {
    return optionsTrustedKeys;
  }

  // Environment override is permitted ONLY outside production
  const isProduction = process.env.NODE_ENV === "production";
  if (!isProduction) {
    const envKeysRaw = process.env.CLIENTIX_TRUSTED_LICENSE_KEYS;
    if (envKeysRaw) {
      try {
        const parsed = JSON.parse(envKeysRaw) as Record<string, string>;
        return { ...DEFAULT_TRUSTED_KEYS, ...parsed };
      } catch {
        // Ignore malformed env JSON
      }
    }
  }

  return DEFAULT_TRUSTED_KEYS;
}

/**
 * Comprehensive verification of a Clientix signed license document.
 *
 * Checks in order:
 * 1. Document size guard (< MAX_LICENSE_DOCUMENT_BYTES).
 * 2. Schema structure & version validation (Zod).
 * 3. Key ID lookup in trusted registry.
 * 4. Cryptographic Ed25519 signature verification on RFC 8785 canonicalized payload.
 * 5. Installation ID match (if expectedInstallationId option provided).
 * 6. Temporal validity & grace period status.
 *
 * @param document Raw unknown object or parsed SignedLicenseDocument
 * @param options Verification options (clock, installation ID, grace period, trusted keys)
 * @returns VerifyLicenseResult
 */
export function verifyLicense(
  document: unknown,
  options: VerifyLicenseOptions = {}
): VerifyLicenseResult {
  // 1. Size guard if stringified
  try {
    const rawString = typeof document === "string" ? document : JSON.stringify(document);
    if (Buffer.byteLength(rawString, "utf-8") > MAX_LICENSE_DOCUMENT_BYTES) {
      return {
        valid: false,
        usable: false,
        cryptographic_valid: false,
        state: "MALFORMED_DOCUMENT",
        reason: "Documento de licença excede o tamanho máximo permitido (64KB)",
        errorCode: "LICENSE_PAYLOAD_TOO_LARGE",
      };
    }
  } catch {
    return {
      valid: false,
      usable: false,
      cryptographic_valid: false,
      state: "MALFORMED_DOCUMENT",
      reason: "Documento de licença inválido ou não serializável",
      errorCode: "LICENSE_MALFORMED",
    };
  }

  // Parse if input was JSON string
  let parsedDoc: unknown = document;
  if (typeof document === "string") {
    try {
      parsedDoc = JSON.parse(document);
    } catch {
      return {
        valid: false,
        usable: false,
        cryptographic_valid: false,
        state: "MALFORMED_DOCUMENT",
        reason: "JSON da licença é malformado",
        errorCode: "LICENSE_MALFORMED",
      };
    }
  }

  // 2. Schema validation
  const parseResult = SignedLicenseDocumentSchema.safeParse(parsedDoc);
  if (!parseResult.success) {
    const issues = parseResult.error.issues;
    const versionIssue = issues.find((i) => i.path.includes("license_version"));
    if (versionIssue) {
      return {
        valid: false,
        usable: false,
        cryptographic_valid: false,
        state: "UNSUPPORTED_LICENSE_VERSION",
        reason: `Versão da licença não suportada (versão esperada: ${CURRENT_LICENSE_VERSION})`,
        errorCode: "LICENSE_VERSION_UNSUPPORTED",
      };
    }

    const firstMsg = issues[0]?.message ?? "Esquema inválido";
    return {
      valid: false,
      usable: false,
      cryptographic_valid: false,
      state: "MALFORMED_DOCUMENT",
      reason: `Documento de licença inválido: ${firstMsg}`,
      errorCode: "LICENSE_MALFORMED",
    };
  }

  const signedDoc = parseResult.data as unknown as SignedLicenseDocument;
  const { payload, signature, key_id } = signedDoc;

  // 3. Key ID lookup
  const trustedKeys = resolveTrustedKeys(options.trustedKeys);
  const publicKey = trustedKeys[key_id];
  if (!publicKey) {
    return {
      valid: false,
      usable: false,
      cryptographic_valid: false,
      state: "UNKNOWN_KEY",
      reason: `Chave pública desconhecida ou não autorizada para o key_id: "${key_id}"`,
      errorCode: "LICENSE_UNKNOWN_KEY",
      payload,
      key_id,
      license_id: payload.license_id,
    };
  }

  // 4. Cryptographic Ed25519 verification over canonicalized payload
  const canonicalBytes = canonicalizeToBuffer(payload);
  const cryptoValid = verifyEd25519Signature(canonicalBytes, signature, publicKey);

  if (!cryptoValid) {
    return {
      valid: false,
      usable: false,
      cryptographic_valid: false,
      state: "INVALID_SIGNATURE",
      reason: "Assinatura criptográfica Ed25519 inválida para o payload fornecido",
      errorCode: "LICENSE_INVALID_SIGNATURE",
      payload,
      key_id,
      license_id: payload.license_id,
    };
  }

  // 5. Installation ID validation (if expectedInstallationId provided)
  if (options.expectedInstallationId) {
    if (payload.installation_id !== options.expectedInstallationId) {
      return {
        valid: false,
        usable: false,
        cryptographic_valid: true,
        state: "INSTALLATION_MISMATCH",
        reason: `Installation ID da licença ("${payload.installation_id}") diverge da instalação atual ("${options.expectedInstallationId}")`,
        errorCode: "LICENSE_INSTALLATION_MISMATCH",
        payload,
        key_id,
        license_id: payload.license_id,
      };
    }
  }

  // 6. Temporal validation (valid_from, expires_at, grace_period)
  const temporal = computeTemporalLicenseState({
    validFrom: payload.valid_from,
    expiresAt: payload.expires_at,
    now: options.now,
    gracePeriodDays: options.gracePeriodDays ?? DEFAULT_GRACE_PERIOD_DAYS,
  });

  const isUsableState = temporal.state === "VALID" || temporal.state === "GRACE";

  return {
    valid: isUsableState,
    usable: isUsableState,
    cryptographic_valid: true,
    state: temporal.state,
    reason: temporal.reason,
    errorCode: temporal.errorCode,
    payload,
    key_id,
    license_id: payload.license_id,
    expires_at: temporal.expires_at,
    grace_until: temporal.grace_until,
  };
}
