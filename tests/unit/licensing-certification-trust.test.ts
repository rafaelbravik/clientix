import { generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";

import { canonicalizeToBuffer } from "@/lib/licensing/canonicalize";
import { createCustomerCertificationTrustModule } from "@/scripts/lib/customer-certification-trust";
import type { LicensePayload, SignedLicenseDocument } from "@/lib/licensing/types";
import { verifyLicense as verifyProductionLicense } from "@/lib/licensing/verify";

const syntheticPayload: LicensePayload = {
  license_version: 1,
  license_id: "lic-certification-runtime-test",
  customer: { id: "customer-certification-test", name: "Cliente de certificação" },
  license_type: "enterprise",
  installation_id: "e3b0992b-450c-40f0-9b07-4c5c6dc98f10",
  entitlements: {
    max_installations: 1,
    max_tenants: 5,
    resale_allowed: false,
    white_label: false,
    features: ["webchat", "ai"],
  },
  issued_at: "2026-10-18T00:00:00.000Z",
  valid_from: "2026-10-18T00:00:00.000Z",
  expires_at: "2026-10-25T00:00:00.000Z",
};

function signedFixture(
  keyId: string,
  privateKey: KeyObject,
): SignedLicenseDocument {
  const payload = { ...syntheticPayload, customer: { ...syntheticPayload.customer } };
  const signature = sign(
    null,
    canonicalizeToBuffer(payload),
    privateKey,
  ).toString("base64url");

  return { algorithm: "Ed25519", key_id: keyId, payload, signature };
}

describe("trust root de licença de certificação", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/licensing/trusted-keys");
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("a imagem de produção recusa licença assinada por chave de teste mesmo com env injection", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519");
    const keyId = "clientix-certification-test-run-12345678";
    const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv(
      "CLIENTIX_TRUSTED_LICENSE_KEYS",
      JSON.stringify({ [keyId]: publicKeyPem }),
    );

    const result = verifyProductionLicense(signedFixture(keyId, privateKey), {
      expectedInstallationId: "e3b0992b-450c-40f0-9b07-4c5c6dc98f10",
      now: new Date("2026-10-19T12:00:00.000Z"),
    });

    expect(result).toMatchObject({ valid: false, cryptographic_valid: false, state: "UNKNOWN_KEY" });
  });

  it("módulo gerado aceita só o documento assinado pelo trust root público da certificação", async () => {
    const trusted = generateKeyPairSync("ed25519");
    const wrongSigner = generateKeyPairSync("ed25519");
    const keyId = "clientix-certification-test-run-abcdefgh";
    const publicKeyPem = trusted.publicKey.export({ format: "pem", type: "spki" }).toString();
    const publicKeyBase64 = Buffer.from(publicKeyPem).toString("base64");
    const generatedModule = createCustomerCertificationTrustModule(keyId, publicKeyBase64);
    expect(generatedModule).toContain(keyId);
    expect(generatedModule).toContain(publicKeyPem.replace(/\n/g, "\\n"));

    vi.stubEnv("NODE_ENV", "production");
    vi.doMock("@/lib/licensing/trusted-keys", () => {
      const trustedKeys = { [keyId]: publicKeyPem };
      return {
        DEFAULT_TRUSTED_KEYS: trustedKeys,
        trustedKeysForBuild: () => trustedKeys,
      };
    });
    vi.resetModules();
    const { verifyLicense } = await import("@/lib/licensing/verify");
    const expectedInstallationId = "e3b0992b-450c-40f0-9b07-4c5c6dc98f10";

    const valid = verifyLicense(signedFixture(keyId, trusted.privateKey), {
      expectedInstallationId,
      now: new Date("2026-10-19T12:00:00.000Z"),
    });
    const tampered = signedFixture(keyId, trusted.privateKey);
    tampered.payload.customer.name = "alterado";
    const wrongSignature = verifyLicense(signedFixture(keyId, wrongSigner.privateKey), {
      expectedInstallationId,
      now: new Date("2026-10-19T12:00:00.000Z"),
    });

    expect(valid).toMatchObject({ valid: true, usable: true, cryptographic_valid: true, key_id: keyId });
    expect(verifyLicense(tampered).state).toBe("INVALID_SIGNATURE");
    expect(wrongSignature).toMatchObject({ valid: false, cryptographic_valid: false, state: "INVALID_SIGNATURE" });
  });
});
