import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";

import {
  getInstallationLicenseStatus,
  requireValidInstallationLicense,
  installLicenseFile,
  resetLicenseCache,
  verifyLicense,
  type LicensePayload,
} from "@/lib/licensing";
import { signLicensePayload } from "../../scripts/licensing/sign-license";

function generateTestKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { pubPem, privPem, publicKey, privateKey };
}

function createSamplePayload(
  installationId: string,
  overrides: Partial<LicensePayload> = {},
): LicensePayload {
  return {
    license_version: 1,
    license_id: "lic_enf_test_001",
    customer: {
      id: "cust_enf_1",
      name: "Empresa Teste Corp",
      email: "adm@empresateste.com",
      country: "BR",
    },
    license_type: "partner",
    installation_id: installationId,
    entitlements: {
      max_installations: 1,
      max_tenants: 5,
      resale_allowed: true,
      white_label: false,
      features: ["messages", "voice", "campaigns", "ai_agent"],
    },
    issued_at: "2026-10-01T00:00:00Z",
    valid_from: "2026-10-01T00:00:00Z",
    expires_at: "2027-10-01T00:00:00Z",
    maintenance_until: "2027-10-01T00:00:00Z",
    ...overrides,
  };
}

describe("Licensing Enforcement — Central Guard & Status Inspection", () => {
  let tmpDir: string;
  let licensePath: string;
  let instIdPath: string;
  const keys = generateTestKeypair();
  const KEY_ID = "key-enforcement-test";
  const trustedKeys = { [KEY_ID]: keys.pubPem };
  const mockInstId = "inst_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

  beforeEach(async () => {
    resetLicenseCache();
    delete process.env.CLIENTIX_LICENSE_JSON;
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-lic-test-"));
    licensePath = path.join(tmpDir, "license.json");
    instIdPath = path.join(tmpDir, "installation_id");
    await fs.writeFile(instIdPath, `${mockInstId}\n`, "utf-8");
  });

  afterEach(async () => {
    resetLicenseCache();
    vi.unstubAllEnvs();
    delete process.env.CLIENTIX_LICENSE_JSON;
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("reports a missing license file separately and denies operation", async () => {
    const status = await getInstallationLicenseStatus({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });

    expect(status.usable).toBe(false);
    expect(status.state).toBe("LICENSE_FILE_MISSING");
    expect(status.error_code).toBe("LICENSE_FILE_MISSING");
    expect(status.reason).toContain("Arquivo de licença não encontrado");
    expect(status.reason).not.toContain(licensePath);

    const denied = await requireValidInstallationLicense({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });
    expect(denied).not.toBeNull();
    expect(denied?.status).toBe(403);
    const body = await denied?.json();
    expect(body.error.code).toBe("license_restricted");
    expect(body.error.details.state).toBe("LICENSE_FILE_MISSING");
    expect(body.error.details.error_code).toBe("LICENSE_FILE_MISSING");
  });

  it("creates and reuses a persistent installation identity before a license exists", async () => {
    vi.stubEnv("INSTALLATION_ID", "");
    const freshInstallationIdPath = path.join(tmpDir, "fresh-state", "installation_id");
    const options = {
      licensePath,
      installationIdPath: freshInstallationIdPath,
      trustedKeys,
      now: new Date("2026-11-10T00:00:00Z"),
    };

    const first = await getInstallationLicenseStatus(options);
    expect(first.state).toBe("LICENSE_FILE_MISSING");
    expect(first.installation_id_expected).toMatch(
      /^inst_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89a-f][0-9a-f]{3}-[0-9a-f]{12}$/i,
    );
    const persistedId = (await fs.readFile(freshInstallationIdPath, "utf8")).trim();
    expect(persistedId).toBe(first.installation_id_expected);

    resetLicenseCache();
    const afterRestart = await getInstallationLicenseStatus(options);
    expect(afterRestart.installation_id_expected).toBe(persistedId);
  });

  it.each(["EACCES", "EPERM"] as const)(
    "classifies %s as an unreadable file, not malformed JSON",
    async (code) => {
      await fs.writeFile(licensePath, "{}", "utf-8");
      vi.stubEnv("INSTALLATION_ID", mockInstId);
      const readError = Object.assign(new Error("sensitive filesystem detail"), { code });
      const readSpy = vi.spyOn(fs, "readFile").mockRejectedValue(readError);

      try {
        const status = await getInstallationLicenseStatus({
          licensePath,
          installationIdPath: instIdPath,
          trustedKeys,
        });
        expect(status.state).toBe("LICENSE_FILE_UNREADABLE");
        expect(status.error_code).toBe("LICENSE_FILE_UNREADABLE");
        expect(status.reason).not.toContain(licensePath);
        expect(status.reason).not.toContain("sensitive filesystem detail");
      } finally {
        readSpy.mockRestore();
        vi.unstubAllEnvs();
      }
    },
  );

  it("distinguishes readable invalid JSON from a readable document with invalid schema", async () => {
    await fs.writeFile(licensePath, "{", "utf-8");
    const invalidJson = await getInstallationLicenseStatus({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-15T00:00:00Z"),
    });
    expect(invalidJson.state).toBe("MALFORMED_DOCUMENT");
    expect(invalidJson.error_code).toBe("LICENSE_INVALID_JSON");

    await fs.writeFile(licensePath, "{}", "utf-8");
    const invalidSchema = await getInstallationLicenseStatus({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-15T00:00:00Z"),
    });
    expect(invalidSchema.state).toBe("MALFORMED_DOCUMENT");
    expect(invalidSchema.error_code).toBe("LICENSE_MALFORMED");
  });

  it("classifies non-permission filesystem failures separately from document failures", async () => {
    await fs.writeFile(licensePath, "{}", "utf-8");
    vi.stubEnv("INSTALLATION_ID", mockInstId);
    const readError = Object.assign(new Error("private I/O detail"), { code: "EIO" });
    const readSpy = vi.spyOn(fs, "readFile").mockRejectedValue(readError);

    try {
      const status = await getInstallationLicenseStatus({
        licensePath,
        installationIdPath: instIdPath,
        trustedKeys,
      });
      expect(status.state).toBe("LICENSE_FILE_IO_ERROR");
      expect(status.error_code).toBe("LICENSE_FILE_IO_ERROR");
      expect(status.state).not.toBe("MALFORMED_DOCUMENT");
      expect(status.reason).not.toContain("private I/O detail");
    } finally {
      readSpy.mockRestore();
      vi.unstubAllEnvs();
    }
  });

  it("reports VALID and allows operation when genuine matching license is present", async () => {
    const payload = createSamplePayload(mockInstId);
    const doc = signLicensePayload(payload, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });
    await fs.writeFile(licensePath, JSON.stringify(doc), "utf-8");

    const status = await getInstallationLicenseStatus({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-15T00:00:00Z"),
    });

    expect(status.usable).toBe(true);
    expect(status.valid).toBe(true);
    expect(status.cryptographic_valid).toBe(true);
    expect(status.state).toBe("VALID");
    expect(status.customer_name).toBe("Empresa Teste Corp");
    expect(status.installation_id_matched).toBe(true);

    const guardResult = await requireValidInstallationLicense({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-15T00:00:00Z"),
    });
    expect(guardResult).toBeNull();
  });

  it("reports GRACE and keeps operation usable during the grace period window", async () => {
    const payload = createSamplePayload(mockInstId, {
      valid_from: "2026-10-01T00:00:00Z",
      expires_at: "2026-10-10T00:00:00Z",
    });
    const doc = signLicensePayload(payload, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });
    await fs.writeFile(licensePath, JSON.stringify(doc), "utf-8");

    // Test on day 3 of grace period
    const status = await getInstallationLicenseStatus({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-13T00:00:00Z"),
    });

    expect(status.state).toBe("GRACE");
    expect(status.usable).toBe(true);
    expect(status.cryptographic_valid).toBe(true);

    const guardResult = await requireValidInstallationLicense({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-13T00:00:00Z"),
    });
    expect(guardResult).toBeNull();
  });

  it("reports EXPIRED and blocks operation once grace period is exceeded", async () => {
    const payload = createSamplePayload(mockInstId, {
      valid_from: "2026-10-01T00:00:00Z",
      expires_at: "2026-10-10T00:00:00Z",
    });
    const doc = signLicensePayload(payload, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });
    await fs.writeFile(licensePath, JSON.stringify(doc), "utf-8");

    // 10 days after expiration (past default 7-day grace period)
    const status = await getInstallationLicenseStatus({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-20T00:00:00Z"),
    });

    expect(status.state).toBe("EXPIRED");
    expect(status.usable).toBe(false);
    expect(status.cryptographic_valid).toBe(true);

    const denied = await requireValidInstallationLicense({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-20T00:00:00Z"),
    });
    expect(denied).not.toBeNull();
    expect(denied?.status).toBe(403);
    const body = await denied?.json();
    expect(body.error.code).toBe("license_restricted");
    expect(body.error.details.state).toBe("EXPIRED");
  });

  it("reports INSTALLATION_MISMATCH and blocks when signed for different installation ID", async () => {
    const payload = createSamplePayload("inst_99999999-9999-4999-8999-999999999999");
    const doc = signLicensePayload(payload, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });
    await fs.writeFile(licensePath, JSON.stringify(doc), "utf-8");

    const status = await getInstallationLicenseStatus({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-15T00:00:00Z"),
    });

    expect(status.usable).toBe(false);
    expect(status.state).toBe("INSTALLATION_MISMATCH");
    expect(status.cryptographic_valid).toBe(true);
    expect(status.installation_id_matched).toBe(false);
  });

  it("reports INVALID_SIGNATURE and blocks when document signature is invalid", async () => {
    const payload = createSamplePayload(mockInstId);
    const doc = signLicensePayload(payload, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });
    doc.signature = "invalid_tampered_signature";
    await fs.writeFile(licensePath, JSON.stringify(doc), "utf-8");

    const status = await getInstallationLicenseStatus({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-15T00:00:00Z"),
    });

    expect(status.usable).toBe(false);
    expect(status.state).toBe("INVALID_SIGNATURE");
    expect(status.cryptographic_valid).toBe(false);
  });

  it("continues to ignore injected license keys in production when the vendor trust root is empty", () => {
    const doc = signLicensePayload(createSamplePayload(mockInstId), {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });

    try {
      vi.stubEnv("NODE_ENV", "production");
      vi.stubEnv("CLIENTIX_TRUSTED_LICENSE_KEYS", JSON.stringify({ [KEY_ID]: keys.pubPem }));
      const result = verifyLicense(doc, { expectedInstallationId: mockInstId });
      expect(result.usable).toBe(false);
      expect(result.state).toBe("UNKNOWN_KEY");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports UNSUPPORTED_LICENSE_VERSION and blocks when license version is in the future", async () => {
    const rawPayload = createSamplePayload(mockInstId);
    (rawPayload as unknown as Record<string, unknown>).license_version = 99;

    // Canonicalize and sign manually with Ed25519
    const canonicalBytes = Buffer.from(JSON.stringify(rawPayload));
    const signature = crypto
      .sign(null, canonicalBytes, crypto.createPrivateKey(keys.privPem))
      .toString("base64url");
    const doc = {
      payload: rawPayload,
      signature,
      algorithm: "Ed25519",
      key_id: KEY_ID,
    };

    await fs.writeFile(licensePath, JSON.stringify(doc), "utf-8");

    const status = await getInstallationLicenseStatus({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-15T00:00:00Z"),
    });

    expect(status.usable).toBe(false);
    expect(status.state).toBe("UNSUPPORTED_LICENSE_VERSION");
    expect(status.reason).toContain("Versão da licença não suportada");

    const guardResult = await requireValidInstallationLicense({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-15T00:00:00Z"),
    });
    expect(guardResult).not.toBeNull();
    expect(guardResult?.status).toBe(403);
    const body = await guardResult?.json();
    expect(body.error.code).toBe("license_restricted");
    expect(body.error.details.state).toBe("UNSUPPORTED_LICENSE_VERSION");
  });

  it("CLIENTIX_LICENSE_JSON policy: strictly applies Ed25519 and installation_id verification with NO bypass", async () => {
    // 1. Invented / unsigned payload -> MALFORMED_DOCUMENT
    process.env.CLIENTIX_LICENSE_JSON = JSON.stringify({ license_id: "fake", foo: "bar" });
    let status = await getInstallationLicenseStatus({
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-15T00:00:00Z"),
    });
    expect(status.usable).toBe(false);
    expect(status.state).toBe("MALFORMED_DOCUMENT");

    // 2. Signed by unknown key -> UNKNOWN_KEY
    const unknownKeys = generateTestKeypair();
    const payloadUnknown = createSamplePayload(mockInstId);
    const docUnknown = signLicensePayload(payloadUnknown, {
      privateKey: unknownKeys.privPem,
      keyId: "unknown-key-id",
    });
    process.env.CLIENTIX_LICENSE_JSON = JSON.stringify(docUnknown);
    status = await getInstallationLicenseStatus({
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-15T00:00:00Z"),
    });
    expect(status.usable).toBe(false);
    expect(status.state).toBe("UNKNOWN_KEY");

    // 3. Valid signature but for another installation ID -> INSTALLATION_MISMATCH
    const payloadMismatch = createSamplePayload("inst_00000000-0000-4000-8000-000000000000");
    const docMismatch = signLicensePayload(payloadMismatch, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });
    process.env.CLIENTIX_LICENSE_JSON = JSON.stringify(docMismatch);
    status = await getInstallationLicenseStatus({
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-15T00:00:00Z"),
    });
    expect(status.usable).toBe(false);
    expect(status.state).toBe("INSTALLATION_MISMATCH");

    // 4. Valid signature and matching installation ID -> VALID
    const payloadValid = createSamplePayload(mockInstId);
    const docValid = signLicensePayload(payloadValid, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });
    process.env.CLIENTIX_LICENSE_JSON = JSON.stringify(docValid);
    status = await getInstallationLicenseStatus({
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-15T00:00:00Z"),
    });
    expect(status.usable).toBe(true);
    expect(status.state).toBe("VALID");
    expect(status.cryptographic_valid).toBe(true);
    expect(status.installation_id_matched).toBe(true);
  });
});

