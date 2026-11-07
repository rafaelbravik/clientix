import type { SignedLicenseDocument, LicensePayload } from "@/lib/licensing/types";
import { canonicalizeToBuffer } from "@/lib/licensing/canonicalize";
import { verifyLicense } from "@/lib/licensing/verify";
import { signIssuedLicense, type VendorSignerProvider } from "./signer";

/** Server-only issuer. It accepts a signer provider; the private key never belongs in a row or response. */
export class LicenseIssuer {
  constructor(
    private readonly signer: VendorSignerProvider,
    private readonly trustedPublicKeys: Record<string, string>,
  ) {}

  buildPayload(payload: LicensePayload): LicensePayload {
    return structuredClone(payload);
  }

  canonicalizePayload(payload: LicensePayload): Buffer {
    return canonicalizeToBuffer(payload);
  }

  async signPayload(payload: LicensePayload, keyId?: string): Promise<SignedLicenseDocument> {
    const signed = await signIssuedLicense(this.buildPayload(payload), this.signer, keyId);
    this.verifyIssuedLicense(signed, payload.installation_id);
    return signed;
  }

  verifyIssuedLicense(document: SignedLicenseDocument, installationId: string): void {
    const verification = verifyLicense(document, {
      expectedInstallationId: installationId,
      trustedKeys: this.trustedPublicKeys,
    });
    if (!verification.cryptographic_valid) {
      throw new Error("Issued license signature did not pass the server parity check.");
    }
  }
}
