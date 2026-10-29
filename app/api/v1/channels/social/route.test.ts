import type * as SocialClient from "@/lib/channels/social/client";
import { beforeEach, expect, it, vi } from "vitest";
const h = vi.hoisted(() => ({
  role: vi.fn(),
  mfa: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  configure: vi.fn(),
  read: vi.fn(),
  channels: vi.fn(),
  accounts: vi.fn(),
  limit: vi.fn(),
  connect: vi.fn(),
  resync: vi.fn(),
}));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.role }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: h.mfa }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.support }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: h.limit }));
vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: "https://crm.test" } }));
vi.mock("@/lib/channels/social/store", () => ({
  readSocialIntegration: h.read,
  configureSocialIntegration: h.configure,
  socialChannels: h.channels,
  connectSocialInbox: h.connect,
  resyncSocialWebhook: h.resync,
}));
vi.mock("@/lib/channels/social/client", async (original) => ({
  ...(await original<typeof SocialClient>()),
  listSocialAccounts: h.accounts,
}));
import { GET, POST } from "./route";
const call = (body: unknown) =>
  POST(new Request("https://crm.test/api", { method: "POST", body: JSON.stringify(body) }));
beforeEach(() => {
  vi.clearAllMocks();
  h.role.mockResolvedValue({ ok: true, org: { orgId: "trusted" }, user: { id: "admin" } });
  h.mfa.mockResolvedValue(false);
  h.support.mockResolvedValue(null);
  h.limit.mockResolvedValue({ allowed: true });
  h.read.mockResolvedValue({ key: "hidden-key", profileId: "profile" });
  h.channels.mockResolvedValue([]);
  h.accounts.mockResolvedValue([
    { _id: "account", platform: "instagram", username: "brand", isActive: true },
  ]);
});
it("requires admin and never returns the stored key", async () => {
  const response = await GET();
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(JSON.stringify(await response.json())).not.toContain("hidden-key");
  expect(h.read).toHaveBeenCalledWith({}, "trusted");
  expect(h.role).toHaveBeenCalledWith("admin", expect.anything());
});
it("refuses foreign organization injection", async () => {
  expect(
    (
      await call({
        action: "configure",
        api_key: "secret-input",
        profile_id: "a".repeat(24),
        organization_id: "other",
      })
    ).status,
  ).toBe(400);
  expect(h.configure).not.toHaveBeenCalled();
});
it("saves under trusted tenant and audits without secrets", async () => {
  expect(
    (await call({ action: "configure", api_key: "secret-input", profile_id: "a".repeat(24) }))
      .status,
  ).toBe(200);
  expect(h.configure).toHaveBeenCalledWith({}, "trusted", "secret-input", "a".repeat(24));
  expect(JSON.stringify(h.audit.mock.calls)).not.toContain("secret-input");
});
it("blocks missing role, read-only support and missing MFA proof", async () => {
  h.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await call({})).status).toBe(403);
  h.support.mockResolvedValue(new Response(null, { status: 403 }));
  expect((await call({})).status).toBe(403);
  h.support.mockResolvedValue(null);
  h.role.mockResolvedValue({ ok: true, org: { orgId: "trusted" }, user: { id: "admin" } });
  h.mfa.mockResolvedValue(true);
  expect((await call({})).status).toBe(403);
  expect(h.configure).not.toHaveBeenCalled();
});
it("retorna 403 quando connectSocialInbox rejeita por entitlement ou cota", async () => {
  const { SocialError } = await import("@/lib/channels/social/client");
  h.connect.mockRejectedValue(
    new SocialError("O canal 'instagram' não está disponível no plano STANDARD.", 403),
  );
  const response = await call({ action: "inbox", account_id: "a".repeat(24) });
  expect(response.status).toBe(403);
  const data = await response.json();
  expect(data.error.message).toContain("não está disponível no plano STANDARD");
  expect(data.error.code).toBe("social_unavailable");
});

it("ressincroniza sob o tenant da sessão e expõe apenas o resultado sanitizado", async () => {
  h.resync.mockResolvedValue({
    channel_id: "session-safe-id",
    resynced: true,
    secret: "must-not-leak",
    url: "https://old.example/api/v1/webhooks/channel/private-path",
  });
  const response = await call({ action: "resync", account_id: "a".repeat(24) });
  expect(response.status).toBe(200);
  expect(h.resync).toHaveBeenCalledWith({}, "trusted", "a".repeat(24), "https://crm.test");
  const responseText = JSON.stringify(await response.json());
  expect(responseText).toContain("session-safe-id");
  expect(responseText).not.toContain("must-not-leak");
  expect(responseText).not.toContain("private-path");
  expect(h.audit).toHaveBeenCalledWith(
    expect.objectContaining({
      action: "channel.social_webhook_ressincronizado",
      organizationId: "trusted",
      actorUserId: "admin",
      metadata: { operation: "resync", channel_id: "session-safe-id", resynced: true },
    }),
  );
  expect(JSON.stringify(h.audit.mock.calls)).not.toContain("must-not-leak");
  expect(JSON.stringify(h.audit.mock.calls)).not.toContain("private-path");
});

it("recusa URL ou tenant fornecidos pelo chamador e não chama o store", async () => {
  expect(
    (
      await call({
        action: "resync",
        account_id: "a".repeat(24),
        callback_url: "https://attacker.example/hook",
        organization_id: "other",
      })
    ).status,
  ).toBe(400);
  expect(h.resync).not.toHaveBeenCalled();
});

it("aplica os guardas existentes de admin, suporte e MFA antes do resync", async () => {
  h.role.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
  expect((await call({ action: "resync", account_id: "a".repeat(24) })).status).toBe(403);
  h.role.mockResolvedValue({ ok: true, org: { orgId: "trusted" }, user: { id: "admin" } });
  h.support.mockResolvedValue(new Response(null, { status: 403 }));
  expect((await call({ action: "resync", account_id: "a".repeat(24) })).status).toBe(403);
  h.support.mockResolvedValue(null);
  h.mfa.mockResolvedValue(true);
  expect((await call({ action: "resync", account_id: "a".repeat(24) })).status).toBe(403);
  expect(h.resync).not.toHaveBeenCalled();
});

it("não devolve detalhe de credencial quando o provider falha", async () => {
  const { SocialError } = await import("@/lib/channels/social/client");
  h.resync.mockRejectedValue(new SocialError("O provedor não concluiu a operação (HTTP 503).", 502));
  const response = await call({ action: "resync", account_id: "a".repeat(24) });
  expect(response.status).toBe(502);
  const body = JSON.stringify(await response.json());
  expect(body).toContain("HTTP 503");
  expect(body).not.toContain("hidden-key");
});

