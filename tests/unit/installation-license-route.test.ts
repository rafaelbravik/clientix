import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireSupportWrite: vi.fn(),
  requireRole: vi.fn(),
  installLicenseFile: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({
  requireSupportWrite: mocks.requireSupportWrite,
}));

vi.mock("@/lib/auth/require-role", () => ({
  requireRole: mocks.requireRole,
}));

vi.mock("@/lib/licensing", () => ({
  getInstallationLicenseStatus: vi.fn(),
  installLicenseFile: mocks.installLicenseFile,
  resolveSystemInstallationId: vi.fn(),
}));

import { PUT } from "@/app/api/v1/system/license/route";

describe("PUT /api/v1/system/license", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("recusa support_readonly antes do RBAC admin e preserva a licença", async () => {
    const denied = new Response(
      JSON.stringify({ error: { code: "forbidden", message: "Este acompanhamento permite somente leitura." } }),
      { status: 403, headers: { "Content-Type": "application/json" } },
    );
    mocks.requireSupportWrite.mockResolvedValueOnce(denied);

    const request = new NextRequest("http://localhost/api/v1/system/license", {
      method: "PUT",
      body: JSON.stringify({ payload: { license_id: "fixture-only" } }),
    });

    const response = await PUT(request);

    expect(response).toBe(denied);
    expect(mocks.requireRole).not.toHaveBeenCalled();
    expect(mocks.installLicenseFile).not.toHaveBeenCalled();
  });
});
