import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import type { LicensePayload } from "./types";
import { signLicensePayload } from "@/scripts/licensing/sign-license";
import {
  attachAttestationChallengeSignature,
  attachInstallationRecoverySignature,
  attachLicenseServerResponseSignature,
  readVerifiedOnlineValidationCache,
  verifyAttestationChallenge,
  verifyInstallationRecoveryResponse,
  verifyLicenseServerResponse,
  writeOnlineValidationCache,
  type LicenseServerResponsePayload,
} from "./online-cache";

const installationId = "inst_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
let temporaryDirectory: string | undefined;

function makePair() {
  const pair = generateKeyPairSync("ed25519");
  return {
    publicKeyPem: pair.publicKey.export({ format: "pem", type: "spki" }).toString(),
    privateKeyPem: pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
  };
}

function makeLicensePayload(): LicensePayload {
  return {
    license_version: 1,
    license_id: "lic_test_02",
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
    issued_at: "2026-11-05T12:00:00Z",
    valid_from: "2026-11-01T00:00:00Z",
    expires_at: "2027-11-01T00:00:00Z",
  };
}

function makeResponse(
  responseKey: { publicKeyPem: string; privateKeyPem: string },
  responseKeyId: string,
  licenseKey: { publicKeyPem: string; privateKeyPem: string },
  licenseKeyId: string,
) {
  const signedLicense = signLicensePayload(makeLicensePayload(), {
    privateKey: licenseKey.privateKeyPem,
    keyId: licenseKeyId,
  });
  const payload: LicenseServerResponsePayload = {
    version: 1,
    purpose: "license_server_response",
    response_type: "validation",
    installation_id: installationId,
    request_nonce: "nonce-1234567890abcdef",
    license_id: signedLicense.payload.license_id,
    license_status: "ACTIVE",
    installation_status: "ACTIVE",
    temporal_state: "VALID",
    server_time: "2026-11-05T12:00:00Z",
    next_online_validation_at: "2026-11-06T12:00:00Z",
    offline_validation_tolerance_days: 7,
    signed_license: signedLicense,
  };
  return attachLicenseServerResponseSignature(payload, responseKey.privateKeyPem, responseKeyId);
}

afterEach(async () => {
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("signed License Server response and offline cache", () => {
  it("verifies a current response key and an older license key from the trusted rotation set", () => {
    const oldLicenseKey = makePair();
    const currentResponseKey = makePair();
    const trustedKeys = {
      "clientix-license-2026-01": oldLicenseKey.publicKeyPem,
      "clientix-license-2027-01": currentResponseKey.publicKeyPem,
    };
    const response = makeResponse(
      currentResponseKey,
      "clientix-license-2027-01",
      oldLicenseKey,
      "clientix-license-2026-01",
    );

    expect(
      verifyLicenseServerResponse(response, {
        trustedKeys,
        expectedInstallationId: installationId,
        expectedNonce: "nonce-1234567890abcdef",
      }),
    ).toMatchObject({ valid: true });
  });

  it("rejects a tampered response and stores only a verified signed response in the cache", async () => {
    const pair = makePair();
    const keyId = "clientix-license-test-2026";
    const trustedKeys = { [keyId]: pair.publicKeyPem };
    const response = makeResponse(pair, keyId, pair, keyId);
    const tampered = {
      ...response,
      payload: { ...response.payload, temporal_state: "GRACE" as const },
    };
    expect(verifyLicenseServerResponse(tampered, { trustedKeys }).valid).toBe(false);

    temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-license-cache-"));
    const cachePath = path.join(temporaryDirectory, "online-validation.json");
    await writeOnlineValidationCache(response, cachePath);
    const cached = await readVerifiedOnlineValidationCache(cachePath, {
      trustedKeys,
      expectedInstallationId: installationId,
    });

    expect(cached?.response.payload.license_id).toBe("lic_test_02");
    expect(await fs.stat(cachePath).then((stat) => stat.size)).toBeGreaterThan(0);
  });

  it("validates a signed, installation- and session-bound single-use challenge", () => {
    const pair = makePair();
    const keyId = "clientix-license-attestation-test";
    const payload = {
      version: 1 as const,
      purpose: "installation_attestation_challenge" as const,
      installation_id: installationId,
      license_id: "lic_test_02",
      instance_session_id: "sess_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      request_nonce: "nonce-1234567890abcdef",
      challenge: "a".repeat(43),
      server_time: "2026-11-05T12:00:00Z",
      expires_at: "2026-11-05T12:01:00Z",
    };
    const signed = attachAttestationChallengeSignature(payload, pair.privateKeyPem, keyId);
    const trustedKeys = { [keyId]: pair.publicKeyPem };
    const expected = {
      trustedKeys,
      expectedInstallationId: installationId,
      expectedLicenseId: "lic_test_02",
      expectedSessionId: payload.instance_session_id,
      expectedNonce: payload.request_nonce,
    };

    expect(verifyAttestationChallenge(signed, expected).valid).toBe(true);
    expect(
      verifyAttestationChallenge(
        {
          ...signed,
          payload: {
            ...signed.payload,
            instance_session_id: "sess_11111111-2222-4333-8444-555555555555",
          },
        },
        expected,
      ).valid,
    ).toBe(false);
    expect(
      verifyAttestationChallenge(
        { ...signed, payload: { ...signed.payload, challenge: "b".repeat(43) } },
        expected,
      ).valid,
    ).toBe(false);
  });

  it("accepts only vendor-signed recovery bound to the candidate public key fingerprint", () => {
    const pair = makePair();
    const keyId = "clientix-license-recovery-test";
    const fingerprint = "c".repeat(64);
    const payload = {
      version: 1 as const,
      purpose: "installation_recovery" as const,
      installation_id: installationId,
      request_nonce: "nonce-1234567890abcdef",
      public_key_fingerprint: fingerprint,
      clone_status: "NORMAL" as const,
      server_time: "2026-11-05T12:00:00Z",
    };
    const signed = attachInstallationRecoverySignature(payload, pair.privateKeyPem, keyId);
    const expected = {
      installationId,
      requestNonce: payload.request_nonce,
      publicKeyFingerprint: fingerprint,
    };

    expect(
      verifyInstallationRecoveryResponse(signed, expected, { [keyId]: pair.publicKeyPem }),
    ).toBe(true);
    expect(
      verifyInstallationRecoveryResponse(
        signed,
        { ...expected, publicKeyFingerprint: "d".repeat(64) },
        {
          [keyId]: pair.publicKeyPem,
        },
      ),
    ).toBe(false);
  });
});
