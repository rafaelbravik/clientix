import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_TRUSTED_KEYS, verifyLicense } from "@/lib/licensing/verify";
import type { SignedLicenseDocument } from "@/lib/licensing/types";

const licenseKeyId = "clientix-license-2026-01";
const licenseFixturePath = path.resolve(
  "tests/fixtures/licensing/clientix-r1-1-production-license.json",
);
const releasePublicKeyPath = path.resolve(
  "distribution/installer/trust/release-manifest/clientix-release-2026-01.pem",
);
const licenseFixture = JSON.parse(
  fs.readFileSync(licenseFixturePath, "utf8"),
) as SignedLicenseDocument;
describe("production licensing trust roots", () => {
  beforeEach(() => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CLIENTIX_TRUSTED_LICENSE_KEYS", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("verifies the signed test license through the built-in production trust root", () => {
    const result = verifyLicense(licenseFixture, {
      expectedInstallationId: licenseFixture.payload.installation_id,
      now: new Date("2026-10-09T12:00:00Z"),
    });

    expect(DEFAULT_TRUSTED_KEYS[licenseKeyId]).toContain("BEGIN PUBLIC KEY");
    expect(result).toMatchObject({
      valid: true,
      usable: true,
      cryptographic_valid: true,
      state: "VALID",
      key_id: licenseKeyId,
    });
  });

  it("returns UNKNOWN_KEY for an unregistered production key ID", () => {
    const result = verifyLicense({ ...licenseFixture, key_id: "unregistered-production-key" });

    expect(result.state).toBe("UNKNOWN_KEY");
    expect(result.cryptographic_valid).toBe(false);
  });

  it("returns INVALID_SIGNATURE when the signed payload is changed", () => {
    const tampered = {
      ...licenseFixture,
      payload: {
        ...licenseFixture.payload,
        customer: { ...licenseFixture.payload.customer, name: "Tampered customer" },
      },
    };

    const result = verifyLicense(tampered);

    expect(result.state).toBe("INVALID_SIGNATURE");
    expect(result.cryptographic_valid).toBe(false);
  });

  it("returns INVALID_SIGNATURE when the document is checked against the release authority", () => {
    const releasePublicKey = fs.readFileSync(releasePublicKeyPath, "utf8");
    const result = verifyLicense(licenseFixture, {
      trustedKeys: { [licenseKeyId]: releasePublicKey },
    });

    expect(result.state).toBe("INVALID_SIGNATURE");
    expect(result.cryptographic_valid).toBe(false);
  });

  it("ignores environment-injected keys in production", () => {
    process.env.CLIENTIX_TRUSTED_LICENSE_KEYS = JSON.stringify({
      injected_alias: DEFAULT_TRUSTED_KEYS[licenseKeyId],
    });

    const result = verifyLicense({ ...licenseFixture, key_id: "injected_alias" });

    expect(result.state).toBe("UNKNOWN_KEY");
    expect(result.cryptographic_valid).toBe(false);
  });
});
