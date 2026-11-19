import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import type { User } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => {
  const adminService = {
    listCustomers: vi.fn().mockResolvedValue([]),
    listCommercialCustomers: vi.fn().mockResolvedValue({ items: [], total: 0, limit: 50, offset: 0 }),
    createCustomer: vi.fn().mockResolvedValue({ id: "cust_123" }),
    updateCustomer: vi.fn().mockResolvedValue({ id: "cust_123" }),
    getCustomer: vi.fn().mockResolvedValue({}),
    listLicenses: vi.fn().mockResolvedValue([]),
    createLicense: vi.fn().mockResolvedValue({ id: "lic_123" }),
    getLicenseDetail: vi.fn().mockResolvedValue({}),
    renewLicense: vi.fn().mockResolvedValue({ id: "lic_123" }),
    suspendLicense: vi.fn().mockResolvedValue({ id: "lic_123" }),
    reactivateLicense: vi.fn().mockResolvedValue({ id: "lic_123" }),
    revokeLicense: vi.fn().mockResolvedValue({ id: "lic_123" }),
    listInstallations: vi.fn().mockResolvedValue([]),
    getInstallationDetail: vi.fn().mockResolvedValue({}),
    forceDeactivateInstallation: vi.fn().mockResolvedValue({ id: "inst_123" }),
    reactivateInstallation: vi.fn().mockResolvedValue({ id: "inst_123" }),
    suspendInstallation: vi.fn().mockResolvedValue({ id: "inst_123" }),
    revokeInstallation: vi.fn().mockResolvedValue({ id: "inst_123" }),
    listActivationCodes: vi.fn().mockResolvedValue([]),
    createActivationCode: vi.fn().mockResolvedValue({ id: "code_123" }),
    revokeActivationCode: vi.fn().mockResolvedValue({ id: "code_123" }),
    listAuditEvents: vi.fn().mockResolvedValue([]),
  };

  return {
    loadAuthUser: vi.fn(),
    getControlPlaneAdminService: vi.fn(() => adminService),
    adminService,
  };
});

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

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: mocks.loadAuthUser }));

vi.mock("@/control-plane/src/admin-service-provider", () => ({
  getControlPlaneAdminService: mocks.getControlPlaneAdminService,
}));

