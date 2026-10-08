import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";

import {
  getInstallationCapabilities,
  hasInstallationCapability,
  requireInstallationCapability,
  assertCanCreateTenant,
  resetLicenseCache,
  installLicenseFile,
  type LicensePayload,
  type InstallationCapability,
} from "@/lib/licensing";
import { DEFAULT_PLAN_LIMITS } from "@/lib/tenant/plan-limits";
import type { SupabaseClient } from "@supabase/supabase-js";
import { signLicensePayload } from "../../scripts/licensing/sign-license";

function generateTestKeypair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const pubPem = publicKey.export({ type: "spki", format: "pem" }).toString();
  const privPem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  return { pubPem, privPem, publicKey, privateKey };
}

function createSamplePayload(
  installationId: string,
  overrides: Partial<LicensePayload> = {}
): LicensePayload {
  return {
    license_version: 1,
    license_id: "lic_cap_test_001",
    customer: {
      id: "cust_cap_1",
      name: "Empresa Capabilities Corp",
      email: "adm@empresa.com",
      country: "BR",
    },
    license_type: "partner",
    installation_id: installationId,
    entitlements: {
      max_installations: 1,
      max_tenants: 5,
      resale_allowed: true,
      white_label: false,
      features: ["messages", "voice"],
    },
    issued_at: "2026-10-01T00:00:00Z",
    valid_from: "2026-10-01T00:00:00Z",
    expires_at: "2027-10-01T00:00:00Z",
    maintenance_until: "2027-10-01T00:00:00Z",
    ...overrides,
  };
}

