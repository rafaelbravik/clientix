import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createLocalHttpProvider,
  LOCAL_HTTP_LIMITS,
  parseLocalHttpJsonResponse,
  projectLocalHttpResult,
  validateLocalHttpTarget,
} from "@/lib/prospecting/provider-local-http";
import { assertProspectingSourceAllowed, isProspectingSourceAllowed } from "@/lib/prospecting/source-policy";
import { assertLocalHttpSearchCapacity, localHttpGlobalSlots } from "@/lib/prospecting/local-http-limits";
import { searchSchema } from "@/lib/prospecting/schema";

afterEach(() => vi.unstubAllGlobals());

const input = searchSchema.parse({ name: "QA sintético", niche: "padaria", location: "Campinas" });
const jsonHeaders = { "content-type": "application/json; charset=utf-8" };
const rawHeaders = ["content-type", "application/json; charset=utf-8"];
const encode = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("local-http prospecting provider", () => {
  it("permite somente a fonte sintética em testes; fontes reais continuam fechadas", () => {
    expect(isProspectingSourceAllowed("synthetic", "test")).toBe(true);
    expect(isProspectingSourceAllowed("google_maps", "test")).toBe(false);
    expect(isProspectingSourceAllowed("google_maps", "production")).toBe(false);
    expect(() => assertProspectingSourceAllowed("google_maps")).toThrowError(
      expect.objectContaining({ code: "prospecting_source_not_approved", status: 403 }),
    );
  });

  it("executa o ciclo sintético por transporte falso, sem rede externa", async () => {
    const requestJson = vi
      .fn()
      .mockResolvedValueOnce({ status: "ok" })
      .mockResolvedValueOnce({ job_id: "qa-job", status: "pending" })
      .mockResolvedValueOnce({
        job_id: "qa-job",
        status: "completed",
        results: [
          {
            title: "Empresa sintética",
            placeId: "place-qa-1",
            phone: "+55 19 3000-0000",
            website: "https://example.invalid",
            categoryName: "Comércio",
            address: "Endereço sintético",
            url: "https://example.invalid/listing/1",
            totalScore: 4.8,
            reviewsCount: 12,
            email: "must-not-persist@example.invalid",
            instagram: "https://social.invalid/example",
            latitude: 1,
            raw: { secret: "drop" },
          },
        ],
      })
      .mockResolvedValueOnce({
        job_id: "qa-job",
        status: "completed",
        results: [
          {
            title: "Empresa sintética",
            placeId: "place-qa-1",
            phone: "+55 19 3000-0000",
            website: "https://example.invalid",
            categoryName: "Comércio",
            address: "Endereço sintético",
            url: "https://example.invalid/listing/1",
            totalScore: 4.8,
            reviewsCount: 12,
          },
        ],
      });
    const provider = createLocalHttpProvider({
      source: "synthetic",
      getBaseUrl: () => "http://engine.qa.internal",
      resolve: async () => [{ address: "192.168.50.10", family: 4 }],
      internalIpAllowed: async () => true,
      requestJson,
    });

    await expect(provider.healthCheck()).resolves.toBeUndefined();
    const started = await provider.startSearch("", input);
    expect(started).toMatchObject({ id: "qa-job", status: "RUNNING" });
    const finished = await provider.readSearch("", "qa-job");
    expect(finished.status).toBe("SUCCEEDED");
    const results = await provider.readResults("", "qa-job", 20);
    expect(results).toHaveLength(1);
    expect(Object.keys(results[0]!).sort()).toEqual(
      ["address", "categoryName", "placeId", "phone", "reviewsCount", "title", "totalScore", "url", "website"].sort(),
    );
    expect(JSON.stringify(results)).not.toMatch(/must-not-persist|social\.invalid|latitude|secret/);
    expect(requestJson.mock.calls.map((call) => [call[2], call[3]])).toEqual([
      ["GET", "/api/v1/health"],
      ["POST", "/api/v1/scrape"],
      ["GET", "/api/v1/jobs/qa-job"],
      ["GET", "/api/v1/jobs/qa-job"],
    ]);
    const timeoutCaps = [
      LOCAL_HTTP_LIMITS.healthTimeoutMs,
      LOCAL_HTTP_LIMITS.startTimeoutMs,
      LOCAL_HTTP_LIMITS.readTimeoutMs,
      LOCAL_HTTP_LIMITS.resultsTimeoutMs,
    ];
    for (const [index, call] of requestJson.mock.calls.entries()) {
      expect(call[5]).toBeGreaterThan(0);
      expect(call[5]).toBeLessThanOrEqual(timeoutCaps[index]!);
    }
    expect(requestJson.mock.calls[1]![4]).not.toHaveProperty("url");
    expect(requestJson.mock.calls[1]![4]).not.toHaveProperty("authorization");
  });

  it("bloqueia o provider de produção antes de ler config ou abrir rede", async () => {
    const getBaseUrl = vi.fn(() => "https://not-used.example");
    const requestJson = vi.fn();
    const provider = createLocalHttpProvider({ getBaseUrl, requestJson });
    await expect(provider.healthCheck()).rejects.toMatchObject({
      code: "prospecting_source_not_approved",
      status: 403,
    });
    expect(getBaseUrl).not.toHaveBeenCalled();
    expect(requestJson).not.toHaveBeenCalled();
  });

  it.each([
    ["file:///etc/passwd", "invalid_engine_url"],
    ["http://localhost:3000", "unsafe_engine_target"],
    ["http://127.0.0.1:3000", "unsafe_engine_target"],
    ["http://engine.example/path", "invalid_engine_url"],
  ])("recusa URL de engine inválida (%s)", async (url, code) => {
    await expect(validateLocalHttpTarget(url, { resolve: async () => [] })).rejects.toMatchObject({ code });
  });

  it("exige HTTPS para destino público e bloqueia redes especiais/mistas", async () => {
    const publicDns = async () => [{ address: "8.8.8.8", family: 4 }];
    await expect(validateLocalHttpTarget("http://engine.example", { resolve: publicDns })).rejects.toMatchObject({
      code: "engine_https_required",
    });
    await expect(validateLocalHttpTarget("https://engine.example", { resolve: publicDns })).resolves.toMatchObject({
      pinnedAddress: { address: "8.8.8.8", family: 4 },
    });
    await expect(
      validateLocalHttpTarget("http://engine.internal", {
        resolve: async () => [{ address: "192.168.50.10", family: 4 }],
        internalIpAllowed: async () => false,
      }),
    ).rejects.toMatchObject({ code: "unsafe_engine_target" });
    for (const address of ["169.254.169.254", "100.64.0.1", "fe80::1", "::1"]) {
      await expect(
        validateLocalHttpTarget(`https://engine.example`, {
          resolve: async () => [{ address, family: address.includes(":") ? 6 : 4 }],
        }),
      ).rejects.toMatchObject({ code: "unsafe_engine_target" });
    }
    await expect(
      validateLocalHttpTarget("https://engine.example", {
        resolve: async () => [
          { address: "8.8.8.8", family: 4 },
          { address: "192.168.50.10", family: 4 },
        ],
        internalIpAllowed: async () => true,
      }),
    ).rejects.toMatchObject({ code: "unsafe_engine_target" });
  });

  it.each([301, 302])("falha fechado em redirect HTTP %s", (status) => {
    expect(() => parseLocalHttpJsonResponse(status, rawHeaders, jsonHeaders, encode({}), "POST")).toThrowError(
      expect.objectContaining({ code: "engine_redirect_blocked", uncertain: true }),
    );
  });

  it("limita headers/body e rejeita JSON inválido ou comprimido", () => {
    expect(() =>
      parseLocalHttpJsonResponse(
        200,
        Array.from({ length: 17_000 }, () => "x"),
        jsonHeaders,
        encode({}),
        "GET",
      ),
    ).toThrowError(expect.objectContaining({ code: "engine_response_too_large" }));
    expect(() =>
      parseLocalHttpJsonResponse(200, rawHeaders, jsonHeaders, new Uint8Array(LOCAL_HTTP_LIMITS.maxResponseBytes + 1), "POST"),
    ).toThrowError(expect.objectContaining({ code: "engine_response_too_large", uncertain: true }));
    expect(() =>
      parseLocalHttpJsonResponse(200, rawHeaders, jsonHeaders, new TextEncoder().encode("{"), "GET"),
    ).toThrowError(expect.objectContaining({ code: "engine_invalid_json" }));
    expect(() =>
      parseLocalHttpJsonResponse(
        200,
        rawHeaders,
        { ...jsonHeaders, "content-encoding": "gzip" },
        encode({}),
        "GET",
      ),
    ).toThrowError(expect.objectContaining({ code: "engine_response_encoding" }));
  });

  it("falha fechado para estado desconhecido e ignora campos fora da allowlist", async () => {
    const provider = createLocalHttpProvider({
      source: "synthetic",
      getBaseUrl: () => "http://engine.qa.internal",
      resolve: async () => [{ address: "192.168.50.10", family: 4 }],
      internalIpAllowed: async () => true,
      requestJson: vi.fn().mockResolvedValue({ job_id: "qa-job", status: "mystery" }),
    });
    await expect(provider.readSearch("", "qa-job")).rejects.toMatchObject({
      code: "engine_invalid_response",
    });
    expect(projectLocalHttpResult({ title: "Fechado", placeId: "p", permanentlyClosed: true })).toBeNull();
    expect(projectLocalHttpResult({ title: "Sem lugar" })).toBeNull();
  });
});

