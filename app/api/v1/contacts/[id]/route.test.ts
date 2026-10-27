import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  loadAuthUser: vi.fn(),
  orgAtivaDaApi: vi.fn(),
  getUser: vi.fn(),
  getContactHandler: vi.fn(),
  patchContactHandler: vi.fn(),
  deleteContactHandler: vi.fn(),
}));

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({
  requireRole: mocks.requireRole,
  orgAtivaDaApi: mocks.orgAtivaDaApi,
}));
vi.mock("@/lib/auth/server", () => ({ loadAuthUser: mocks.loadAuthUser }));
vi.mock("@/lib/supabase/server", () => ({ createClient: async () => ({ auth: { getUser: mocks.getUser } }) }));
vi.mock("../_handler", () => ({
  getContactHandler: mocks.getContactHandler,
  patchContactHandler: mocks.patchContactHandler,
  deleteContactHandler: mocks.deleteContactHandler,
}));

import { GET } from "@/app/api/v1/contacts/[id]/route";

const USER = "11111111-1111-4111-8111-111111111111";
const ORG = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";

function request(decryptPurpose?: string): NextRequest {
  return new Request("http://localhost/api/v1/contacts/contact-1", {
    headers: decryptPurpose ? { "x-decrypt-purpose": decryptPurpose } : {},
  }) as NextRequest;
}

beforeEach(() => {
  mocks.requireRole.mockReset().mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG },
  });
  mocks.loadAuthUser.mockReset().mockResolvedValue({ id: USER, idioma: "pt-BR" });
  mocks.orgAtivaDaApi.mockReset().mockResolvedValue({ ok: true, org: { orgId: ORG } });
  mocks.getUser.mockReset().mockResolvedValue({ data: { user: { id: USER } }, error: null });
  mocks.getContactHandler.mockReset().mockResolvedValue({ cpf_available: true, cpf_decrypted: "123" });
});

describe("GET /api/v1/contacts/[id] — CPF descriptografado", () => {
  it("exige o guard manager para qualquer pedido de descriptografia", async () => {
    await GET(request("customer-service"), { params: Promise.resolve({ id: CONTACT }) });

    expect(mocks.requireRole).toHaveBeenCalledWith("manager", expect.objectContaining({ resource: "contacts" }));
    expect(mocks.getContactHandler).toHaveBeenCalled();
  });

  it("retorna a recusa do guard MFA/RBAC sem buscar ou descriptografar o contato", async () => {
    const denied = new Response(JSON.stringify({ error: { code: "mfa_required" } }), { status: 403 });
    mocks.requireRole.mockResolvedValueOnce({ ok: false, response: denied });

    const response = await GET(request("customer-service"), { params: Promise.resolve({ id: CONTACT }) });

    expect(response.status).toBe(403);
    expect(mocks.getContactHandler).not.toHaveBeenCalled();
  });

  it("não exige manager para leitura sem pedido de CPF plaintext", async () => {
    await GET(request(), { params: Promise.resolve({ id: CONTACT }) });

    expect(mocks.requireRole).not.toHaveBeenCalled();
    expect(mocks.getContactHandler).toHaveBeenCalled();
  });
});
