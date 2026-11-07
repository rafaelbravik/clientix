import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requirePlatformAdmin: vi.fn(),
  requirePlatformAdminEscrita: vi.fn(),
  falhaDaEscritaDePlatformAdmin: vi.fn(
    () => new Response(JSON.stringify({ error: { code: "forbidden" } }), { status: 403 }),
  ),
  requireSupportWrite: vi.fn(),
  getControlPlaneAdminService: vi.fn(),
}));

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: mocks.requirePlatformAdmin,
  requirePlatformAdminEscrita: mocks.requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin: mocks.falhaDaEscritaDePlatformAdmin,
}));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.requireSupportWrite }));
vi.mock("@/control-plane/src/admin-service-provider", () => ({
  getControlPlaneAdminService: mocks.getControlPlaneAdminService,
}));

import { GET, POST } from "@/app/api/v1/admin/licenses/route";

describe("License Server administrative API guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requirePlatformAdmin.mockRejectedValue(new Error("unauthenticated"));
    mocks.requirePlatformAdminEscrita.mockRejectedValue(new Error("unauthenticated"));
  });

  it("denies anonymous list and create requests before accessing the Control Plane", async () => {
    const getResponse = await GET(new Request("http://localhost/api/v1/admin/licenses"));
    const postResponse = await POST(
      new Request("http://localhost/api/v1/admin/licenses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      }),
    );

    expect(getResponse.status).toBe(403);
    expect(postResponse.status).toBe(403);
    expect(mocks.getControlPlaneAdminService).not.toHaveBeenCalled();
    expect(mocks.requireSupportWrite).not.toHaveBeenCalled();
  });

  it("rejects missing and cross-origin writes before authentication or database access", async () => {
    const missingOrigin = await POST(
      new Request("http://localhost/api/v1/admin/licenses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "lic-create-test-key-001",
        },
        body: "{}",
      }),
    );
    const crossOrigin = await POST(
      new Request("http://localhost/api/v1/admin/licenses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "lic-create-test-key-001",
          Origin: "https://attacker.invalid",
        },
        body: "{}",
      }),
    );

    expect(missingOrigin.status).toBe(403);
    expect(crossOrigin.status).toBe(403);
    expect(mocks.requirePlatformAdminEscrita).not.toHaveBeenCalled();
    expect(mocks.getControlPlaneAdminService).not.toHaveBeenCalled();
  });

  it("requires a full-scope, MFA-cleared write session after same-origin validation", async () => {
    const response = await POST(
      new Request("http://localhost/api/v1/admin/licenses", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": "lic-create-test-key-001",
          Origin: "http://localhost",
        },
        body: "{}",
      }),
    );

    expect(response.status).toBe(403);
    expect(mocks.requirePlatformAdminEscrita).toHaveBeenCalledOnce();
    expect(mocks.getControlPlaneAdminService).not.toHaveBeenCalled();
  });
});
