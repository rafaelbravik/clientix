import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { observeLicenseClock, CLOCK_ROLLBACK_TOLERANCE_MS } from "@/lib/licensing/clock";
import { createLicenseAdminSummary } from "@/lib/licensing/admin-view";
import {
  getLicenseEnforcementMode,
  getInstallationLicenseStatus,
  resetLicenseCache,
} from "@/lib/licensing/enforcement";
import { DEFAULT_GRACE_PERIOD_DAYS } from "@/lib/licensing/schema";
import { verifyLicense } from "@/lib/licensing/verify";
import type { LicensePayload } from "@/lib/licensing/types";
import { signLicensePayload } from "@/scripts/licensing/sign-license";

const installationId = "inst_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const publicKeyPem = publicKey.export({ format: "pem", type: "spki" }).toString();
const privateKeyPem = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const keyId = "lic-01-synthetic-test-key";
const trustedKeys = { [keyId]: publicKeyPem };
let temporaryDirectory: string | undefined;

function payload(overrides: Partial<LicensePayload> = {}): LicensePayload {
  return {
    license_version: 1,
    license_id: "lic_2026_test_serial",
    serial: "CLX-2026-ABCD-WXYZ",
    customer: { id: "customer-test", name: "Synthetic customer" },
    license_type: "enterprise",
    plan: "pro",
    product: "clientix",
    deployment: "self-hosted",
    installation_id: installationId,
    entitlements: {
      max_installations: 1,
      max_tenants: 5,
      resale_allowed: false,
      white_label: false,
      features: ["messages"],
    },
    issued_at: "2026-11-01T00:00:00Z",
    valid_from: "2026-11-01T00:00:00Z",
    expires_at: "2026-11-20T00:00:00Z",
    ...overrides,
  };
}

function sign(overrides: Partial<LicensePayload> = {}) {
  return signLicensePayload(payload(overrides), { privateKey: privateKeyPem, keyId });
}

async function tempDir(): Promise<string> {
  temporaryDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-lic01-"));
  return temporaryDirectory;
}

afterEach(async () => {
  resetLicenseCache();
  vi.unstubAllEnvs();
  if (temporaryDirectory) await fs.rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("LIC-01 license contract", () => {
  it("uses the signed per-license grace period and the seven-day default", () => {
    expect(DEFAULT_GRACE_PERIOD_DAYS).toBe(7);
    const doc = sign({ grace_period_days: 2 });
    const state = verifyLicense(doc, {
      trustedKeys,
      expectedInstallationId: installationId,
      now: new Date("2026-11-22T00:00:00Z"),
    });
    expect(state).toMatchObject({ state: "EXPIRED", usable: false, grace_period_days: 2 });
  });

  it("recognizes a signed revocation without treating it as a usable license", () => {
    const state = verifyLicense(sign({ status: "REVOKED" }), {
      trustedKeys,
      expectedInstallationId: installationId,
      now: new Date("2026-11-05T00:00:00Z"),
    });
    expect(state).toMatchObject({
      state: "REVOKED",
      usable: false,
      cryptographic_valid: true,
      errorCode: "LICENSE_REVOKED",
    });
  });

  it("rejects a trusted signature for another product and an unknown signed status", () => {
    const wrongProduct = verifyLicense(sign({ product: "another-product" }), {
      trustedKeys,
      expectedInstallationId: installationId,
    });
    expect(wrongProduct).toMatchObject({
      usable: false,
      state: "MALFORMED_DOCUMENT",
      errorCode: "LICENSE_PRODUCT_MISMATCH",
    });

    const unknownStatusDocument = sign();
    unknownStatusDocument.payload.status = "UNKNOWN" as "ACTIVE";
    const unknownStatus = verifyLicense(unknownStatusDocument, { trustedKeys });
    expect(unknownStatus).toMatchObject({ usable: false, state: "MALFORMED_DOCUMENT" });
  });

  it("does not expose installation identifiers in an installation mismatch reason", () => {
    const otherInstallationId = "inst_11111111-2222-4333-8444-555555555555";
    const result = verifyLicense(sign({ installation_id: otherInstallationId }), {
      trustedKeys,
      expectedInstallationId: installationId,
    });

    expect(result.state).toBe("INSTALLATION_MISMATCH");
    expect(result.reason).toBe("A licença foi emitida para outra instalação.");
    expect(result.reason).not.toContain(installationId);
    expect(result.reason).not.toContain(otherInstallationId);
  });

  it("rejects unrecognized payload fields instead of ignoring possible tampering", () => {
    const original = sign();
    const altered = {
      ...original,
      payload: { ...original.payload, unrecognized_claim: true },
    };
    expect(verifyLicense(altered, { trustedKeys }).usable).toBe(false);
    expect(verifyLicense(altered, { trustedKeys }).state).toBe("MALFORMED_DOCUMENT");
  });

  it("keeps the local plan informational and masks identifiers in the admin view", async () => {
    const directory = await tempDir();
    const licensePath = path.join(directory, "license.json");
    const installationIdPath = path.join(directory, "installation_id");
    await fs.writeFile(licensePath, JSON.stringify(sign()), "utf-8");
    await fs.writeFile(installationIdPath, `${installationId}\n`, "utf-8");

    const status = await getInstallationLicenseStatus({
      licensePath,
      installationIdPath,
      trustedKeys,
      now: new Date("2026-11-05T00:00:00Z"),
    });
    const summary = createLicenseAdminSummary(status, new Date("2026-11-05T00:00:00Z"));
    expect(status.plan).toBe("pro");
    expect(status.entitlements?.max_tenants).toBe(5);
    expect(status).not.toHaveProperty("tenant_plan");
    expect(status.installation_id_expected).toBe(installationId);
    expect(summary).toMatchObject({
      status: "ACTIVE",
      serial_masked: "CLX-••••-••••-WXYZ",
      installation_id_masked: "inst_aaaa…eeee",
      plan: "pro",
    });
    expect(JSON.stringify(summary)).not.toContain(installationId);
    expect(JSON.stringify(summary)).not.toContain("lic_2026_test_serial");
    expect(JSON.stringify(summary)).not.toContain("Synthetic customer");
  });
});

describe("LIC-01 local clock and enforcement mode", () => {
  it("persists a monotonic local baseline and detects a large rollback without blocking", async () => {
    const directory = await tempDir();
    const baselinePath = path.join(directory, "license_clock.json");
    const forward = await observeLicenseClock(new Date("2026-11-05T12:00:00Z"), baselinePath);
    expect(forward).toMatchObject({ rollback_suspected: false, baseline_available: true });

    const rollback = await observeLicenseClock(
      new Date(Date.parse("2026-11-05T12:00:00Z") - CLOCK_ROLLBACK_TOLERANCE_MS - 1000),
      baselinePath,
    );
    expect(rollback.rollback_suspected).toBe(true);
    expect(rollback.last_seen_at).toBe("2026-11-05T12:00:00.000Z");
    expect(JSON.parse(await fs.readFile(baselinePath, "utf-8")).last_seen_at).toBe(
      rollback.last_seen_at,
    );
  });

  it("allows explicit local warn mode but always enforces in production", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("CLIENTIX_LICENSE_ENFORCEMENT", "warn");
    expect(getLicenseEnforcementMode()).toBe("warn");

    vi.stubEnv("NODE_ENV", "production");
    expect(getLicenseEnforcementMode()).toBe("enforce");
  });
});