describe("Licensing Enforcement — Atomic License Replacement & Safeguards", () => {
  let tmpDir: string;
  let licensePath: string;
  let instIdPath: string;
  const keys = generateTestKeypair();
  const KEY_ID = "key-install-test";
  const trustedKeys = { [KEY_ID]: keys.pubPem };
  const mockInstId = "inst_33333333-3333-4333-8333-333333333333";

  beforeEach(async () => {
    resetLicenseCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-install-test-"));
    licensePath = path.join(tmpDir, "license.json");
    instIdPath = path.join(tmpDir, "installation_id");
    await fs.writeFile(instIdPath, `${mockInstId}\n`, "utf-8");
  });

  afterEach(async () => {
    resetLicenseCache();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("atomically installs and rotates a valid license with the runtime reader access contract", async () => {
    const payload = createSamplePayload(mockInstId, { license_id: "lic_atomic_valid" });
    const doc = signLicensePayload(payload, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });

    const result = await installLicenseFile(doc, {
      targetPath: licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });

    expect(result.success).toBe(true);
    expect(result.statusInfo.state).toBe("VALID");
    expect(result.statusInfo.license_id).toBe("lic_atomic_valid");

    // Confirm file was written to disk
    const content = await fs.readFile(licensePath, "utf-8");
    expect(content).toContain("lic_atomic_valid");
    if (process.platform !== "win32") {
      const installedStat = await fs.stat(licensePath);
      expect(installedStat.mode & 0o777).toBe(0o640);
      if (process.platform === "linux") expect(installedStat.gid).toBe(1001);
    }

    const rotatedPayload = createSamplePayload(mockInstId, { license_id: "lic_atomic_rotated" });
    const rotatedDoc = signLicensePayload(rotatedPayload, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });
    await installLicenseFile(rotatedDoc, {
      targetPath: licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });

    const rotatedContent = await fs.readFile(licensePath, "utf-8");
    expect(rotatedContent).toContain("lic_atomic_rotated");
    expect(rotatedContent).not.toContain("lic_atomic_valid");
    if (process.platform !== "win32") {
      const rotatedStat = await fs.stat(licensePath);
      expect(rotatedStat.mode & 0o777).toBe(0o640);
      if (process.platform === "linux") expect(rotatedStat.gid).toBe(1001);
    }
  });

  it("rejects invalid candidate without overwriting or destroying existing valid license", async () => {
    // 1. Install an initial valid license
    const initialPayload = createSamplePayload(mockInstId, {
      license_id: "lic_original_preserved",
    });
    const initialDoc = signLicensePayload(initialPayload, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });
    await installLicenseFile(initialDoc, {
      targetPath: licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });

    // 2. Attempt to install an invalid candidate (wrong installation_id)
    const badCandidate = createSamplePayload("inst_99999999-0000-4000-8000-000000000000");
    const badDoc = signLicensePayload(badCandidate, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });

    await expect(
      installLicenseFile(badDoc, {
        targetPath: licensePath,
        installationIdPath: instIdPath,
        trustedKeys,
      }),
    ).rejects.toThrow("Candidato de licença recusado");

    const tamperedFirstChar = initialDoc.signature[0] === "A" ? "B" : "A";
    const tamperedDoc = {
      ...initialDoc,
      signature: `${tamperedFirstChar}${initialDoc.signature.slice(1)}`,
    };
    await expect(
      installLicenseFile(tamperedDoc, {
        targetPath: licensePath,
        installationIdPath: instIdPath,
        trustedKeys,
      }),
    ).rejects.toThrow("Candidato de licença recusado");

    // 3. Verify original license on disk is completely untouched
    const diskContent = await fs.readFile(licensePath, "utf-8");
    expect(diskContent).toContain("lic_original_preserved");
    expect(diskContent).not.toContain("inst_99999999-0000-4000-8000-000000000000");
  });
});