describe("local-http quota and fairness policy", () => {
  it("applies rolling daily, interval, and per-organization limits", () => {
    expect(() => assertLocalHttpSearchCapacity({ acceptedInLast24Hours: 19, lastAcceptedAt: null, activeForOrganization: 0 })).not.toThrow();
    expect(() => assertLocalHttpSearchCapacity({ acceptedInLast24Hours: 20, lastAcceptedAt: null, activeForOrganization: 0 })).toThrowError(
      expect.objectContaining({ code: "prospecting_search_quota_exceeded", status: 429 }),
    );
    expect(() => assertLocalHttpSearchCapacity({ acceptedInLast24Hours: 0, lastAcceptedAt: new Date(999_500), activeForOrganization: 0 }, 1_000_000)).toThrowError(
      expect.objectContaining({ code: "prospecting_search_interval", status: 429 }),
    );
    expect(() => assertLocalHttpSearchCapacity({ acceptedInLast24Hours: 0, lastAcceptedAt: null, activeForOrganization: 1 })).toThrowError(
      expect.objectContaining({ code: "prospecting_search_concurrency", status: 409 }),
    );
  });

  it("leaves global slots to other organizations and caps at three", () => {
    expect(localHttpGlobalSlots(0)).toBe(3);
    expect(localHttpGlobalSlots(2)).toBe(1);
    expect(localHttpGlobalSlots(3)).toBe(0);
    expect(localHttpGlobalSlots(5)).toBe(0);
  });
});
