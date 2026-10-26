import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const URL_DB = "https://supabase.example.test";
const URL_REDIS = "https://redis.example.test";
const URL_WAHA = "https://waha.example.test";
const SEGREDO = "health-secret-for-test-only";

vi.mock("@/lib/env", () => ({
  env: {
    NEXT_PUBLIC_SUPABASE_URL: URL_DB,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon-test-key",
    SUPABASE_SERVICE_ROLE_KEY: "service-test-key",
    UPSTASH_REDIS_REST_URL: URL_REDIS,
    UPSTASH_REDIS_REST_TOKEN: "redis-test-token",
    WAHA_API_BASE_URL: URL_WAHA,
    WAHA_API_KEY: "waha-test-key",
    INTERNAL_CRON_SECRET: SEGREDO,
    INTERNAL_SECRET: "",
  },
}));

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function postgrestJson(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json; charset=utf-8", "content-range": "*/0" },
  });
}

function pedido(verbose = false): NextRequest {
  return new NextRequest(`https://crm.example.test/api/v1/health${verbose ? "?verbose=1" : ""}`, {
    headers: verbose ? { authorization: `Bearer ${SEGREDO}` } : {},
  });
}

function prepararFetch(respostaDb: Response = postgrestJson([])) {
  const chamadas: Array<{ url: string; init?: RequestInit }> = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    chamadas.push({ url, init });
    if (url.startsWith(URL_DB)) return respostaDb;
    if (url === URL_REDIS) return json({ result: "PONG" });
    return json({ startTimestamp: 1_729_000_000_000, uptime: 42 });
  });
  return chamadas;
}

async function ler(resposta: Response) {
  return (await resposta.json()).data as {
    status: string;
    checks: Record<string, Record<string, unknown>>;
  };
}

