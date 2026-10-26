// @vitest-environment node

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const ATTACHMENT = "55555555-5555-4555-8555-555555555555";

function sessionClient(options: { attachment?: unknown; rpcResult?: unknown; rpcError?: unknown } = {}) {
  const rpc = vi.fn(async () => ({ data: options.rpcResult ?? true, error: options.rpcError ?? null }));
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: options.attachment ?? null, error: null }),
  };
  return { from: vi.fn(() => builder), rpc, builder };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null as never);
});

describe("DELETE /api/v1/leads/[id]/attachments/[attachmentId]", () => {
  it("remove pela RPC protegida e audita sem conteúdo nem path", async () => {
    const db = sessionClient({
      attachment: { id: ATTACHMENT, custom_field_key: "contrato", mime_type: "application/pdf", size_bytes: 32 },
    });
    vi.mocked(createClient).mockResolvedValue(db as never);
    const { DELETE } = await import("./route");
    const response = await DELETE(
      new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments/${ATTACHMENT}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: LEAD, attachmentId: ATTACHMENT }) },
    );
    expect(response.status).toBe(200);
    expect(db.rpc).toHaveBeenCalledWith("fn_delete_crm_lead_attachment", {
      p_organization_id: ORG,
      p_lead_id: LEAD,
      p_attachment_id: ATTACHMENT,
    });
  });

  it("esconde anexo fora da organização ativa sem chamar a RPC", async () => {
    const db = sessionClient();
    vi.mocked(createClient).mockResolvedValue(db as never);
    const { DELETE } = await import("./route");
    const response = await DELETE(
      new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments/${ATTACHMENT}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: LEAD, attachmentId: ATTACHMENT }) },
    );
    expect(response.status).toBe(404);
    expect(db.rpc).not.toHaveBeenCalled();
  });

  it("recusa a remoção do último anexo exigido e não audita", async () => {
    const db = sessionClient({
      attachment: { id: ATTACHMENT, custom_field_key: "contrato", mime_type: "application/pdf", size_bytes: 32 },
      rpcError: { code: "23514", message: "required_file_attachment_missing" },
    });
    vi.mocked(createClient).mockResolvedValue(db as never);
    const { DELETE } = await import("./route");
    const response = await DELETE(
      new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments/${ATTACHMENT}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: LEAD, attachmentId: ATTACHMENT }) },
    );
    expect(response.status).toBe(422);
  });

  it("support_readonly não chama a RPC de remoção", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValue(new Response(null, { status: 403 }) as never);
    const { DELETE } = await import("./route");
    const response = await DELETE(
      new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments/${ATTACHMENT}`, { method: "DELETE" }),
      { params: Promise.resolve({ id: LEAD, attachmentId: ATTACHMENT }) },
    );
    expect(response.status).toBe(403);
    expect(createClient).not.toHaveBeenCalled();
  });
});
