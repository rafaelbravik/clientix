import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  requirePlatformAdminEscrita: vi.fn(),
  falhaDaEscritaDePlatformAdmin: vi.fn(() => new Response(null, { status: 403 })),
  requireSupportWrite: vi.fn(),
  getInstallationLicenseStatus: vi.fn(),
  resetLicenseCache: vi.fn(),
  installLicenseFile: vi.fn(),
  createLicenseAdminSummary: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: mocks.requirePlatformAdmin,
  requirePlatformAdminEscrita: mocks.requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin: mocks.falhaDaEscritaDePlatformAdmin,
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.requireSupportWrite }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/licensing/admin-view", () => ({
  createLicenseAdminSummary: mocks.createLicenseAdminSummary,
}));
vi.mock("@/lib/licensing/enforcement", () => ({
  getInstallationLicenseStatus: mocks.getInstallationLicenseStatus,
  resetLicenseCache: mocks.resetLicenseCache,
  installLicenseFile: mocks.installLicenseFile,
}));

import { GET } from "@/app/api/v1/admin/license/route";
import { POST as validateLicense } from "@/app/api/v1/admin/license/validate/route";
import { POST as updateLicense } from "@/app/api/v1/admin/license/update/route";

describe("local installation license admin API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireSupportWrite.mockResolvedValue(null);
  });

  it("requires Platform Admin for status and validation", async () => {
    mocks.requirePlatformAdmin.mockRejectedValue(new Error("forbidden"));
    mocks.requirePlatformAdminEscrita.mockRejectedValue(new Error("forbidden"));

    const status = await GET();
    const validation = await validateLicense();

    expect(status.status).toBe(403);
    expect(validation.status).toBe(403);
    expect(mocks.getInstallationLicenseStatus).not.toHaveBeenCalled();
    expect(mocks.resetLicenseCache).not.toHaveBeenCalled();
  });

  it("requires Platform Admin write authorization before changing the license file", async () => {
    mocks.requirePlatformAdminEscrita.mockRejectedValue(new Error("forbidden"));
    const request = new NextRequest("http://localhost/api/v1/admin/license/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document: { payload: "synthetic" } }),
    });

    const response = await updateLicense(request);

    expect(response.status).toBe(403);
    expect(mocks.installLicenseFile).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("returns the masked admin summary after an authorized update", async () => {
    const safeSummary = {
      status: "ACTIVE",
      serial_masked: "CLX-••••-••••-WXYZ",
      installation_id_masked: "inst_aaaa…eeee",
    };
    mocks.requirePlatformAdminEscrita.mockResolvedValue({ user: { id: "synthetic-admin-id" } });
    mocks.installLicenseFile.mockResolvedValue({
      statusInfo: { license_id: "lic_synthetic", commercial_status: "ACTIVE", plan: "pro" },
    });
    mocks.createLicenseAdminSummary.mockReturnValue(safeSummary);
    mocks.audit.mockResolvedValue(undefined);

    const request = new NextRequest("http://localhost/api/v1/admin/license/update", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ document: { payload: "synthetic" } }),
    });
    const response = await updateLicense(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.license).toEqual(safeSummary);
    expect(JSON.stringify(body)).not.toContain("synthetic-admin-id");
    expect(mocks.audit).toHaveBeenCalledOnce();
  });
});
