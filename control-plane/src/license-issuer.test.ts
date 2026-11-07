import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import { verifyLicense } from "@/lib/licensing/verify";
import type { LicensePayload } from "@/lib/licensing/types";
import { LicenseIssuer } from "./license-issuer";
import { StaticVendorSignerProvider } from "./signer";

const installationId = "inst_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

function makePair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

function payload(): LicensePayload {
  return {
    license_version: 1,
    license_id: "lic_test_01",
    serial: "CLX-2026-AB12-CD34",
    product: "clientix",
    deployment: "self-hosted",
    plan: "pro",
    status: "ACTIVE",
    customer: { id: "customer-test", name: "Synthetic customer" },
    license_type: "enterprise",
    installation_id: installationId,
    entitlements: {
      max_installations: 1,
      max_tenants: 5,
      resale_allowed: false,
      white_label: false,
      features: ["messages"],
    },
    grace_period_days: 7,
    issued_at: "2026-11-01T00:00:00Z",
    valid_from: "2026-11-01T00:00:00Z",
    expires_at: "2099-11-01T00:00:00Z",
  };
}

describe("server-side license issuer", () => {
  it("signs the canonical payload with Ed25519 and verifies against the public key", async () => {
    const pair = makePair();
    const keyId = "dev-only-license-key";
    const issuer = new LicenseIssuer(new StaticVendorSignerProvider(keyId, pair.privateKeyPem), {
      [keyId]: pair.publicKeyPem,
    });

    const document = await issuer.signPayload(payload());
    const verified = verifyLicense(document, {
      trustedKeys: { [keyId]: pair.publicKeyPem },
      expectedInstallationId: installationId,
    });

    expect(document.key_id).toBe(keyId);
    expect(document.algorithm).toBe("Ed25519");
    expect(verified).toMatchObject({ valid: true, cryptographic_valid: true, usable: true });
    expect(JSON.stringify(document)).not.toContain("PRIVATE KEY");
  });

  it("rejects a payload changed after signing and an unknown key id", async () => {
    const pair = makePair();
    const keyId = "dev-only-license-key";
    const issuer = new LicenseIssuer(new StaticVendorSignerProvider(keyId, pair.privateKeyPem), {
      [keyId]: pair.publicKeyPem,
    });
    const signed = await issuer.signPayload(payload());
    const altered = { ...signed, payload: { ...signed.payload, plan: "enterprise" as const } };

    expect(
      verifyLicense(altered, { trustedKeys: { [keyId]: pair.publicKeyPem } }).cryptographic_valid,
    ).toBe(false);
    await expect(issuer.signPayload(payload(), "unknown-dev-key")).rejects.toThrow();
  });
});
