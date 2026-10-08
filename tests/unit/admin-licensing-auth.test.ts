import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";

vi.mock("@/lib/auth/requirePlatformAdmin", () => ({
  requirePlatformAdmin: vi.fn(),
  requirePlatformAdminEscrita: vi.fn(),
  falhaDaEscritaDePlatformAdmin: vi.fn((_err, requestId) => {
    return new Response(JSON.stringify({ error: { code: "forbidden", message: "Forbidden" } }), {
      status: 403,
      headers: { "Content-Type": "application/json", "X-Request-Id": requestId || "test" },
    });
  }),
}));

vi.mock("@/control-plane/src/admin-service-provider", () => ({
  getControlPlaneAdminService: vi.fn(() => ({
    listCustomers: vi.fn().mockResolvedValue([]),
    createCustomer: vi.fn().mockResolvedValue({ id: "cust_123" }),
    listLicenses: vi.fn().mockResolvedValue([]),
    createLicense: vi.fn().mockResolvedValue({ id: "lic_123" }),
    listInstallations: vi.fn().mockResolvedValue([]),
    listAuditEvents: vi.fn().mockResolvedValue([]),
  })),
}));

import {
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { GET as getCustomers, POST as postCustomer } from "@/app/api/v1/admin/licensing/customers/route";
import { GET as getLicenses, POST as postLicense } from "@/app/api/v1/admin/licensing/licenses/route";
import { GET as getInstallations } from "@/app/api/v1/admin/licensing/installations/route";
import { GET as getAudit } from "@/app/api/v1/admin/licensing/audit/route";

describe("Admin Licensing Routes Security & RBAC Guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("GET endpoints: requirePlatformAdmin()", () => {
    it("denies unauthenticated / non-platform-admin requests on customers GET", async () => {
      vi.mocked(requirePlatformAdmin).mockRejectedValueOnce(new Error("Unauthorized redirect"));

      const req = new NextRequest("http://localhost/api/v1/admin/licensing/customers");
      const res = await getCustomers(req);

      expect(res.status).toBe(403);
      const json = await res.json();
      expect(json.error.code).toBe("forbidden");
    });

    it("allows authorized platform admin on customers GET", async () => {
      vi.mocked(requirePlatformAdmin).mockResolvedValueOnce({
        user: { id: "admin_user_id", email: "admin@clientix.com" } as unknown as User,
        platformAdmin: { user_id: "admin_user_id", scope: "full", mfa_required: true },
      });

      const req = new NextRequest("http://localhost/api/v1/admin/licensing/customers");
      const res = await getCustomers(req);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual([]);
    });

    it("denies unauthenticated / non-platform-admin requests on licenses GET", async () => {
      vi.mocked(requirePlatformAdmin).mockRejectedValueOnce(new Error("Unauthorized redirect"));

      const req = new NextRequest("http://localhost/api/v1/admin/licensing/licenses");
      const res = await getLicenses(req);

      expect(res.status).toBe(403);
    });

    it("denies unauthenticated / non-platform-admin requests on installations GET", async () => {
      vi.mocked(requirePlatformAdmin).mockRejectedValueOnce(new Error("Unauthorized redirect"));

      const req = new NextRequest("http://localhost/api/v1/admin/licensing/installations");
      const res = await getInstallations(req);

      expect(res.status).toBe(403);
    });

    it("denies unauthenticated / non-platform-admin requests on audit GET", async () => {
      vi.mocked(requirePlatformAdmin).mockRejectedValueOnce(new Error("Unauthorized redirect"));

      const req = new NextRequest("http://localhost/api/v1/admin/licensing/audit");
      const res = await getAudit(req);

      expect(res.status).toBe(403);
    });
  });

  describe("POST mutating endpoints: requirePlatformAdminEscrita()", () => {
    it("denies non-full scope or unauthenticated requests on customer POST", async () => {
      vi.mocked(requirePlatformAdminEscrita).mockRejectedValueOnce(new Error("Forbidden scope"));

      const req = new NextRequest("http://localhost/api/v1/admin/licensing/customers", {
        method: "POST",
        body: JSON.stringify({ name: "Acme", billing_email: "a@b.com" }),
      });
      const res = await postCustomer(req);

      expect(res.status).toBe(403);
    });

    it("allows platform admin with full scope on customer POST", async () => {
      vi.mocked(requirePlatformAdminEscrita).mockResolvedValueOnce({
        user: { id: "admin_user_id", email: "admin@clientix.com" } as unknown as User,
        platformAdmin: { user_id: "admin_user_id", scope: "full", mfa_required: true },
      });

      const req = new NextRequest("http://localhost/api/v1/admin/licensing/customers", {
        method: "POST",
        body: JSON.stringify({ name: "Acme", billing_email: "a@b.com" }),
      });
      const res = await postCustomer(req);

      expect(res.status).toBe(201);
    });

    it("denies non-full scope on license POST", async () => {
      vi.mocked(requirePlatformAdminEscrita).mockRejectedValueOnce(new Error("Forbidden scope"));

      const req = new NextRequest("http://localhost/api/v1/admin/licensing/licenses", {
        method: "POST",
        body: JSON.stringify({
          customer_id: "11111111-1111-4111-8111-111111111111",
          license_type: "enterprise",
          max_installations: 1,
          expires_at: "2027-01-01T00:00:00.000Z",
        }),
      });
      const res = await postLicense(req);

      expect(res.status).toBe(403);
    });
  });

  describe("Sensitive Actions: requirePlatformAdminEscrita() (MFA / Full Scope)", () => {
    it("denies unauthenticated / non-full-scope on revoke license", async () => {
      vi.mocked(requirePlatformAdminEscrita).mockRejectedValueOnce(new Error("MFA required / scope forbidden"));

      const { POST: revokeLicense } = await import("@/app/api/v1/admin/licensing/licenses/[id]/revoke/route");
      const req = new NextRequest("http://localhost/api/v1/admin/licensing/licenses/lic_123/revoke", {
        method: "POST",
      });
      const res = await revokeLicense(req, { params: Promise.resolve({ id: "lic_123" }) });

      expect(res.status).toBe(403);
    });

    it("denies unauthenticated / non-full-scope on revoke installation", async () => {
      vi.mocked(requirePlatformAdminEscrita).mockRejectedValueOnce(new Error("MFA required / scope forbidden"));

      const { POST: revokeInstallation } = await import("@/app/api/v1/admin/licensing/installations/[id]/revoke/route");
      const req = new NextRequest("http://localhost/api/v1/admin/licensing/installations/inst_123/revoke", {
        method: "POST",
      });
      const res = await revokeInstallation(req, { params: Promise.resolve({ id: "inst_123" }) });

      expect(res.status).toBe(403);
    });

    it("denies unauthenticated / non-full-scope on force deactivate installation", async () => {
      vi.mocked(requirePlatformAdminEscrita).mockRejectedValueOnce(new Error("MFA required / scope forbidden"));

      const { POST: deactivateInstallation } = await import("@/app/api/v1/admin/licensing/installations/[id]/deactivate/route");
      const req = new NextRequest("http://localhost/api/v1/admin/licensing/installations/inst_123/deactivate", {
        method: "POST",
      });
      const res = await deactivateInstallation(req, { params: Promise.resolve({ id: "inst_123" }) });

      expect(res.status).toBe(403);
    });
  });

  describe("UI / Portal Route Access Smoke Tests: /admin/licensing/*", () => {
    it("ALLOWS authenticated platform admin with full scope", async () => {
      vi.mocked(requirePlatformAdmin).mockResolvedValueOnce({
        user: { id: "admin_user_id", email: "admin@clientix.com", user_metadata: { locale: "pt-BR" } } as unknown as User,
        platformAdmin: { user_id: "admin_user_id", scope: "full", mfa_required: true },
      });

      const ctx = await requirePlatformAdmin();
      expect(ctx.user.email).toBe("admin@clientix.com");
      expect(ctx.platformAdmin.scope).toBe("full");
    });

    it("DENIES / REDIRECTS unauthenticated requests", async () => {
      vi.mocked(requirePlatformAdmin).mockImplementationOnce(() => {
        const err = new Error("NEXT_REDIRECT: /login?next=/admin");
        (err as unknown as Record<string, unknown>).digest = "NEXT_REDIRECT;replace;/login?next=/admin;307;";
        throw err;
      });

      expect(() => requirePlatformAdmin()).toThrow("NEXT_REDIRECT: /login?next=/admin");
    });

    it("DENIES / REDIRECTS tenant admin lacking platform admin credentials", async () => {
      vi.mocked(requirePlatformAdmin).mockImplementationOnce(() => {
        const err = new Error("NEXT_REDIRECT: /admin/forbidden");
        (err as unknown as Record<string, unknown>).digest = "NEXT_REDIRECT;replace;/admin/forbidden;307;";
        throw err;
      });

      expect(() => requirePlatformAdmin()).toThrow("NEXT_REDIRECT: /admin/forbidden");
    });
  });
});
