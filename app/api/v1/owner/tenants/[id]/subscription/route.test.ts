import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  owner: vi.fn(),
  ownerWrite: vi.fn(),
  supportWrite: vi.fn(),
  audit: vi.fn(),
  from: vi.fn(),
  rpc: vi.fn(),
}));

vi.mock("@/lib/auth/requirePlatformAdmin", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/auth/requirePlatformAdmin")>()),
  requirePlatformOwner: h.owner,
  requirePlatformOwnerEscrita: h.ownerWrite,
}));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.supportWrite }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: h.from, rpc: h.rpc }) }));

import { GET, PUT } from "@/app/api/v1/owner/tenants/[id]/subscription/route";

const OWNER = "a2180000-0000-4000-8000-000000000001";
const ORG = "a2180000-0000-4000-8000-000000000002";

function query(data: unknown, error: unknown = null) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "limit"]) chain[method] = vi.fn(() => chain);
  chain.maybeSingle = vi.fn(async () => ({ data, error }));
  chain.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data, error }).then(resolve);
  return chain;
}

function updateRequest(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/owner/tenants/${ORG}/subscription`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  const actor = { user: { id: OWNER }, platformAdmin: { scope: "full", platform_role: "owner" } };
  h.owner.mockResolvedValue(actor);
  h.ownerWrite.mockResolvedValue(actor);
  h.supportWrite.mockResolvedValue(null);
  h.audit.mockResolvedValue(undefined);
  h.from.mockImplementation((table: string) => {
    if (table === "organizations") return query({ id: ORG, slug: "empresa-teste", display_name: "Empresa Teste", settings: { plan: "pro" } });
    if (table === "tenant_plan_subscriptions") return query(null);
    if (table === "platform_plan_catalog") return query([
      { slug: "standard", name: "Essencial" },
      { slug: "pro", name: "Profissional" },
    ]);
    throw new Error(`Tabela inesperada: ${table}`);
  });
  h.rpc.mockResolvedValue({ data: { id: "sub-test", status: "active", plan_slug: "pro" }, error: null });
});

describe("API de assinatura do Platform Owner", () => {
  it("retorna tenant, plano legado e catálogo sem expor dados a quem não é owner", async () => {
    const response = await GET(new NextRequest(`http://localhost/api/v1/owner/tenants/${ORG}/subscription`), {
      params: Promise.resolve({ id: ORG }),
    });

    expect(response.status).toBe(200);
    expect((await response.json()).data).toMatchObject({
      organization: { id: ORG, display_name: "Empresa Teste" },
      plan: "pro",
      subscription: null,
      plans: [{ slug: "standard" }, { slug: "pro" }],
    });
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "platform_owner.tenant_subscription_viewed", organizationId: ORG }));

    h.owner.mockRejectedValueOnce(new Error("not owner"));
    expect((await GET(new NextRequest(`http://localhost/api/v1/owner/tenants/${ORG}/subscription`), {
      params: Promise.resolve({ id: ORG }),
    })).status).toBe(403);
    expect(h.from).toHaveBeenCalledTimes(3);
  });

  it("valida a atualização e audita o RPC transacional", async () => {
    const now = Date.now();
    const body = {
      plan_slug: "pro",
      status: "active",
      billing_interval: "monthly",
      price_cents: 15900,
      currency: "BRL",
      current_period_starts_at: new Date(now - 60_000).toISOString(),
      current_period_ends_at: new Date(now + 30 * 24 * 60 * 60_000).toISOString(),
      trial_ends_at: null,
      cancel_at_period_end: false,
    };
    const response = await PUT(updateRequest(body), { params: Promise.resolve({ id: ORG }) });

    expect(response.status).toBe(200);
    expect(h.rpc).toHaveBeenCalledWith("fn_platform_set_tenant_plan_subscription", expect.objectContaining({
      p_actor: OWNER,
      p_organization_id: ORG,
      p_plan_slug: "pro",
      p_status: "active",
      p_price_cents: 15900,
    }));
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "platform_owner.tenant_subscription_updated", organizationId: ORG }));

    expect((await PUT(updateRequest({ ...body, price_cents: -1 }), { params: Promise.resolve({ id: ORG }) })).status).toBe(422);
    expect(h.rpc).toHaveBeenCalledTimes(1);
  });
});