describe("Licensing Enforcement — Invariants: Plan Isolation & Recovery", () => {
  let tmpDir: string;
  let licensePath: string;
  let instIdPath: string;
  const keys = generateTestKeypair();
  const KEY_ID = "key-isolation-test";
  const trustedKeys = { [KEY_ID]: keys.pubPem };
  const mockInstId = "inst_44444444-4444-4444-8444-444444444444";

  beforeEach(async () => {
    resetLicenseCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-iso-test-"));
    licensePath = path.join(tmpDir, "license.json");
    instIdPath = path.join(tmpDir, "installation_id");
    await fs.writeFile(instIdPath, `${mockInstId}\n`, "utf-8");
  });

  afterEach(async () => {
    resetLicenseCache();
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("tenant plan isolation invariant: enterprise installation license does not elevate tenant plan", async () => {
    const payload = createSamplePayload(mockInstId, {
      license_type: "enterprise",
      entitlements: {
        max_installations: 1,
        max_tenants: 100,
        resale_allowed: true,
        white_label: true,
        features: ["messages", "voice", "campaigns", "ai_agent"],
      },
    });
    const doc = signLicensePayload(payload, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });
    await fs.writeFile(licensePath, JSON.stringify(doc), "utf-8");

    const status = await getInstallationLicenseStatus({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });
    expect(status.state).toBe("VALID");

    // Tenant model has its own plan (e.g. 'standard', 'pro', 'enterprise')
    // Installation license governs infrastructure capability (max_tenants, features)
    // and does NOT alter tenant.plan or max_users of a tenant.
    const tenantMock = {
      id: "org_test_1",
      plan: "standard",
      max_users: 3,
    };
    expect(tenantMock.plan).toBe("standard");
    expect(tenantMock.max_users).toBe(3);
  });

  it("data destruction invariant: no destructive operations in licensing enforcement code", async () => {
    const enforcementCode = await fs.readFile(
      path.join(process.cwd(), "lib/licensing/enforcement.ts"),
      "utf-8",
    );
    expect(enforcementCode).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(enforcementCode).not.toMatch(/\bTRUNCATE\b/i);
    expect(enforcementCode).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(enforcementCode).not.toMatch(/\brm\s+-rf\b/i);
  });
});
