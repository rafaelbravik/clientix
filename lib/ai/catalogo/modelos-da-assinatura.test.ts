import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  token: vi.fn(),
  moduloLigado: vi.fn(),
}));

vi.mock("@/lib/ai/credenciais/chatgpt-subscription", () => ({
  obterAccessTokenSiwc: mocks.token,
}));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: mocks.moduloLigado }));

import {
  CHATGPT_MODELS_ENDPOINT,
  CHATGPT_MODELS_TIMEOUT_MS,
  listarModelosDaAssinatura,
  validarModeloDaAssinatura,
} from "./modelos-da-assinatura";

function bancoCatalogo(options: {
  persistResult?: { data: { id: string } | null; error: { message: string } | null };
  rows?: Array<{ organization_id: string; models_available: string[]; is_active: boolean; validated_at: string | null }>;
} = {}) {
  const calls: Array<{ table: string; op: string; filters: Array<[string, unknown]>; patch?: unknown }> = [];
  const from = vi.fn((table: string) => {
    let op = "select";
    const filters: Array<[string, unknown]> = [];
    let patch: unknown;
    const call = { table, op, filters, patch };
    calls.push(call);
    const chain: Record<string, unknown> = {};
    chain.select = () => chain;
    chain.update = (value: unknown) => {
      op = "update";
      call.op = op;
      patch = value;
      call.patch = value;
      return chain;
    };
    chain.eq = (key: string, value: unknown) => {
      filters.push([key, value]);
      return chain;
    };
    chain.not = (key: string, operator: string, value: unknown) => {
      filters.push([`${key}:${operator}`, value]);
      return chain;
    };
    chain.maybeSingle = async () => {
      if (table === "ai_provider_credentials_safe") {
        const org = filters.find(([key]) => key === "organization_id")?.[1];
        const row = (options.rows ?? []).find((candidate) => candidate.organization_id === org);
        return { data: row ?? null, error: null };
      }
      return options.persistResult ?? { data: { id: "credential-a" }, error: null };
    };
    return chain;
  });
  return { admin: { from } as never, calls, from };
}

function resposta(corpo: unknown, status = 200): Response {
  return new Response(JSON.stringify(corpo), { status });
}

function fetchMock(response: Response | Error) {
  return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
    if (response instanceof Error || response instanceof DOMException) throw response;
    return response;
  }) as unknown as typeof fetch;
}