describe("GET /api/v1/health — identidade e readiness sem redirects", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllGlobals());

  it("200 JSON PostgREST esperado declara alcance, identidade, credencial e readiness", async () => {
    prepararFetch(postgrestJson([{ id: "org-1" }]));
    const { GET } = await import("@/app/api/v1/health/route");
    const data = await ler(await GET(pedido()));

    expect(data.status).toBe("healthy");
    expect(data.checks.supabase).toMatchObject({
      status: "ok",
      reachability: "reachable",
      identity: "verified",
      credentials: "accepted",
      readiness: "ready",
    });
  });

  it("JSON vazio só confirma PostgREST com Content-Range do protocolo", async () => {
    prepararFetch(postgrestJson([]));
    const { GET } = await import("@/app/api/v1/health/route");
    const data = await ler(await GET(pedido()));

    expect(data.checks.supabase).toMatchObject({
      status: "ok",
      identity: "verified",
      readiness: "ready",
    });
  });

  it("array vazio sem identidade PostgREST não passa como banco saudável", async () => {
    prepararFetch(json([]));
    const { GET } = await import("@/app/api/v1/health/route");
    const data = await ler(await GET(pedido()));

    expect(data.status).toBe("unhealthy");
    expect(data.checks.supabase).toMatchObject({
      status: "down",
      identity: "rejected",
      readiness: "not_ready",
    });
  });

  it("WAHA é identificado pelo status do servidor mesmo sem sessões pareadas", async () => {
    const chamadas: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = String(input);
      chamadas.push(url);
      if (url.startsWith(URL_DB)) return postgrestJson([]);
      if (url === URL_REDIS) return json({ result: "PONG" });
      return json({ startTimestamp: 1_729_000_000_000, uptime: 0 });
    });
    const { GET } = await import("@/app/api/v1/health/route");
    const data = await ler(await GET(pedido()));

    expect(data.checks.waha).toMatchObject({
      status: "ok",
      identity: "verified",
      readiness: "ready",
    });
    expect(chamadas.some((url) => url.endsWith("/api/server/status"))).toBe(true);
    expect(chamadas.some((url) => url.endsWith("/api/sessions"))).toBe(false);
  });

  it.each([302, 307])("redirect HTTP %s para login continua unhealthy", async (status) => {
    const chamadas = prepararFetch(
      new Response("", { status, headers: { location: "/login" } }),
    );
    const { GET } = await import("@/app/api/v1/health/route");
    const data = await ler(await GET(pedido()));

    expect(data.status).toBe("unhealthy");
    expect(data.checks.supabase).toMatchObject({
      status: "down",
      reachability: "reachable",
      identity: "unknown",
      readiness: "not_ready",
      reason: "resposta_inesperada",
    });
    const chamadaDb = chamadas.find((chamada) => chamada.url.startsWith(URL_DB));
    expect(chamadaDb?.init?.redirect).toBe("manual");
    expect(chamadas.filter((chamada) => chamada.url.includes("/login"))).toHaveLength(0);
  });

  it("HTML 200, com ou sem content-type JSON, não passa como Supabase", async () => {
    for (const resposta of [
      new Response("<html>login</html>", {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
      new Response("<html>login</html>", { status: 200 }),
    ]) {
      vi.resetModules();
      prepararFetch(resposta);
      const { GET } = await import("@/app/api/v1/health/route");
      const data = await ler(await GET(pedido()));
      expect(data.status).toBe("unhealthy");
      expect(data.checks.supabase).toMatchObject({ status: "down", identity: "rejected" });
    }
  });

  it("JSON malformed não confirma identidade PostgREST", async () => {
    prepararFetch(new Response("{broken", { status: 200, headers: { "content-type": "application/json" } }));
    const { GET } = await import("@/app/api/v1/health/route");
    const data = await ler(await GET(pedido()));
    expect(data.status).toBe("unhealthy");
    expect(data.checks.supabase).toMatchObject({ status: "down", identity: "rejected" });
  });

  it("401 PostgREST prova reachability e identidade, mas recusa credencial e readiness", async () => {
    prepararFetch(json({ code: "PGRST301", message: "JWT invalid" }, 401));
    const { GET } = await import("@/app/api/v1/health/route");
    const data = await ler(await GET(pedido()));
    expect(data.status).toBe("unhealthy");
    expect(data.checks.supabase).toMatchObject({
      status: "down",
      reachability: "reachable",
      identity: "verified",
      credentials: "rejected",
      readiness: "not_ready",
      reason: "credencial_recusada",
    });
  });

  it("403 PostgREST não finge credencial recusada nem serviço pronto", async () => {
    prepararFetch(json({ code: "PGRST301", message: "permission denied" }, 403));
    const { GET } = await import("@/app/api/v1/health/route");
    const data = await ler(await GET(pedido()));
    expect(data.status).toBe("unhealthy");
    expect(data.checks.supabase).toMatchObject({
      status: "down",
      reachability: "reachable",
      identity: "verified",
      credentials: "unknown",
      readiness: "not_ready",
      reason: "credencial_recusada",
    });
  });

  it("Redis e WAHA também exigem resposta JSON semântica", async () => {
    const chamadas: string[] = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      chamadas.push(url);
      if (url.startsWith(URL_DB)) return json([]);
      if (url === URL_REDIS) return new Response("<html>login</html>", { status: 200 });
      return json({ status: "ok" });
    });
    const { GET } = await import("@/app/api/v1/health/route");
    const data = await ler(await GET(pedido()));
    expect(data.status).toBe("unhealthy");
    expect(data.checks.redis).toMatchObject({ status: "down", identity: "rejected" });
    expect(data.checks.waha).toMatchObject({ status: "down", identity: "rejected" });
    expect(chamadas).toHaveLength(3);
  });

  it("timeout, DNS e TLS continuam classificados como falha de alcance", async () => {
    const falha = { tipo: "timeout" as "timeout" | "dns" | "tls" };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (!String(input).startsWith(URL_DB)) return json({ result: "PONG" });
      const code = falha.tipo === "dns" ? "ENOTFOUND" : falha.tipo === "tls" ? "CERT_HAS_EXPIRED" : "ETIMEDOUT";
      throw Object.assign(new Error(falha.tipo === "timeout" ? "timeout after 3000ms" : "fetch failed"), {
        cause: { code },
      });
    });
    for (const [tipo, reason] of [
      ["timeout", "tempo_esgotado"],
      ["dns", "endereco_nao_resolve"],
      ["tls", "tls_recusado"],
    ] as const) {
      falha.tipo = tipo;
      vi.resetModules();
      const { GET: get } = await import("@/app/api/v1/health/route");
      const data = await ler(await get(pedido()));
      expect(data.checks.supabase).toMatchObject({ status: "down", reachability: "unreachable", reason });
    }
  });

  it("mantém redaction pública e detalhe no modo interno autenticado", async () => {
    const host = "private-db.example.test";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (String(input).startsWith(URL_DB)) return json([]);
      throw new Error(`could not connect to ${host}`);
    });
    const { GET } = await import("@/app/api/v1/health/route");
    const publico = JSON.stringify(await (await GET(pedido())).json());
    expect(publico).not.toContain(host);

    vi.resetModules();
    const { GET: getInterno } = await import("@/app/api/v1/health/route");
    const interno = JSON.stringify(await (await getInterno(pedido(true))).json());
    expect(interno).toContain(host);
  });
});
