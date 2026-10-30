import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const SUPABASE_URL = "https://projeto-interno.exemplo.supabase.co";
const ANON_KEY = "anon-key-ficticia";
const INTERNAL_SECRET = "segredo-interno-ficticio-com-tamanho-suficiente";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: SUPABASE_URL,
    SUPABASE_SERVER_URL: "",
    NEXT_PUBLIC_SUPABASE_ANON_KEY: ANON_KEY,
    UPSTASH_REDIS_REST_URL: "",
    UPSTASH_REDIS_REST_TOKEN: "",
    INTERNAL_CRON_SECRET: INTERNAL_SECRET,
    INTERNAL_SECRET: "",
  },
}));

type HealthCheck = {
  status: string;
  reachability: string;
  identity: string;
  credentials: string;
  readiness: string;
  reason?: string;
  error?: string;
  target?: string;
};

async function consultarSupabase(
  resposta: () => Response | Promise<Response>,
  query = "",
  headers: Record<string, string> = {},
) {
  vi.resetModules();
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    expect(String(input)).toContain(`${SUPABASE_URL}/rest/v1/system_version`);
    return resposta();
  });
  vi.stubGlobal("fetch", fetchMock);

  const { GET } = await import("./route");
  const response = await GET(
    new NextRequest(`https://crm.exemplo.com.br/api/v1/health${query}`, { headers }),
  );
  const json = await response.json();
  const data = json.data as { checks: { supabase: HealthCheck } };
  return { data, check: data.checks.supabase, fetchMock };
}

