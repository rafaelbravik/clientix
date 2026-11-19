import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const {
  checkFeatureQuota,
  requireRole,
  requireSupportWrite,
  createClient,
  createAdminClient,
  originateCall,
  audit,
  supabase,
} = vi.hoisted(() => {
  const db = {
    from: vi.fn((table: string) => {
      if (table === "voip_trunk_settings") {
        const query = {
          select: vi.fn(() => query),
          eq: vi.fn(() => query),
          maybeSingle: vi.fn(async () => ({
            data: { endpoint_name: "trunk-test", is_active: true },
            error: null,
          })),
        };
        return query;
      }
      if (table === "voice_calls") {
        const inserted = {
          select: vi.fn(() => inserted),
          single: vi.fn(async () => ({ data: { id: "call-test" }, error: null })),
        };
        return {
          insert: vi.fn(() => inserted),
          update: vi.fn(() => ({ eq: vi.fn(async () => ({ error: null })) })),
        };
      }
      throw new Error(`tabela inesperada: ${table}`);
    }),
  };
  return {
    checkFeatureQuota: vi.fn(),
    requireRole: vi.fn(),
    requireSupportWrite: vi.fn(),
    createClient: vi.fn(async () => db),
    createAdminClient: vi.fn(() => db),
    originateCall: vi.fn(async () => ({ id: "ari-channel-test" })),
    audit: vi.fn(async () => undefined),
    supabase: db,
  };
});

vi.mock("@/lib/tenant/plan-limits", () => ({ checkFeatureQuota }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite }));
vi.mock("@/lib/supabase/server", () => ({ createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient }));
vi.mock("@/lib/voip/ariClient", () => ({ originateCall }));
vi.mock("@/lib/audit", () => ({ audit }));

import { POST } from "@/app/api/v1/calls/route";

function request(): NextRequest {
  return new NextRequest("http://localhost/api/v1/calls", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ toNumber: "5511999999999", mode: "human" }),
  });
}

describe("entitlement voice_calls na discagem SIP", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    requireSupportWrite.mockResolvedValue(null);
    requireRole.mockResolvedValue({
      ok: true,
      user: { id: "user-test", idioma: "pt-BR" },
      org: { orgId: "org-test", role: "manager" },
    });
    createClient.mockResolvedValue(supabase);
    createAdminClient.mockReturnValue(supabase);
    originateCall.mockResolvedValue({ id: "ari-channel-test" });
  });

  it("falha fechado e não cria nem origina a chamada quando o plano não permite", async () => {
    checkFeatureQuota.mockResolvedValue({ allowed: false, reason: "voice_calls indisponível" });

    const res = await POST(request());

    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: { code: "feature_not_available" } });
    expect(checkFeatureQuota).toHaveBeenCalledWith(supabase, "org-test", "voice_calls");
    expect(createAdminClient).toHaveBeenCalledOnce();
    expect(supabase.from).not.toHaveBeenCalled();
    expect(originateCall).not.toHaveBeenCalled();
  });

  it("permite iniciar quando o plano autoriza e o trunk responde", async () => {
    checkFeatureQuota.mockResolvedValue({ allowed: true });

    const res = await POST(request());

    expect(res.status).toBe(201);
    expect(supabase.from).toHaveBeenCalledWith("voip_trunk_settings");
    expect(supabase.from).toHaveBeenCalledWith("voice_calls");
    expect(originateCall).toHaveBeenCalledTimes(1);
  });
});
