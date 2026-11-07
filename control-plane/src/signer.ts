import crypto from "crypto";
import type { SignedLicenseDocument, LicensePayload } from "@/lib/licensing/types";
import { canonicalizeToBuffer } from "@/lib/licensing/canonicalize";

export interface VendorSignerProvider {
  getSigningKey(requestedKeyId?: string): Promise<{ keyId: string; privateKeyPem: string }>;
}

export class StaticVendorSignerProvider implements VendorSignerProvider {
  constructor(
    private readonly keyId: string,
    private readonly privateKeyPem: string,
  ) {}

  async getSigningKey(requestedKeyId?: string): Promise<{ keyId: string; privateKeyPem: string }> {
    if (requestedKeyId && requestedKeyId !== this.keyId) {
      throw new Error(
        `Requested signing key_id "${requestedKeyId}" does not match configured key "${this.keyId}". Fail closed.`,
      );
    }
    return {
      keyId: this.keyId,
      privateKeyPem: this.privateKeyPem,
    };
  }
}

export interface KeyRegistryEntry {
  keyId: string;
  privateKeyPem: string;
  isActive: boolean;
  algorithm?: string;
}

/**
 * KeySelectionVendorSignerProvider:
 * Audits and selects the vendor signing key strictly according to policy:
 * - If keyId is explicitly specified: must exist and be active.
 * - If keyId is not specified: exactly one active key must exist.
 * - 0 active keys: FAIL CLOSED.
 * - >1 ambiguous active keys: FAIL CLOSED.
 * - Never pick arbitrary first row.
 */
export class KeySelectionVendorSignerProvider implements VendorSignerProvider {
  constructor(private readonly keys: KeyRegistryEntry[]) {}

  async getSigningKey(requestedKeyId?: string): Promise<{ keyId: string; privateKeyPem: string }> {
    if (requestedKeyId) {
      const match = this.keys.find((k) => k.keyId === requestedKeyId);
      if (!match) {
        throw new Error(
          `Signing key_id "${requestedKeyId}" not found in provider registry. Fail closed.`,
        );
      }
      if (!match.isActive) {
        throw new Error(`Signing key_id "${requestedKeyId}" is inactive/retired. Fail closed.`);
      }
      return { keyId: match.keyId, privateKeyPem: match.privateKeyPem };
    }

    // Unspecified keyId: evaluate active keys
    const activeKeys = this.keys.filter((k) => k.isActive);

    if (activeKeys.length === 0) {
      throw new Error("Zero active vendor signing keys configured. Fail closed.");
    }

    if (activeKeys.length > 1) {
      throw new Error(
        `Ambiguous active vendor signing keys: ${activeKeys.length} active keys found without explicit key_id specified. Fail closed.`,
      );
    }

    const singleKey = activeKeys[0]!;
    return { keyId: singleKey.keyId, privateKeyPem: singleKey.privateKeyPem };
  }
}

/**
 * Deterministically signs a LicensePayload using RFC 8785 canonicalization and Ed25519.
 * Returns a fully compliant SignedLicenseDocument.
 */
export async function signIssuedLicense(
  payload: LicensePayload,
  signerProvider: VendorSignerProvider,
  requestedKeyId?: string,
): Promise<SignedLicenseDocument> {
  const { keyId, privateKeyPem } = await signerProvider.getSigningKey(requestedKeyId);

  if (!keyId || !privateKeyPem) {
    throw new Error("Vendor signer key_id ou privateKeyPem ausente. Falha closed.");
  }

  // 1. Canonicalize payload bytes per RFC 8785 (JCS)
  const canonicalBytes = canonicalizeToBuffer(payload);

  // 2. Sign canonical bytes with Ed25519 private key
  const privateKey = crypto.createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error(
      `Algoritmo incompatível: esperado ed25519, recebido ${privateKey.asymmetricKeyType}`,
    );
  }

  const sigBuffer = crypto.sign(null, canonicalBytes, privateKey);

  // 3. Encode signature as Base64URL without padding
  const signature = sigBuffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

  return {
    payload,
    signature,
    algorithm: "Ed25519",
    key_id: keyId,
  };
}
