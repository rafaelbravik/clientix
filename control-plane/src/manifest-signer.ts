import crypto from "crypto";
import { canonicalizeToBuffer } from "@/lib/licensing/canonicalize";
import type { ReleaseManifestPayload, SignedReleaseManifest } from "./distribution-types";

export interface IReleaseManifestSigner {
  getKeyId(): string;
  signManifest(payload: ReleaseManifestPayload): Promise<SignedReleaseManifest>;
}

export class LocalReleaseManifestSigner implements IReleaseManifestSigner {
  constructor(
    private readonly keyId: string,
    private readonly privateKeyPem: string
  ) {}

  getKeyId(): string {
    return this.keyId;
  }

  async signManifest(payload: ReleaseManifestPayload): Promise<SignedReleaseManifest> {
    const canonicalBytes = canonicalizeToBuffer(payload);

    const privateKey = crypto.createPrivateKey(this.privateKeyPem);
    if (privateKey.asymmetricKeyType !== "ed25519") {
      throw new Error(`Invalid manifest signing key algorithm: expected ed25519, got ${privateKey.asymmetricKeyType}`);
    }

    const sigBuffer = crypto.sign(null, canonicalBytes, privateKey);
    const signature = sigBuffer
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    return {
      payload,
      keyId: this.keyId,
      algorithm: "Ed25519",
      purpose: "release_manifest",
      signature,
    };
  }
}

export interface VerifyManifestResult {
  valid: boolean;
  reason?: string;
}

export function verifyReleaseManifest(
  manifest: SignedReleaseManifest,
  trustedManifestKeys: Record<string, string>
): VerifyManifestResult {
  if (manifest.algorithm !== "Ed25519") {
    return { valid: false, reason: `Unsupported algorithm: ${manifest.algorithm}` };
  }

  if (manifest.purpose !== "release_manifest") {
    return { valid: false, reason: `Invalid signature purpose: ${manifest.purpose}` };
  }

  const publicKeyPem = trustedManifestKeys[manifest.keyId];
  if (!publicKeyPem) {
    return { valid: false, reason: `Unknown or untrusted manifest key_id: "${manifest.keyId}"` };
  }

  try {
    const canonicalBytes = canonicalizeToBuffer(manifest.payload);

    let b64 = manifest.signature.replace(/-/g, "+").replace(/_/g, "/");
    while (b64.length % 4 !== 0) {
      b64 += "=";
    }
    const sigBuffer = Buffer.from(b64, "base64");
    if (sigBuffer.length !== 64) {
      return { valid: false, reason: "Malformed Ed25519 signature length" };
    }

    const publicKey = crypto.createPublicKey(publicKeyPem);
    const isValid = crypto.verify(null, canonicalBytes, publicKey, sigBuffer);

    if (!isValid) {
      return { valid: false, reason: "Ed25519 signature mismatch for manifest payload" };
    }

    return { valid: true };
  } catch (err: unknown) {
    return { valid: false, reason: `Verification exception: ${String(err)}` };
  }
}
