import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  supportWrite: vi.fn(),
  requireRole: vi.fn(),
  rpc: vi.fn(),
  audit: vi.fn(),
  source: { id: "source-1", source_type: "faq" } as { id: string; source_type: string } | null,
  readError: null as { message: string } | null,
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.supportWrite }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    from: () => {
      const query = {
        select: () => query,
        eq: () => query,
        maybeSingle: async () => ({ data: mocks.source, error: mocks.readError }),
      };
      return query;
    },
  }),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));

import { PATCH } from "@/app/api/v1/ai/knowledge/sources/[id]/route";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";

function request(body: unknown): NextRequest {
  return new Request("http://localhost/api/v1/ai/knowledge/sources/source-1", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  }) as NextRequest;
}

beforeEach(() => {
  mocks.supportWrite.mockReset().mockResolvedValue(null);
  mocks.requireRole.mockReset().mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG },
  });
  mocks.rpc.mockReset().mockResolvedValue({ data: { id: "source-1", items_count: 1 }, error: null });
  mocks.audit.mockReset().mockResolvedValue(undefined);
  mocks.source = { id: "source-1", source_type: "faq" };
  mocks.readError = null;
});

describe("PATCH knowledge source — validação, atomicidade e audit", () => {
  it("recusa item inválido antes de chamar a mutação atômica", async () => {
    const response = await PATCH(
      request({ name: "Atualizada", items: [{ question: "", answer: "Resposta" }] }),
      { params: Promise.resolve({ id: "source-1" }) },
    );

    expect(response.status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("submete metadata e FAQ juntas a uma única RPC e audita só campos/contagem", async () => {
    const response = await PATCH(
      request({
        name: "FAQ atualizada",
        source_metadata: { locale: "pt-BR" },
        items: [{ question: "Pergunta sintética?", answer: "Resposta sintética", tags: ["teste"] }],
      }),
      { params: Promise.resolve({ id: "source-1" }) },
    );

    expect(response.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "fn_update_ai_knowledge_source_atomic",
      expect.objectContaining({
        p_source_id: "source-1",
        p_organization_id: ORG,
        p_patch: expect.objectContaining({ name: "FAQ atualizada", items: expect.any(Array) }),
      }),
    );
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "ai.knowledge_source_updated",
      actorUserId: USER,
      organizationId: ORG,
      resourceId: "source-1",
      metadata: { changed_fields: ["name", "source_metadata", "items"], faq_items_count: 1 },
    }));
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain("Resposta sintética");
  });

  it("não audita sucesso nem altera dados quando a transação falha", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "XX000", message: "transaction failed" } });

    const response = await PATCH(request({ name: "FAQ nova" }), {
      params: Promise.resolve({ id: "source-1" }),
    });

    expect(response.status).toBe(500);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("não chama RPC para fonte pertencente a outro tenant", async () => {
    mocks.source = null;

    const response = await PATCH(request({ name: "FAQ nova" }), {
      params: Promise.resolve({ id: "source-1" }),
    });

    expect(response.status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("não permite enviar FAQ items para fonte que não é FAQ", async () => {
    mocks.source = { id: "source-1", source_type: "documento" };

    const response = await PATCH(request({ items: [{ question: "Q", answer: "A" }] }), {
      params: Promise.resolve({ id: "source-1" }),
    });

    expect(response.status).toBe(422);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("bloqueia support_readonly antes de autenticar/mutar", async () => {
    mocks.supportWrite.mockResolvedValueOnce(new Response("readonly", { status: 403 }));

    const response = await PATCH(request({ name: "FAQ nova" }), {
      params: Promise.resolve({ id: "source-1" }),
    });

    expect(response.status).toBe(403);
    expect(mocks.requireRole).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
