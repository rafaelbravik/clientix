import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireSupportWrite: vi.fn(),
  requirePlatformAdmin: vi.fn(),
  requirePlatformAdminEscrita: vi.fn(),
  falhaDaEscritaDePlatformAdmin: vi.fn(() => new Response(null, { status: 403 })),
  installLicenseFile: vi.fn(),
  getInstallationLicenseStatus: vi.fn(),
  resolveSystemInstallationId: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: mocks.requireSupportWrite,
}));

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: mocks.requirePlatformAdmin,
  requirePlatformAdminEscrita: mocks.requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin: mocks.falhaDaEscritaDePlatformAdmin,
}));

vi.mock("@/lib/licensing", () => ({
  getInstallationLicenseStatus: mocks.getInstallationLicenseStatus,
  installLicenseFile: mocks.installLicenseFile,
  resolveSystemInstallationId: mocks.resolveSystemInstallationId,
}));

import { GET, PUT } from "@/app/api/v1/system/license/route";

describe("/api/v1/system/license", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recusa support_readonly antes do RBAC admin e preserva a licença", async () => {
    const denied = new Response(
      JSON.stringify({
        error: { code: "forbidden", message: "Este acompanhamento permite somente leitura." },
      }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
    mocks.requireSupportWrite.mockResolvedValueOnce(denied);

    const request = new NextRequest("http://localhost/api/v1/system/license", {
      method: "PUT",
      body: JSON.stringify({ payload: { license_id: "fixture-only" } }),
    });

    const response = await PUT(request);

    expect(response).toBe(denied);
    expect(mocks.requirePlatformAdminEscrita).not.toHaveBeenCalled();
    expect(mocks.installLicenseFile).not.toHaveBeenCalled();
  });

  it("recusa leitura de estado para uma sessão sem Platform Admin", async () => {
    mocks.requirePlatformAdmin.mockRejectedValueOnce(new Error("forbidden"));
    const request = new NextRequest("http://localhost/api/v1/system/license");

    const response = await GET(request);

    expect(response.status).toBe(403);
    expect(mocks.getInstallationLicenseStatus).not.toHaveBeenCalled();
    expect(mocks.resolveSystemInstallationId).not.toHaveBeenCalled();
  });

  it("recusa atualização sem autorização de escrita de Platform Admin", async () => {
    mocks.requireSupportWrite.mockResolvedValueOnce(null);
    mocks.requirePlatformAdminEscrita.mockRejectedValueOnce(new Error("forbidden"));
    const request = new NextRequest("http://localhost/api/v1/system/license", {
      method: "PUT",
      body: JSON.stringify({ payload: { license_id: "fixture-only" } }),
    });

    const response = await PUT(request);

    expect(response.status).toBe(403);
    expect(mocks.installLicenseFile).not.toHaveBeenCalled();
  });
});
