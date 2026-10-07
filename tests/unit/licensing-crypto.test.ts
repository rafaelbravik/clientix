import { describe, it, expect } from "vitest";
import crypto from "crypto";
import {
  canonicalizeJson,
  canonicalizeToBuffer,
  verifyLicense,
  DEFAULT_GRACE_PERIOD_DAYS,
  type LicensePayload,
  type SignedLicenseDocument,
} from "@/lib/licensing";
import { signLicensePayload } from "../../scripts/licensing/sign-license";

function generateTestKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { pubPem, privPem, publicKey, privateKey };
}

function createSamplePayload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    license_version: 1,
    license_id: "lic_test_123456",
    customer: {
      id: "cust_99",
      name: "Cliente Teste Ltda",
      email: "contato@clienteteste.com",
      country: "BR",
    },
    license_type: "partner",
    installation_id: "inst_11111111-2222-4333-8444-555555555555",
    entitlements: {
      max_installations: 1,
      max_tenants: 10,
      resale_allowed: true,
      white_label: false,
      features: ["campaigns", "ai_agent"],
    },
    issued_at: "2026-10-01T00:00:00Z",
    valid_from: "2026-10-01T00:00:00Z",
    expires_at: "2027-10-01T00:00:00Z",
    maintenance_until: "2027-10-01T00:00:00Z",
    ...overrides,
  };
}

describe("Licensing — Canonicalization (RFC 8785)", () => {
  it("produces identical output regardless of object property ordering", () => {
    const objA = { z: 1, a: 2, m: { nestedB: "val", nestedA: true } };
    const objB = { a: 2, m: { nestedA: true, nestedB: "val" }, z: 1 };

    const canonA = canonicalizeJson(objA);
    const canonB = canonicalizeJson(objB);

    expect(canonA).toBe(canonB);
    expect(canonA).toBe('{"a":2,"m":{"nestedA":true,"nestedB":"val"},"z":1}');
  });

  it("handles primitives, numbers, null, and arrays strictly", () => {
    expect(canonicalizeJson(null)).toBe("null");
    expect(canonicalizeJson(true)).toBe("true");
    expect(canonicalizeJson(12345)).toBe("12345");
    expect(canonicalizeJson([3, 2, 1])).toBe("[3,2,1]");
    expect(canonicalizeJson({ arr: [1, 2] })).toBe('{"arr":[1,2]}');
  });

  it("rejects non-finite numbers", () => {
    expect(() => canonicalizeJson(NaN)).toThrow();
    expect(() => canonicalizeJson(Infinity)).toThrow();
  });

  it("canonicalizeToBuffer returns valid UTF-8 Buffer", () => {
    const buf = canonicalizeToBuffer({ hello: "world" });
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.toString("utf-8")).toBe('{"hello":"world"}');
  });
});