import {
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { loadAuthUser } from "@/lib/auth/server";
import { GET as getCustomers, POST as postCustomer } from "@/app/api/v1/admin/licensing/customers/route";
import { GET as getLicenses, POST as postLicense } from "@/app/api/v1/admin/licensing/licenses/route";
import { GET as getInstallations } from "@/app/api/v1/admin/licensing/installations/route";
import { GET as getAudit } from "@/app/api/v1/admin/licensing/audit/route";
import { POST as revokeActivationCode } from "@/app/api/v1/admin/licensing/activation-codes/[id]/revoke/route";
import { PATCH as patchCustomer } from "@/app/api/v1/admin/licensing/customers/[id]/route";
import { POST as deactivateInstallation } from "@/app/api/v1/admin/licensing/installations/[id]/deactivate/route";
import { POST as reactivateInstallation } from "@/app/api/v1/admin/licensing/installations/[id]/reactivate/route";
import { POST as revokeInstallation } from "@/app/api/v1/admin/licensing/installations/[id]/revoke/route";
import { POST as suspendInstallation } from "@/app/api/v1/admin/licensing/installations/[id]/suspend/route";
import { POST as createActivationCode } from "@/app/api/v1/admin/licensing/licenses/[id]/activation-codes/route";
import { POST as reactivateLicense } from "@/app/api/v1/admin/licensing/licenses/[id]/reactivate/route";
import { POST as renewLicense } from "@/app/api/v1/admin/licensing/licenses/[id]/renew/route";
import { POST as revokeLicense } from "@/app/api/v1/admin/licensing/licenses/[id]/revoke/route";
import { POST as suspendLicense } from "@/app/api/v1/admin/licensing/licenses/[id]/suspend/route";

const id = "11111111-1111-4111-8111-111111111111";
const context = { params: Promise.resolve({ id }) };
function localRequest(input: string, init?: RequestInit) {
  const headers = new Headers(init?.headers);
  headers.set("Origin", "http://localhost");
  const { signal, ...options } = init ?? {};
  return new NextRequest(input, { ...options, ...(signal ? { signal } : {}), headers });
}
const supportReadonly = {
  id,
  organization_id: "22222222-2222-4222-8222-222222222222",
  actor_user_id: id,
  auth_session_id: "33333333-3333-4333-8333-333333333333",
  previous_organization_id: null,
  expires_at: "2027-01-01T00:00:00.000Z",
  name: "Support",
  locale: "pt-BR",
  access_mode: "support_readonly",
  status: "active",
};

const mutacoesLicenciamento: { nome: string; executar: () => Promise<Response> }[] = [
  {
    nome: "criar cliente",
    executar: () =>
      postCustomer(
        localRequest("http://localhost/api/v1/admin/licensing/customers", { method: "POST" }),
      ),
  },
  {
    nome: "atualizar cliente",
    executar: () =>
      patchCustomer(
        localRequest("http://localhost/api/v1/admin/licensing/customers/customer-id", {
          method: "PATCH",
        }),
        context,
      ),
  },
  {
    nome: "desativar instalação",
    executar: () =>
      deactivateInstallation(
        localRequest("http://localhost/api/v1/admin/licensing/installations/id/deactivate", {
          method: "POST",
        }),
        context,
      ),
  },
  {
    nome: "reativar instalação",
    executar: () =>
      reactivateInstallation(
        localRequest("http://localhost/api/v1/admin/licensing/installations/id/reactivate", {
          method: "POST",
        }),
        context,
      ),
  },
  {
    nome: "revogar instalação",
    executar: () =>
      revokeInstallation(
        localRequest("http://localhost/api/v1/admin/licensing/installations/id/revoke", {
          method: "POST",
        }),
        context,
      ),
  },
  {
    nome: "suspender instalação",
    executar: () =>
      suspendInstallation(
        localRequest("http://localhost/api/v1/admin/licensing/installations/id/suspend", {
          method: "POST",
        }),
        context,
      ),
  },
  {
    nome: "emitir código de ativação",
    executar: () =>
      createActivationCode(
        localRequest("http://localhost/api/v1/admin/licensing/licenses/id/activation-codes", {
          method: "POST",
        }),
        context,
      ),
  },
  {
    nome: "reativar licença",
    executar: () =>
      reactivateLicense(
        localRequest("http://localhost/api/v1/admin/licensing/licenses/id/reactivate", {
          method: "POST",
        }),
        context,
      ),
  },
  {
    nome: "renovar licença",
    executar: () =>
      renewLicense(
        localRequest("http://localhost/api/v1/admin/licensing/licenses/id/renew", {
          method: "POST",
        }),
        context,
      ),
  },
  {
    nome: "revogar licença",
    executar: () =>
      revokeLicense(
        localRequest("http://localhost/api/v1/admin/licensing/licenses/id/revoke", {
          method: "POST",
        }),
        context,
      ),
  },
  {
    nome: "suspender licença",
    executar: () =>
      suspendLicense(
        localRequest("http://localhost/api/v1/admin/licensing/licenses/id/suspend", {
          method: "POST",
        }),
        context,
      ),
  },
  {
    nome: "criar licença",
    executar: () =>
      postLicense(
        localRequest("http://localhost/api/v1/admin/licensing/licenses", { method: "POST" }),
      ),
  },
  {
    nome: "revogar código de ativação",
    executar: () =>
      revokeActivationCode(
        localRequest("http://localhost/api/v1/admin/licensing/activation-codes/id/revoke", {
          method: "POST",
        }),
        context,
      ),
  },
];

describe("Admin Licensing Routes Security & RBAC Guards", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadAuthUser).mockReset().mockResolvedValue(null as never);
  });

  describe("GET endpoints: requirePlatformAdmin()", () => {
    it("denies unauthenticated / non-platform-admin requests on customers GET", async () => {
      vi.mocked(requirePlatformAdmin).mockRejectedValueOnce(new Error("Unauthorized redirect"));

      const req = localRequest("http://localhost/api/v1/admin/licensing/customers");
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

      const req = localRequest("http://localhost/api/v1/admin/licensing/customers");
      const res = await getCustomers(req);

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.data).toEqual([]);
    });

    it("denies unauthenticated / non-platform-admin requests on licenses GET", async () => {
      vi.mocked(requirePlatformAdmin).mockRejectedValueOnce(new Error("Unauthorized redirect"));

      const req = localRequest("http://localhost/api/v1/admin/licensing/licenses");
      const res = await getLicenses(req);

      expect(res.status).toBe(403);
    });

    it("denies unauthenticated / non-platform-admin requests on installations GET", async () => {
      vi.mocked(requirePlatformAdmin).mockRejectedValueOnce(new Error("Unauthorized redirect"));

      const req = localRequest("http://localhost/api/v1/admin/licensing/installations");
      const res = await getInstallations(req);

      expect(res.status).toBe(403);
    });

    it("denies unauthenticated / non-platform-admin requests on audit GET", async () => {
      vi.mocked(requirePlatformAdmin).mockRejectedValueOnce(new Error("Unauthorized redirect"));

      const req = localRequest("http://localhost/api/v1/admin/licensing/audit");
      const res = await getAudit(req);

      expect(res.status).toBe(403);
    });
  });

  describe("POST mutating endpoints: requirePlatformAdminEscrita()", () => {
    it("denies non-full scope or unauthenticated requests on customer POST", async () => {
      vi.mocked(requirePlatformAdminEscrita).mockRejectedValueOnce(new Error("Forbidden scope"));

      const req = localRequest("http://localhost/api/v1/admin/licensing/customers", {
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

      const req = localRequest("http://localhost/api/v1/admin/licensing/customers", {
        method: "POST",
        body: JSON.stringify({ name: "Acme", billing_email: "a@b.com" }),
      });
      const res = await postCustomer(req);

      expect(res.status).toBe(201);
      expect(loadAuthUser).toHaveBeenCalledTimes(1);
      expect(mocks.getControlPlaneAdminService).toHaveBeenCalledTimes(1);
    });

    it("denies non-full scope on license POST", async () => {
      vi.mocked(requirePlatformAdminEscrita).mockRejectedValueOnce(new Error("Forbidden scope"));

      const req = localRequest("http://localhost/api/v1/admin/licensing/licenses", {
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

  describe("support_readonly: licensing read and write contract", () => {
    it("allows support_readonly to read while preserving the platform-admin read guard", async () => {
      vi.mocked(requirePlatformAdmin).mockResolvedValueOnce({
        user: { id: "support_user_id", email: "support@clientix.com" } as unknown as User,
        platformAdmin: {
          user_id: "support_user_id",
          scope: "support_readonly",
          mfa_required: true,
        },
      });
      vi.mocked(loadAuthUser).mockResolvedValueOnce({ support: supportReadonly } as never);

      const res = await getCustomers(
        localRequest("http://localhost/api/v1/admin/licensing/customers"),
      );

      expect(res.status).toBe(200);
      expect(mocks.getControlPlaneAdminService).toHaveBeenCalledTimes(1);
    });

    it.each(mutacoesLicenciamento)(
      "$nome: nega support_readonly antes de acessar o Control Plane",
      async ({ executar }) => {
        vi.mocked(requirePlatformAdminEscrita).mockResolvedValue({
          user: { id: "support_user_id", email: "support@clientix.com" } as unknown as User,
          platformAdmin: {
            user_id: "support_user_id",
            scope: "full",
            mfa_required: true,
          },
        });
        vi.mocked(loadAuthUser).mockResolvedValue({ support: supportReadonly } as never);

        const res = await executar();

        expect(res.status).toBe(403);
        expect((await res.json()).error.code).toBe("forbidden");
        expect(loadAuthUser).toHaveBeenCalledTimes(1);
        expect(mocks.getControlPlaneAdminService).not.toHaveBeenCalled();
      },
    );

    it("allows a full-scope platform admin to mutate outside a readonly support session", async () => {
      vi.mocked(requirePlatformAdminEscrita).mockResolvedValueOnce({
        user: { id: "admin_user_id", email: "admin@clientix.com" } as unknown as User,
        platformAdmin: { user_id: "admin_user_id", scope: "full", mfa_required: true },
      });

      const res = await postCustomer(
        localRequest("http://localhost/api/v1/admin/licensing/customers", {
          method: "POST",
          body: JSON.stringify({ name: "Acme", billing_email: "a@b.com" }),
        }),
      );

      expect(res.status).toBe(201);
      expect(loadAuthUser).toHaveBeenCalledTimes(1);
      expect(mocks.getControlPlaneAdminService).toHaveBeenCalledTimes(1);
    });
  });

  describe("Sensitive Actions: requirePlatformAdminEscrita() (MFA / Full Scope)", () => {
    it("denies unauthenticated / non-full-scope on revoke license", async () => {
      vi.mocked(requirePlatformAdminEscrita).mockRejectedValueOnce(new Error("MFA required / scope forbidden"));

      const { POST: revokeLicense } = await import("@/app/api/v1/admin/licensing/licenses/[id]/revoke/route");
      const req = localRequest("http://localhost/api/v1/admin/licensing/licenses/lic_123/revoke", {
        method: "POST",
      });
      const res = await revokeLicense(req, { params: Promise.resolve({ id: "lic_123" }) });

      expect(res.status).toBe(403);
    });

    it("denies unauthenticated / non-full-scope on revoke installation", async () => {
      vi.mocked(requirePlatformAdminEscrita).mockRejectedValueOnce(new Error("MFA required / scope forbidden"));

      const { POST: revokeInstallation } = await import("@/app/api/v1/admin/licensing/installations/[id]/revoke/route");
      const req = localRequest("http://localhost/api/v1/admin/licensing/installations/inst_123/revoke", {
        method: "POST",
      });
      const res = await revokeInstallation(req, { params: Promise.resolve({ id: "inst_123" }) });

      expect(res.status).toBe(403);
    });

    it("denies unauthenticated / non-full-scope on force deactivate installation", async () => {
      vi.mocked(requirePlatformAdminEscrita).mockRejectedValueOnce(new Error("MFA required / scope forbidden"));

      const { POST: deactivateInstallation } = await import("@/app/api/v1/admin/licensing/installations/[id]/deactivate/route");
      const req = localRequest("http://localhost/api/v1/admin/licensing/installations/inst_123/deactivate", {
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
