import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  guard: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  from: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  select: vi.fn(),
  single: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: h.guard }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: h.support }));
vi.mock("@/lib/audit", () => ({ audit: h.audit }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ from: h.from }),
}));

import { PATCH } from "@/app/api/v1/message-templates/[id]/route";

const ORG = "b7c30000-0000-4000-8000-000000000001";
const USER = "b7c30000-0000-4000-8000-000000000002";
const TEMPLATE = "b7c30000-0000-4000-8000-000000000003";

function req(body: unknown) {
  return new NextRequest(`http://localhost/api/v1/message-templates/${TEMPLATE}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  h.support.mockResolvedValue(null);
  h.guard.mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt" },
    org: { orgId: ORG, role: "agent" },
  });
  h.single.mockResolvedValue({
    data: {
      id: TEMPLATE,
      organization_id: ORG,
      title: "Boas-vindas",
      body: "Olá!",
      mostrar_na_barra: false,
    },
    error: null,
  });
  h.select.mockReturnValue({ single: h.single });
  h.eq.mockReturnValue({ eq: h.eq, select: h.select });
  h.update.mockReturnValue({ eq: h.eq });
  h.from.mockReturnValue({ update: h.update });
});

describe("PATCH /api/v1/message-templates/[id] — barra do Inbox", () => {
  it("persiste ocultar da barra sem remover o template do tenant", async () => {
    const response = await PATCH(req({ mostrar_na_barra: false }), {
      params: Promise.resolve({ id: TEMPLATE }),
    });

    expect(response.status).toBe(200);
    expect(h.from).toHaveBeenCalledWith("message_templates");
    expect(h.update).toHaveBeenCalledWith(
      expect.objectContaining({ mostrar_na_barra: false, updated_at: expect.any(String) }),
    );
    expect(h.eq).toHaveBeenNthCalledWith(1, "id", TEMPLATE);
    expect(h.eq).toHaveBeenNthCalledWith(2, "organization_id", ORG);
    expect((await response.json()).data.mostrar_na_barra).toBe(false);
    expect(h.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "template.updated" }));
  });
});