describe("Licensing — Cryptographic Verification (Ed25519)", () => {
  const keys = generateTestKeypair();
  const KEY_ID = "test-key-2026";
  const trustedKeys = { [KEY_ID]: keys.pubPem };

  it("verifies a genuinely signed valid license", () => {
    const payload = createSamplePayload();
    const doc = signLicensePayload(payload, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });

    const result = verifyLicense(doc, {
      trustedKeys,
      now: new Date("2026-10-15T00:00:00Z"),
      expectedInstallationId: payload.installation_id,
    });

    expect(result.valid).toBe(true);
    expect(result.cryptographic_valid).toBe(true);
    expect(result.state).toBe("VALID");
    expect(result.license_id).toBe(payload.license_id);
    expect(result.payload?.customer.name).toBe("Cliente Teste Ltda");
  });

  it("fails verification when payload is tampered", () => {
    const payload = createSamplePayload();
    const doc = signLicensePayload(payload, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });

    // Tamper with payload (escalate max_tenants)
    const tamperedPayload = {
      ...doc.payload,
      entitlements: {
        ...doc.payload.entitlements,
        max_tenants: 999,
      },
    };

    const tamperedDoc: SignedLicenseDocument = {
      ...doc,
      payload: tamperedPayload,
    };

    const result = verifyLicense(tamperedDoc, { trustedKeys });
    expect(result.valid).toBe(false);
    expect(result.cryptographic_valid).toBe(false);
    expect(result.state).toBe("INVALID_SIGNATURE");
    expect(result.errorCode).toBe("LICENSE_INVALID_SIGNATURE");
  });

  it("fails verification when signature is corrupted", () => {
    const payload = createSamplePayload();
    const doc = signLicensePayload(payload, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });

    const corruptedDoc: SignedLicenseDocument = {
      ...doc,
      signature: doc.signature.substring(0, doc.signature.length - 4) + "AAAA",
    };

    const result = verifyLicense(corruptedDoc, { trustedKeys });
    expect(result.valid).toBe(false);
    expect(result.cryptographic_valid).toBe(false);
    expect(result.state).toBe("INVALID_SIGNATURE");
  });

  it("fails verification with unknown key_id", () => {
    const payload = createSamplePayload();
    const doc = signLicensePayload(payload, {
      privateKey: keys.privPem,
      keyId: "unknown-untrusted-key",
    });

    const result = verifyLicense(doc, { trustedKeys });
    expect(result.valid).toBe(false);
    expect(result.state).toBe("UNKNOWN_KEY");
    expect(result.errorCode).toBe("LICENSE_UNKNOWN_KEY");
  });

  it("fails when verified against an alternate public key", () => {
    const altKeys = generateTestKeypair();
    const payload = createSamplePayload();
    const doc = signLicensePayload(payload, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });

    const result = verifyLicense(doc, {
      trustedKeys: { [KEY_ID]: altKeys.pubPem },
    });

    expect(result.valid).toBe(false);
    expect(result.cryptographic_valid).toBe(false);
    expect(result.state).toBe("INVALID_SIGNATURE");
  });

  it("detects installation_id mismatch even if signature is valid", () => {
    const payload = createSamplePayload({
      installation_id: "inst_11111111-1111-4111-8111-111111111111",
    });
    const doc = signLicensePayload(payload, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });

    const result = verifyLicense(doc, {
      trustedKeys,
      now: new Date("2026-10-15T00:00:00Z"),
      expectedInstallationId: "inst_22222222-2222-4222-8222-222222222222",
    });

    expect(result.valid).toBe(false);
    expect(result.cryptographic_valid).toBe(true);
    expect(result.state).toBe("INSTALLATION_MISMATCH");
    expect(result.errorCode).toBe("LICENSE_INSTALLATION_MISMATCH");
  });

  it("rejects unsupported license_version", () => {
    const rawDoc = {
      payload: {
        ...createSamplePayload(),
        license_version: 2,
      },
      signature: "abc",
      algorithm: "Ed25519",
      key_id: KEY_ID,
    };

    const result = verifyLicense(rawDoc, { trustedKeys });
    expect(result.valid).toBe(false);
    expect(result.state).toBe("UNSUPPORTED_LICENSE_VERSION");
  });

  it("rejects oversized documents", () => {
    const hugeDoc = {
      payload: createSamplePayload(),
      signature: "a".repeat(70000), // > 64KB
      algorithm: "Ed25519",
      key_id: KEY_ID,
    };

    const result = verifyLicense(hugeDoc, { trustedKeys });
    expect(result.valid).toBe(false);
    expect(result.state).toBe("MALFORMED_DOCUMENT");
    expect(result.errorCode).toBe("LICENSE_PAYLOAD_TOO_LARGE");
  });
});