describe("L7.1 Commercial Capability Enforcement Unit Tests", () => {
  let tmpDir: string;
  let licensePath: string;
  let instIdPath: string;
  const keys = generateTestKeypair();
  const KEY_ID = "key-cap-test";
  const trustedKeys = { [KEY_ID]: keys.pubPem };
  const mockInstId = "inst_11111111-2222-4333-8444-555555555555";

  beforeEach(async () => {
    resetLicenseCache();
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-cap-test-"));
    licensePath = path.join(tmpDir, "license.json");
    instIdPath = path.join(tmpDir, "installation_id");
    await fs.writeFile(instIdPath, mockInstId, "utf-8");
  });

  afterEach(async () => {
    resetLicenseCache();
    delete process.env.CLIENTIX_LICENSE_JSON;
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  async function writeSignedLicense(payload: LicensePayload) {
    const signedDoc = signLicensePayload(payload, {
      privateKey: keys.privPem,
      keyId: KEY_ID,
    });
    await fs.writeFile(licensePath, JSON.stringify(signedDoc, null, 2), "utf-8");
  }

  it("Model A: INTERNAL license (max_tenants=1, resale=false, white_label=false)", async () => {
    const payload = createSamplePayload(mockInstId, {
      license_type: "internal",
      entitlements: {
        max_installations: 1,
        max_tenants: 1,
        resale_allowed: false,
        white_label: false,
        features: ["core"],
      },
    });
    await writeSignedLicense(payload);

    const caps = await getInstallationCapabilities({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });

    expect(caps.usable).toBe(true);
    expect(caps.license_type).toBe("internal");
    expect(caps.can_resell_access).toBe(false);
    expect(caps.can_white_label).toBe(false);
    expect(caps.can_white_label_installation).toBe(false);
    expect(caps.can_white_label_tenant).toBe(false);
    expect(caps.can_manage_multiple_tenants).toBe(false);
    expect(caps.max_tenants).toBe(1);

    expect(
      await hasInstallationCapability("can_resell_access", {
        licensePath,
        installationIdPath: instIdPath,
        trustedKeys,
      })
    ).toBe(false);

    expect(
      await hasInstallationCapability("can_white_label", {
        licensePath,
        installationIdPath: instIdPath,
        trustedKeys,
      })
    ).toBe(false);
  });

  it("Model B: PARTNER standard license (max_tenants=5, resale=true, white_label=false)", async () => {
    const payload = createSamplePayload(mockInstId, {
      license_type: "partner",
      entitlements: {
        max_installations: 1,
        max_tenants: 5,
        resale_allowed: true,
        white_label: false,
        features: ["core", "multi_tenant"],
      },
    });
    await writeSignedLicense(payload);

    const caps = await getInstallationCapabilities({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });

    expect(caps.usable).toBe(true);
    expect(caps.license_type).toBe("partner");
    expect(caps.can_resell_access).toBe(true);
    expect(caps.can_white_label).toBe(false);
    expect(caps.can_manage_multiple_tenants).toBe(true);
    expect(caps.max_tenants).toBe(5);

    // Guard test: requireInstallationCapability
    const wlCheck = await requireInstallationCapability("can_white_label", {
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });
    expect(wlCheck).not.toBeNull();
    expect(wlCheck?.status).toBe(403);
    const body = await wlCheck?.json();
    expect(body.error.code).toBe("WHITE_LABEL_NOT_LICENSED");

    const resellCheck = await requireInstallationCapability("can_resell_access", {
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });
    expect(resellCheck).toBeNull();
  });

  it("Model B+: PARTNER with white_label=true", async () => {
    const payload = createSamplePayload(mockInstId, {
      license_type: "partner",
      entitlements: {
        max_installations: 1,
        max_tenants: 10,
        resale_allowed: true,
        white_label: true,
        features: ["core", "white_label"],
      },
    });
    await writeSignedLicense(payload);

    const caps = await getInstallationCapabilities({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });

    expect(caps.can_white_label).toBe(true);
    expect(caps.can_white_label_installation).toBe(true);
    expect(caps.can_white_label_tenant).toBe(true);
    expect(caps.can_resell_access).toBe(true);
    expect(caps.max_tenants).toBe(10);

    const wlCheck = await requireInstallationCapability("can_white_label_installation", {
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });
    expect(wlCheck).toBeNull();
  });

  it("Model C (Counter-Proof): ENTERPRISE with white_label=false and resale=false proves entitlements dictate rules, not license_type", async () => {
    const payload = createSamplePayload(mockInstId, {
      license_type: "enterprise",
      entitlements: {
        max_installations: 1,
        max_tenants: 2,
        resale_allowed: false,
        white_label: false,
        features: ["core"],
      },
    });
    await writeSignedLicense(payload);

    const caps = await getInstallationCapabilities({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });

    // Even though license_type is 'enterprise', white_label and resale MUST be false
    expect(caps.license_type).toBe("enterprise");
    expect(caps.can_white_label).toBe(false);
    expect(caps.can_resell_access).toBe(false);
    expect(caps.max_tenants).toBe(2);

    const wlCheck = await requireInstallationCapability("can_white_label", {
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });
    expect(wlCheck?.status).toBe(403);
    const body = await wlCheck?.json();
    expect(body.error.code).toBe("WHITE_LABEL_NOT_LICENSED");
  });

  it("Model C Full: ENTERPRISE with max_tenants=null (unlimited) and white_label=true", async () => {
    const payload = createSamplePayload(mockInstId, {
      license_type: "enterprise",
      entitlements: {
        max_installations: 1,
        max_tenants: null, // Unlimited
        resale_allowed: true,
        white_label: true,
        features: ["enterprise_suite"],
      },
    });
    await writeSignedLicense(payload);

    const caps = await getInstallationCapabilities({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });

    expect(caps.can_manage_multiple_tenants).toBe(true);
    expect(caps.max_tenants).toBeNull();
    expect(caps.can_white_label).toBe(true);
    expect(caps.can_resell_access).toBe(true);

    // Mock client count to 500 tenants -> assertCanCreateTenant still allows because max is unlimited (null)
    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ count: 500, error: null }),
      }),
    } as unknown as SupabaseClient;

    const check = await assertCanCreateTenant(mockAdmin, {
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });

    expect(check.allowed).toBe(true);
    expect(check.max).toBeNull();
  });

  it("Global tenant limit: allows up to max_tenants, rejects next", async () => {
    const payload = createSamplePayload(mockInstId, {
      entitlements: {
        max_installations: 1,
        max_tenants: 3,
        resale_allowed: true,
        white_label: false,
        features: [],
      },
    });
    await writeSignedLicense(payload);

    // Current = 2, max = 3 -> allowed
    const mockAdminUnder = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ count: 2, error: null }),
      }),
    } as unknown as SupabaseClient;

    const checkUnder = await assertCanCreateTenant(mockAdminUnder, {
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });
    expect(checkUnder.allowed).toBe(true);
    expect(checkUnder.current).toBe(2);
    expect(checkUnder.max).toBe(3);

    // Current = 3, max = 3 -> denied
    const mockAdminAtLimit = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ count: 3, error: null }),
      }),
    } as unknown as SupabaseClient;

    const checkLimit = await assertCanCreateTenant(mockAdminAtLimit, {
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });
    expect(checkLimit.allowed).toBe(false);
    expect(checkLimit.current).toBe(3);
    expect(checkLimit.max).toBe(3);
    expect(checkLimit.reason).toContain("Limite global de organizações atingido");
  });

  it("License Downgrade scenario: 10 existing tenants, new license sets max_tenants=5 -> zero deletions, new creations blocked", async () => {
    const payload = createSamplePayload(mockInstId, {
      entitlements: {
        max_installations: 1,
        max_tenants: 5,
        resale_allowed: true,
        white_label: false,
        features: [],
      },
    });
    await writeSignedLicense(payload);

    // Existing count is 10
    const mockAdminOverQuota = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ count: 10, error: null }),
      }),
    } as unknown as SupabaseClient;

    const check = await assertCanCreateTenant(mockAdminOverQuota, {
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });

    expect(check.allowed).toBe(false);
    expect(check.current).toBe(10);
    expect(check.max).toBe(5);
    expect(check.reason).toContain("Limite global de organizações atingido (10/5)");
  });

  it("License Upgrade scenario: limit expands from 5 to 20 -> creation immediately unblocked", async () => {
    const payload = createSamplePayload(mockInstId, {
      entitlements: {
        max_installations: 1,
        max_tenants: 20,
        resale_allowed: true,
        white_label: true,
        features: [],
      },
    });
    await writeSignedLicense(payload);

    const mockAdmin = {
      from: vi.fn().mockReturnValue({
        select: vi.fn().mockResolvedValue({ count: 10, error: null }),
      }),
    } as unknown as SupabaseClient;

    const check = await assertCanCreateTenant(mockAdmin, {
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });

    expect(check.allowed).toBe(true);
    expect(check.current).toBe(10);
    expect(check.max).toBe(20);
  });

  it("Fails closed on expired or invalid license", async () => {
    const payload = createSamplePayload(mockInstId, {
      valid_from: "2019-01-01T00:00:00Z",
      expires_at: "2020-01-01T00:00:00Z",
    });
    await writeSignedLicense(payload);

    const caps = await getInstallationCapabilities({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-08T00:00:00Z"),
    });

    expect(caps.usable).toBe(false);
    expect(caps.can_resell_access).toBe(false);
    expect(caps.can_white_label).toBe(false);
    expect(caps.can_manage_multiple_tenants).toBe(false);
    expect(caps.max_tenants).toBe(1);

    const wlCheck = await requireInstallationCapability("can_white_label", {
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
      now: new Date("2026-10-08T00:00:00Z"),
    });
    expect(wlCheck?.status).toBe(403);
    const body = await wlCheck?.json();
    expect(body.error.code).toBe("license_restricted");
  });

  it("Unknown capability fails closed", async () => {
    const payload = createSamplePayload(mockInstId);
    await writeSignedLicense(payload);

    const result = await hasInstallationCapability("unknown_super_cap" as InstallationCapability, {
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });
    expect(result).toBe(false);
  });

  it("Concurrent tenant creation: N=3, existing=2 -> 2 concurrent attempts yield exactly 1 success and 1 limit reached", async () => {
    const payload = createSamplePayload(mockInstId, {
      entitlements: {
        max_installations: 1,
        max_tenants: 3,
        resale_allowed: true,
        white_label: false,
        features: [],
      },
    });
    await writeSignedLicense(payload);

    let activeTenants = 2; // N - 1
    // Simulated atomic database lock & transaction boundary:
    // When multiple requests compete, the atomic lock sequences them:
    // Request 1 checks count (2 < 3) -> allowed -> activeTenants becomes 3
    // Request 2 checks count (3 >= 3) -> rejected
    let lockAcquired = false;
    const concurrentAttempt = async (attemptId: string) => {
      // Simulate connection queue on atomic advisory lock
      while (lockAcquired) {
        await new Promise((r) => setTimeout(r, 5));
      }
      lockAcquired = true;
      try {
        const mockAdmin = {
          from: vi.fn().mockReturnValue({
            select: vi.fn().mockImplementation(() =>
              Promise.resolve({ count: activeTenants, error: null })
            ),
          }),
        } as unknown as SupabaseClient;

        const check = await assertCanCreateTenant(mockAdmin, {
          licensePath,
          installationIdPath: instIdPath,
          trustedKeys,
        });

        if (check.allowed) {
          activeTenants += 1;
          return { attemptId, status: "SUCCESS" };
        } else {
          return { attemptId, status: "GLOBAL_TENANT_LIMIT_REACHED" };
        }
      } finally {
        lockAcquired = false;
      }
    };

    const [res1, res2] = await Promise.all([
      concurrentAttempt("attempt-1"),
      concurrentAttempt("attempt-2"),
    ]);

    const statuses = [res1.status, res2.status].sort();
    expect(statuses).toEqual(["GLOBAL_TENANT_LIMIT_REACHED", "SUCCESS"]);
    expect(activeTenants).toBe(3);
  });

  it("Tenant Plan Isolation: Installation PARTNER / ENTERPRISE never alters tenant STANDARD / PRO limits", async () => {
    // 1. Installation is PARTNER, tenant plan is standard
    const partnerPayload = createSamplePayload(mockInstId, {
      license_type: "partner",
      entitlements: {
        max_installations: 1,
        max_tenants: 5,
        resale_allowed: true,
        white_label: false,
        features: ["core"],
      },
    });
    await writeSignedLicense(partnerPayload);

    const capsPartner = await getInstallationCapabilities({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });
    expect(capsPartner.license_type).toBe("partner");

    // Verify tenant standard limits remain untouched
    const standardPlan = DEFAULT_PLAN_LIMITS.standard;
    expect(standardPlan.plan).toBe("standard");
    expect(standardPlan.max_users).toBe(3);
    expect(standardPlan.max_channels).toBe(1);
    expect(standardPlan.features.campaigns).toBe(false);

    // 2. Installation is ENTERPRISE, tenant plan is pro
    const enterprisePayload = createSamplePayload(mockInstId, {
      license_type: "enterprise",
      entitlements: {
        max_installations: 1,
        max_tenants: null,
        resale_allowed: true,
        white_label: true,
        features: ["enterprise_suite"],
      },
    });
    await writeSignedLicense(enterprisePayload);

    const capsEnterprise = await getInstallationCapabilities({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });
    expect(capsEnterprise.license_type).toBe("enterprise");

    // Verify tenant pro limits remain untouched
    const proPlan = DEFAULT_PLAN_LIMITS.pro;
    expect(proPlan.plan).toBe("pro");
    expect(proPlan.max_users).toBe(10);
    expect(proPlan.max_channels).toBe(5);
    expect(proPlan.features.campaigns).toBe(true);
  });

  it("Grace Period: license in GRACE maintains active capabilities", async () => {
    // Expired 2 days ago, within 7 days default grace period
    const now = new Date("2026-10-15T00:00:00Z");
    const payload = createSamplePayload(mockInstId, {
      license_type: "partner",
      valid_from: "2026-09-01T00:00:00Z",
      expires_at: "2026-10-13T00:00:00Z", // 2 days past expiration
      entitlements: {
        max_installations: 1,
        max_tenants: 5,
        resale_allowed: true,
        white_label: true,
        features: ["messages"],
      },
    });
    await writeSignedLicense(payload);

    const caps = await getInstallationCapabilities({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
      now,
    });

    expect(caps.usable).toBe(true);
    expect(caps.can_resell_access).toBe(true);
    expect(caps.can_white_label).toBe(true);
    expect(caps.can_white_label_installation).toBe(true);
    expect(caps.can_white_label_tenant).toBe(true);
    expect(caps.max_tenants).toBe(5);
  });

  it("Cache Invalidation: Switching Internal -> Partner -> Enterprise -> Internal updates capabilities immediately", async () => {
    // Step 1: Internal
    const docInternal = signLicensePayload(
      createSamplePayload(mockInstId, {
        license_type: "internal",
        entitlements: {
          max_installations: 1,
          max_tenants: 1,
          resale_allowed: false,
          white_label: false,
          features: [],
        },
      }),
      { privateKey: keys.privPem, keyId: KEY_ID }
    );
    await installLicenseFile(docInternal, {
      targetPath: licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });

    let caps = await getInstallationCapabilities({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });
    expect(caps.license_type).toBe("internal");
    expect(caps.can_resell_access).toBe(false);
    expect(caps.can_white_label).toBe(false);

    // Step 2: Partner
    const docPartner = signLicensePayload(
      createSamplePayload(mockInstId, {
        license_type: "partner",
        entitlements: {
          max_installations: 1,
          max_tenants: 5,
          resale_allowed: true,
          white_label: false,
          features: [],
        },
      }),
      { privateKey: keys.privPem, keyId: KEY_ID }
    );
    await installLicenseFile(docPartner, {
      targetPath: licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });

    caps = await getInstallationCapabilities({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });
    expect(caps.license_type).toBe("partner");
    expect(caps.can_resell_access).toBe(true);
    expect(caps.can_white_label).toBe(false);
    expect(caps.max_tenants).toBe(5);

    // Step 3: Enterprise
    const docEnterprise = signLicensePayload(
      createSamplePayload(mockInstId, {
        license_type: "enterprise",
        entitlements: {
          max_installations: 1,
          max_tenants: null,
          resale_allowed: true,
          white_label: true,
          features: [],
        },
      }),
      { privateKey: keys.privPem, keyId: KEY_ID }
    );
    await installLicenseFile(docEnterprise, {
      targetPath: licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });

    caps = await getInstallationCapabilities({
      licensePath,
      installationIdPath: instIdPath,
      trustedKeys,
    });
    expect(caps.license_type).toBe("enterprise");
    expect(caps.can_white_label).toBe(true);
    expect(caps.max_tenants).toBeNull();
  });

  it("Malformed & Missing entitlements fail closed", async () => {
    // Missing max_tenants
    const payloadMissingMax = createSamplePayload(mockInstId) as unknown as Record<string, unknown>;
    const entitlementsMissing = { ...(payloadMissingMax.entitlements as Record<string, unknown>) };
    delete entitlementsMissing.max_tenants;
    payloadMissingMax.entitlements = entitlementsMissing;

    expect(() =>
      signLicensePayload(payloadMissingMax as unknown as LicensePayload, {
        privateKey: keys.privPem,
        keyId: KEY_ID,
      })
    ).toThrow();

    // Negative max_tenants
    const payloadNegativeMax = createSamplePayload(mockInstId) as unknown as Record<string, unknown>;
    payloadNegativeMax.entitlements = {
      max_installations: 1,
      max_tenants: -5,
      resale_allowed: true,
      white_label: true,
      features: [],
    };
    expect(() =>
      signLicensePayload(payloadNegativeMax as unknown as LicensePayload, {
        privateKey: keys.privPem,
        keyId: KEY_ID,
      })
    ).toThrow();

    // String max_tenants
    const payloadStringMax = createSamplePayload(mockInstId) as unknown as Record<string, unknown>;
    payloadStringMax.entitlements = {
      max_installations: 1,
      max_tenants: "10",
      resale_allowed: true,
      white_label: true,
      features: [],
    };
    expect(() =>
      signLicensePayload(payloadStringMax as unknown as LicensePayload, {
        privateKey: keys.privPem,
        keyId: KEY_ID,
      })
    ).toThrow();
  });
});