function respostaJson(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function respostaPostgrestVazia(): Response {
  return new Response("[]", {
    status: 200,
    headers: { "content-type": "application/json", "content-range": "*/0" },
  });
}

function respostaComCorpoCortado(status: number): Response {
  const corpo = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"code":"incompleto"'));
      controller.error(Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
    },
  });
  return new Response(corpo, {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("GET /api/v1/health — diagnóstico de indisponibilidade Supabase", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("522 classifica projeto indisponível", async () => {
    const { check } = await consultarSupabase(() => new Response("", { status: 522 }));
    expect(check).toMatchObject({
      status: "down",
      reachability: "reachable",
      reason: "projeto_indisponivel",
    });
  });

  it("503 com PGRST002 classifica projeto indisponível", async () => {
    const { check } = await consultarSupabase(() =>
      respostaJson(503, {
        code: "PGRST002",
        message: "Could not query the database for the schema cache",
      }),
    );
    expect(check.reason).toBe("projeto_indisponivel");
  });

  it("5xx com indicação inequívoca de schema cache classifica projeto indisponível", async () => {
    const { check } = await consultarSupabase(() =>
      respostaJson(502, { message: "The schema cache is unavailable" }),
    );
    expect(check.reason).toBe("projeto_indisponivel");
  });

  it("503 genérico permanece resposta inesperada", async () => {
    const { check } = await consultarSupabase(() =>
      respostaJson(503, { code: "UPSTREAM_BUSY", message: "temporarily unavailable" }),
    );
    expect(check).toMatchObject({ status: "down", reason: "resposta_inesperada" });
  });

  it("PGRST205 em resposta 5xx não é tratado como indisponibilidade do projeto", async () => {
    const { check } = await consultarSupabase(() =>
      respostaJson(503, {
        code: "PGRST205",
        message: "Could not find the table in the schema cache",
      }),
    );
    expect(check.reason).toBe("resposta_inesperada");
  });

  it("PGRST205 não é tratado como indisponibilidade do projeto", async () => {
    const { check } = await consultarSupabase(() =>
      respostaJson(404, {
        code: "PGRST205",
        message: "Could not find the table in the schema cache",
      }),
    );
    expect(check).toMatchObject({ status: "down", reason: "resposta_inesperada" });
  });

  it("timeout sem resposta HTTP continua tempo_esgotado", async () => {
    const inicio = Date.now();
    const { check } = await consultarSupabase(() => new Promise<Response>(() => {}));
    expect(check).toMatchObject({ status: "down", reason: "tempo_esgotado" });
    expect(Date.now() - inicio).toBeLessThan(4_500);
  });

  it("ECONNRESET antes da resposta preserva a classificação de alcance", async () => {
    const erro = Object.assign(new TypeError("fetch failed"), {
      cause: Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }),
    });
    const { check } = await consultarSupabase(() => Promise.reject(erro));
    expect(check).toMatchObject({ status: "down", reason: "host_inalcancavel" });
  });

  it("200 com lista PostgREST vazia continua válido", async () => {
    const { check } = await consultarSupabase(respostaPostgrestVazia);
    expect(check).toMatchObject({
      status: "ok",
      reachability: "reachable",
      identity: "verified",
      credentials: "accepted",
      readiness: "ready",
    });
  });

  it("200 HTML não passa como PostgREST", async () => {
    const { check } = await consultarSupabase(
      () => new Response("<html>login</html>", { status: 200, headers: { "content-type": "text/html" } }),
    );
    expect(check).toMatchObject({ status: "down", reason: "resposta_inesperada" });
  });

  it.each([401, 403])("HTTP %s preserva que o serviço respondeu", async (status) => {
    const { check } = await consultarSupabase(() => respostaJson(status, { message: "denied" }));
    expect(check).toMatchObject({ status: "down", reachability: "reachable" });
  });

  it("redirect manual continua down e não faz uma segunda chamada", async () => {
    const { check, fetchMock } = await consultarSupabase(
      () => new Response("", { status: 302, headers: { location: "https://login.exemplo.invalid" } }),
    );
    expect(check).toMatchObject({ status: "down", reason: "resposta_inesperada" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]?.redirect).toBe("manual");
  });

  it("lê o corpo JSON uma única vez para classificar PGRST002", async () => {
    const response = respostaJson(503, { code: "PGRST002" });
    const text = vi.spyOn(response, "text");
    const { check } = await consultarSupabase(() => response);
    expect(check.reason).toBe("projeto_indisponivel");
    expect(text).toHaveBeenCalledTimes(1);
  });

  it("200 com corpo cortado fica down e mantém a causa de conexão", async () => {
    const { check } = await consultarSupabase(() => respostaComCorpoCortado(200));
    expect(check).toMatchObject({ status: "down", reachability: "reachable", reason: "host_inalcancavel" });
  });

  it("500 com corpo cortado mantém o status HTTP observado", async () => {
    const { check } = await consultarSupabase(
      () => respostaComCorpoCortado(500),
      "?verbose=1",
      { authorization: `Bearer ${INTERNAL_SECRET}` },
    );
    expect(check).toMatchObject({
      status: "down",
      reachability: "reachable",
      error: "http_500",
      reason: "resposta_inesperada",
    });
  });

  it("503 com falha de leitura não é reclassificado como timeout", async () => {
    const { check } = await consultarSupabase(
      () => respostaComCorpoCortado(503),
      "?verbose=1",
      { authorization: `Bearer ${INTERNAL_SECRET}` },
    );
    expect(check).toMatchObject({ error: "http_503", reason: "resposta_inesperada" });
  });

  it("detalhe operacional só sai para caller autenticado e não inclui segredo", async () => {
    const publico = await consultarSupabase(() => new Response("", { status: 522 }));
    const corpoPublico = JSON.stringify(publico.data);
    expect(corpoPublico).not.toContain(new URL(SUPABASE_URL).host);
    expect(corpoPublico).not.toContain(ANON_KEY);
    expect(publico.check.target).toBeUndefined();

    const autenticado = await consultarSupabase(
      () => new Response("", { status: 522 }),
      "?verbose=1",
      { authorization: `Bearer ${INTERNAL_SECRET}` },
    );
    expect(autenticado.check.target).toBe(`${new URL(SUPABASE_URL).origin}`);
    expect(autenticado.check.error).toContain("Supabase");
    expect(JSON.stringify(autenticado.data)).not.toContain(ANON_KEY);
  });
});
