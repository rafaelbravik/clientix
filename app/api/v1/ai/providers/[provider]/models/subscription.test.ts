import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  loadAuthUser: vi.fn(),
  orgAtivaDaApi: vi.fn(),
  listarModelosDaAssinatura: vi.fn(),
  createClient: vi.fn(),
}));

vi.mock("@/lib/auth/server", () => ({ loadAuthUser: mocks.loadAuthUser }));
vi.mock("@/lib/auth/require-role", () => ({ orgAtivaDaApi: mocks.orgAtivaDaApi }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/ai/catalogo/modelos-da-assinatura", () => ({
  listarModelosDaAssinatura: mocks.listarModelosDaAssinatura,
}));

import { GET } from "./route";

const USER = { id: "user-a", idioma: "pt-BR" };

async function listar(provider = "openai-assinatura") {
  const request = new NextRequest(`http://localhost/api/v1/ai/providers/${provider}/models`);
  return GET(request, { params: Promise.resolve({ provider }) });
}

describe("rota de modelos da assinatura ChatGPT", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadAuthUser.mockResolvedValue(USER);
    mocks.orgAtivaDaApi.mockResolvedValue({
      ok: true,
      org: { orgId: "org-a", role: "admin", org_status: "active" },
    });
  });

  it("usa somente a organização da sessão e devolve modelos da conta correspondente", async () => {
    mocks.listarModelosDaAssinatura.mockResolvedValue({
      ok: true,
      catalog_status: "ready",
      models: [{ model_id: "gpt-A", display_name: "Conta A" }],
    });
    const response = await listar();
    expect(response.status).toBe(200);
    expect(mocks.listarModelosDaAssinatura).toHaveBeenCalledWith({ organizationId: "org-a" });
    const body = await response.json();
    expect(body.data.models.map((model: { model_id: string }) => model.model_id)).toEqual(["gpt-A"]);
    expect(JSON.stringify(body)).not.toContain("access_token");
  });

  it("preserva o acesso de leitura que a rota já oferecia aos papéis da organização", async () => {
    mocks.orgAtivaDaApi.mockResolvedValue({
      ok: true,
      org: { orgId: "org-a", role: "agent", org_status: "active" },
    });
    mocks.listarModelosDaAssinatura.mockResolvedValue({
      ok: true,
      catalog_status: "ready",
      models: [{ model_id: "gpt-A", display_name: "Conta A" }],
    });
    const response = await listar();
    expect(response.status).toBe(200);
    expect(mocks.listarModelosDaAssinatura).toHaveBeenCalledWith({ organizationId: "org-a" });
  });

  it("recusa feature desligada sem consultar catálogo global ou chamar o endpoint", async () => {
    mocks.listarModelosDaAssinatura.mockResolvedValue({ ok: false, error: "feature_disabled" });
    const response = await listar();
    expect(response.status).toBe(403);
    expect(mocks.createClient).not.toHaveBeenCalled();
    expect(mocks.listarModelosDaAssinatura).toHaveBeenCalledWith({ organizationId: "org-a" });
    expect((await response.json()).error.code).toBe("feature_disabled");
  });

  it("mantém erro de conta ausente distinto de erro de catálogo", async () => {
    mocks.listarModelosDaAssinatura.mockResolvedValue({ ok: false, error: "not_connected" });
    const response = await listar();
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe("not_connected");
  });

  it.each([
    ["models_timeout", 504],
    ["models_network_error", 502],
    ["models_http_error", 502],
    ["models_invalid_payload", 502],
    ["models_refresh_failed", 500],
  ] as const)("preserva o estado conectado e mapeia %s para HTTP %i", async (error, status) => {
    mocks.listarModelosDaAssinatura.mockResolvedValue({ ok: false, error });
    const response = await listar();
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(error);
  });

  it("uma organização diferente consulta e recebe somente o seu catálogo", async () => {
    mocks.orgAtivaDaApi
      .mockResolvedValueOnce({ ok: true, org: { orgId: "org-a", role: "admin", org_status: "active" } })
      .mockResolvedValueOnce({ ok: true, org: { orgId: "org-b", role: "admin", org_status: "active" } });
    mocks.listarModelosDaAssinatura
      .mockResolvedValueOnce({ ok: true, catalog_status: "ready", models: [{ model_id: "gpt-A", display_name: "A" }] })
      .mockResolvedValueOnce({ ok: true, catalog_status: "ready", models: [{ model_id: "gpt-B", display_name: "B" }] });

    const responseA = await listar();
    const responseB = await listar();
    expect(mocks.listarModelosDaAssinatura.mock.calls).toEqual([
      [{ organizationId: "org-a" }],
      [{ organizationId: "org-b" }],
    ]);
    expect((await responseA.json()).data.models[0].model_id).toBe("gpt-A");
    expect((await responseB.json()).data.models[0].model_id).toBe("gpt-B");
  });
});