describe("catálogo da assinatura ChatGPT", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.token.mockResolvedValue({ ok: true, accessToken: "synthetic-oauth-access-token", scopes: [], subject: "sub-a" });
    mocks.moduloLigado.mockResolvedValue(true);
  });

  it("usa o Bearer OAuth, filtra visibility=list, preserva a ordem e persiste no tenant", async () => {
    const db = bancoCatalogo();
    const fetchImpl = fetchMock(resposta({
      models: [
        { visibility: "list", slug: "gpt-A", display_name: "Modelo A" },
        { visibility: "hide", slug: "internal", display_name: "Interno" },
        { visibility: "list", slug: "gpt-B", display_name: "Modelo B" },
      ],
    }));

    const result = await listarModelosDaAssinatura({ organizationId: "org-a", admin: db.admin, fetchImpl });

    expect(result).toEqual({
      ok: true,
      catalog_status: "ready",
      models: [
        { model_id: "gpt-A", display_name: "Modelo A" },
        { model_id: "gpt-B", display_name: "Modelo B" },
      ],
    });
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0]!;
    expect(url).toBe(CHATGPT_MODELS_ENDPOINT);
    expect(init?.method).toBe("GET");
    expect(init?.headers).toEqual({ Authorization: "Bearer synthetic-oauth-access-token" });
    expect(init?.cache).toBe("no-store");
    expect(init?.redirect).toBe("error");
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect((init?.signal as AbortSignal).aborted).toBe(false);
    expect(db.calls[0]?.filters).toContainEqual(["organization_id", "org-a"]);
    expect(db.calls[0]?.filters).toContainEqual(["provider", "openai-assinatura"]);
    expect(db.calls[0]?.patch).toEqual({ models_available: ["gpt-A", "gpt-B"] });
    expect(JSON.stringify(db.calls)).not.toContain("synthetic-oauth-access-token");
  });

  it("usa id quando slug não vem e usa o id como display_name ausente", async () => {
    const db = bancoCatalogo();
    const result = await listarModelosDaAssinatura({
      organizationId: "org-a",
      admin: db.admin,
      fetchImpl: fetchMock(resposta({ models: [{ visibility: "list", id: "gpt-fallback" }] })),
    });
    expect(result).toEqual({
      ok: true,
      catalog_status: "ready",
      models: [{ model_id: "gpt-fallback", display_name: "gpt-fallback" }],
    });
  });

  it("aceita catálogo vazio e grava a lista vazia sem tratar como desconectado", async () => {
    const db = bancoCatalogo();
    const result = await listarModelosDaAssinatura({
      organizationId: "org-a",
      admin: db.admin,
      fetchImpl: fetchMock(resposta({ models: [] })),
    });
    expect(result).toEqual({ ok: true, catalog_status: "models_empty_valid", models: [] });
    expect(db.calls[0]?.patch).toEqual({ models_available: [] });
  });

  it.each([
    ["feature_disabled", "feature_disabled"],
    ["not_connected", "not_connected"],
    ["refresh_failed", "token_refresh_failed"],
    ["storage_failed", "credential_storage_failed"],
  ] as const)("não chama o endpoint quando a resolução de token retorna %s", async (tokenError, expected) => {
    mocks.token.mockResolvedValue({ ok: false, error: tokenError });
    const fetchImpl = fetchMock(resposta({ models: [] }));
    const db = bancoCatalogo();
    const result = await listarModelosDaAssinatura({ organizationId: "org-a", admin: db.admin, fetchImpl });
    expect(result).toEqual({ ok: false, error: expected });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(db.calls).toEqual([]);
  });

  it.each([401, 403, 429, 500])("mantém erro HTTP %i como erro de catálogo sem atualizar cache", async (status) => {
    const db = bancoCatalogo();
    const result = await listarModelosDaAssinatura({
      organizationId: "org-a",
      admin: db.admin,
      fetchImpl: fetchMock(resposta({ error: "synthetic" }, status)),
    });
    expect(result).toEqual({ ok: false, error: "models_http_error", httpStatus: status });
    expect(db.calls).toEqual([]);
  });

  it.each([
    [new DOMException("timeout", "TimeoutError"), "models_timeout"],
    [new DOMException("aborted", "AbortError"), "models_timeout"],
    [new TypeError("network"), "models_network_error"],
  ] as const)("classifica falha de rede/timeout sem gravar catálogo", async (error, expected) => {
    const db = bancoCatalogo();
    const result = await listarModelosDaAssinatura({
      organizationId: "org-a",
      admin: db.admin,
      fetchImpl: fetchMock(error),
    });
    expect(result).toEqual({ ok: false, error: expected });
    expect(db.calls).toEqual([]);
  });

  it("classifica JSON e formato inesperados e preserva o catálogo anterior", async () => {
    const db = bancoCatalogo();
    const malformed = new Response("{", { status: 200 });
    const jsonFailure = await listarModelosDaAssinatura({
      organizationId: "org-a", admin: db.admin, fetchImpl: fetchMock(malformed),
    });
    expect(jsonFailure).toEqual({ ok: false, error: "models_invalid_payload" });

    const wrongShape = await listarModelosDaAssinatura({
      organizationId: "org-a", admin: db.admin, fetchImpl: fetchMock(resposta({ data: [] })),
    });
    expect(wrongShape).toEqual({ ok: false, error: "models_invalid_payload" });
    expect(db.calls).toEqual([]);
  });

  it("classifica erro de leitura do body como timeout, não como lista vazia", async () => {
    const db = bancoCatalogo();
    const bodyTimeout = {
      ok: true,
      json: async () => { throw new DOMException("timeout", "TimeoutError"); },
    } as unknown as Response;
    const result = await listarModelosDaAssinatura({
      organizationId: "org-a", admin: db.admin, fetchImpl: fetchMock(bodyTimeout),
    });
    expect(result).toEqual({ ok: false, error: "models_timeout" });
    expect(db.calls).toEqual([]);
    expect(CHATGPT_MODELS_TIMEOUT_MS).toBe(10_000);
  });

  it("não apaga modelos anteriores quando a persistência falha", async () => {
    const db = bancoCatalogo({ persistResult: { data: null, error: { message: "db" } } });
    const result = await listarModelosDaAssinatura({
      organizationId: "org-a",
      admin: db.admin,
      fetchImpl: fetchMock(resposta({ models: [{ visibility: "list", slug: "gpt-A", display_name: "A" }] })),
    });
    expect(result).toEqual({ ok: false, error: "models_refresh_failed" });
    expect(db.calls[0]?.filters).toContainEqual(["organization_id", "org-a"]);
  });

  it("valida modelos por credencial e organização, sem cruzar ORG_A e ORG_B", async () => {
    const rows = [
      { organization_id: "org-a", models_available: ["gpt-A"], is_active: true, validated_at: "2026-10-31T00:00:00Z" },
      { organization_id: "org-b", models_available: ["gpt-B"], is_active: true, validated_at: "2026-10-31T00:00:00Z" },
    ];
    const dbA = bancoCatalogo({ rows });
    const dbB = bancoCatalogo({ rows });

    await expect(validarModeloDaAssinatura({
      admin: dbA.admin, organizationId: "org-a", credentialId: "credential-a", modelId: "gpt-A",
    })).resolves.toEqual({ ok: true });
    await expect(validarModeloDaAssinatura({
      admin: dbB.admin, organizationId: "org-b", credentialId: "credential-b", modelId: "gpt-A",
    })).resolves.toEqual({ ok: false, error: "model_not_allowed" });
    expect(dbA.calls[0]?.filters).toContainEqual(["organization_id", "org-a"]);
    expect(dbB.calls[0]?.filters).toContainEqual(["organization_id", "org-b"]);
    expect(dbB.calls[0]?.filters).toContainEqual(["id", "credential-b"]);
  });
});
