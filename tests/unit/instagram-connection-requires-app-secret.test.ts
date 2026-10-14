import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const {
  requireRole,
  requireSupportWrite,
  createAdminClient,
  instagramGetAccount,
  checkChannelQuota,
  appDaMeta,
} = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSupportWrite: vi.fn(),
  createAdminClient: vi.fn(),
  instagramGetAccount: vi.fn(),
  checkChannelQuota: vi.fn(),
  appDaMeta: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/channels/instagram/client", () => ({ instagramGetAccount }));
vi.mock("@/lib/tenant/plan-limits", () => ({ checkChannelQuota }));
vi.mock("@/lib/webhooks/secrets", () => ({ encryptWebhookSecret: vi.fn() }));
vi.mock("@/lib/channels/meta/app", () => ({ appDaMeta }));

import { POST } from "@/app/api/v1/channels/instagram/route";

describe("Instagram native app secret requirement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSupportWrite.mockResolvedValue(null);
    appDaMeta.mockResolvedValue({ appSecret: null, verifyToken: null });
    requireRole.mockResolvedValue({
      ok: true,
      user: { id: "user-test", idioma: "pt-BR" },
      org: { orgId: "org-test", role: "admin" },
    });
  });

  it("recusa sem segredo antes de validar a conta ou gravar credenciais", async () => {
    const req = new Request("http://localhost/api/v1/channels/instagram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account_id: "ig-account-1", token: "x".repeat(24) }),
    });

    const res = await POST(req as never);

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "validation_failed" } });
    expect(instagramGetAccount).not.toHaveBeenCalled();
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("recusa sem verify token global antes de marcar a conta como conectada", async () => {
    appDaMeta.mockResolvedValue({ appSecret: "x".repeat(32), verifyToken: null });
    const req = new Request("http://localhost/api/v1/channels/instagram", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ account_id: "ig-account-1", token: "x".repeat(24) }),
    });

    const res = await POST(req as never);

    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ error: { code: "integration_unavailable" } });
    expect(instagramGetAccount).not.toHaveBeenCalled();
  });

  afterEach(() => vi.unstubAllEnvs());
});