describe("Licensing — Temporal States & Boundary Invariants", () => {
  const keys = generateTestKeypair();
  const KEY_ID = "key-temporal";
  const trustedKeys = { [KEY_ID]: keys.pubPem };

  const validFromIso = "2026-10-10T12:00:00Z";
  const expiresAtIso = "2026-10-20T12:00:00Z";
  const validFromMs = Date.parse(validFromIso);
  const expiresAtMs = Date.parse(expiresAtIso);
  const graceMs = DEFAULT_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
  const graceEndMs = expiresAtMs + graceMs;

  const doc = signLicensePayload(
    createSamplePayload({
      valid_from: validFromIso,
      expires_at: expiresAtIso,
    }),
    { privateKey: keys.privPem, keyId: KEY_ID }
  );

  it("before valid_from -> NOT_YET_VALID", () => {
    const res = verifyLicense(doc, {
      trustedKeys,
      now: new Date(validFromMs - 1000),
    });
    expect(res.valid).toBe(false);
    expect(res.state).toBe("NOT_YET_VALID");
  });

  it("exactly at valid_from -> VALID", () => {
    const res = verifyLicense(doc, {
      trustedKeys,
      now: new Date(validFromMs),
    });
    expect(res.valid).toBe(true);
    expect(res.state).toBe("VALID");
  });

  it("1ms before expires_at -> VALID", () => {
    const res = verifyLicense(doc, {
      trustedKeys,
      now: new Date(expiresAtMs - 1),
    });
    expect(res.valid).toBe(true);
    expect(res.state).toBe("VALID");
  });

  it("exactly at expires_at -> GRACE (starts grace period)", () => {
    const res = verifyLicense(doc, {
      trustedKeys,
      now: new Date(expiresAtMs),
    });
    expect(res.valid).toBe(true); // Grace allows operational continuity
    expect(res.state).toBe("GRACE");
  });

  it("middle of grace period -> GRACE", () => {
    const res = verifyLicense(doc, {
      trustedKeys,
      now: new Date(expiresAtMs + graceMs / 2),
    });
    expect(res.valid).toBe(true);
    expect(res.state).toBe("GRACE");
  });

  it("1ms before grace ends -> GRACE", () => {
    const res = verifyLicense(doc, {
      trustedKeys,
      now: new Date(graceEndMs - 1),
    });
    expect(res.valid).toBe(true);
    expect(res.state).toBe("GRACE");
  });

  it("exactly at grace end -> EXPIRED", () => {
    const res = verifyLicense(doc, {
      trustedKeys,
      now: new Date(graceEndMs),
    });
    expect(res.valid).toBe(false);
    expect(res.state).toBe("EXPIRED");
  });

  it("well past grace end -> EXPIRED", () => {
    const res = verifyLicense(doc, {
      trustedKeys,
      now: new Date(graceEndMs + 100000),
    });
    expect(res.valid).toBe(false);
    expect(res.state).toBe("EXPIRED");
  });
});

describe("Licensing — Unforgeability & Public Key Boundaries", () => {
  it("possession of public key alone cannot sign a valid license (asymmetry verification)", () => {
    const keys = generateTestKeypair();
    const payload = createSamplePayload();

    // Attempting to sign with public key must throw
    expect(() => {
      signLicensePayload(payload, {
        privateKey: keys.pubPem, // passing public key instead of private key
        keyId: "test-pub",
      });
    }).toThrow();
  });

  it("supports raw 32-byte base64url and hex public key formats in addition to PEM", () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
    const spkiDer = publicKey.export({ type: "spki", format: "der" });
    const raw32 = spkiDer.subarray(-32);
    const hex32 = raw32.toString("hex");
    const base64url32 = raw32
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const payload = createSamplePayload();
    const doc = signLicensePayload(payload, {
      privateKey,
      keyId: "raw-key-test",
    });

    // Test with hex format
    const resHex = verifyLicense(doc, {
      trustedKeys: { "raw-key-test": hex32 },
      now: new Date("2026-10-15T00:00:00Z"),
    });
    expect(resHex.valid).toBe(true);

    // Test with base64url format
    const resB64 = verifyLicense(doc, {
      trustedKeys: { "raw-key-test": base64url32 },
      now: new Date("2026-10-15T00:00:00Z"),
    });
    expect(resB64.valid).toBe(true);
  });

  it("schema rejects invalid license_type, invalid dates, and inverted ranges", () => {
    const keys = generateTestKeypair();

    expect(() => {
      signLicensePayload(
        createSamplePayload({
          license_type: "invalid_tier" as unknown as LicensePayload["license_type"],
        }),
        { privateKey: keys.privPem, keyId: "k" }
      );
    }).toThrow();

    expect(() => {
      signLicensePayload(
        createSamplePayload({
          valid_from: "2027-01-01T00:00:00Z",
          expires_at: "2026-01-01T00:00:00Z", // inverted
        }),
        { privateKey: keys.privPem, keyId: "k" }
      );
    }).toThrow();

    expect(() => {
      signLicensePayload(
        createSamplePayload({
          entitlements: {
            max_installations: 1,
            max_tenants: -5, // negative
            resale_allowed: true,
            white_label: false,
            features: [],
          },
        }),
        { privateKey: keys.privPem, keyId: "k" }
      );
    }).toThrow();
  });
});

