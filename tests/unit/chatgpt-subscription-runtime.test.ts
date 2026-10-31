import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const mocks = vi.hoisted(() => ({ accessToken: vi.fn() }));

vi.mock("@/lib/ai/credenciais/chatgpt-subscription", () => ({
  obterAccessTokenSiwc: mocks.accessToken,
}));

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";
import { tool } from "@/lib/agent-engine/edge/llm/run-model-call";
import { CHATGPT_SUBSCRIPTION_PROVIDER } from "@/lib/ai/credenciais/chatgpt-siwc";
import type { ResultadoDeAccessTokenSiwc } from "@/lib/ai/credenciais/chatgpt-subscription";
import {
  ChatGPTSubscriptionRuntimeError,
  classificarErroDaAssinatura,
} from "@/lib/agent-engine/edge/llm/subscription-runtime";

const ORG_A = "11111111-1111-4111-8111-111111111111";
const ORG_B = "22222222-2222-4222-8222-222222222222";
const MODEL_A = "gpt-org-a";
const MODEL_B = "gpt-org-b";

interface CapturedRequest {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
}

const requests: CapturedRequest[] = [];
let respostas: Response[] = [];
let fetchStub: ReturnType<typeof vi.fn>;
let catalogos = new Map<string, string[]>();

function token(
  organizationId: string,
  accessToken = `oauth-${organizationId}`,
  modelsAvailable = catalogos.get(organizationId) ?? [],
): ResultadoDeAccessTokenSiwc {
  return {
    ok: true,
    accessToken,
    scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
    subject: `sub-${organizationId}`,
    credentialId: `credential-${organizationId}`,
    modelsAvailable,
  };
}

function eventoSse(event: Record<string, unknown>): string {
  return `data: ${JSON.stringify(event)}\n\n`;
}

function respostaConcluida(texto = "resposta sintética", usage = { input_tokens: 12, input_tokens_details: { cached_tokens: 2 }, output_tokens: 5, output_tokens_details: { reasoning_tokens: 0 } }): Response {
  const stream = [
    eventoSse({ type: "response.created", response: { id: "resp-synthetic", created_at: 1_793_433_600, model: "gpt-synthetic" } }),
    eventoSse({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "item-synthetic" } }),
    eventoSse({ type: "response.output_text.delta", item_id: "item-synthetic", output_index: 0, delta: texto }),
    eventoSse({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "item-synthetic" } }),
    eventoSse({ type: "response.completed", response: { id: "resp-synthetic", status: "completed", usage } }),
  ].join("");
  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function poolFalso(organizationId: string, extra: {
  mode?: string;
  teto?: number;
  gasto?: string;
  binding?: { provider: string; credential_id: string | null; model_id: string; base_url: string | null; is_enabled: boolean };
} = {}) {
  const sqls: string[] = [];
  const inserts: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    sqls.push(sql);
    if (sql.includes("settings->'llm'")) {
      return {
        rows: [{
          llm: {
            provider: CHATGPT_SUBSCRIPTION_PROVIDER,
            default_model: MODEL_A,
            params: { temperature: 0.7, topP: 0.9, topK: 20 },
            // A lista global/configurada não pode autorizar assinatura.
            enabled_models: ["manual-or-global-model"],
            monthly_budget_cents: null,
          },
          modo: extra.mode ?? "off",
          teto: extra.teto ?? null,
          efetivo_em: new Date(Date.now() - 86_400_000),
          limiar_pct: 80,
        }],
      };
    }
    if (sql.includes("from ai_purpose_bindings")) return { rows: extra.binding ? [extra.binding] : [] };
    if (sql.includes("ai_models")) throw new Error("subscription_runtime_must_not_read_global_catalog");
    if (sql.includes("from ai_provider_credentials")) {
      // A resolução OAuth vem exclusivamente pelo helper tenant-scoped SIWC.
      throw new Error("subscription_runtime_must_not_read_generic_credentials");
    }
    if (sql.includes("fn_gasto_de_ia_do_mes")) {
      return { rows: [{ teto: extra.teto ?? 100, modo: extra.mode ?? "bloquear", efetivo_em: new Date(Date.now() - 86_400_000), limiar_pct: 80, gasto: extra.gasto ?? "200", avisado_antes: true }] };
    }
    if (sql.includes("insert into llm_calls")) {
      inserts.push({ sql, params });
      return { rows: [{ id: "llm-call-synthetic" }] };
    }
    return { rows: [] };
  });
  return { db: { query } as never, query, sqls, inserts, organizationId };
}

function instalarFetch(responses: Response[]) {
  respostas = [...responses];
  requests.length = 0;
  fetchStub = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
    const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : "{}");
    requests.push({ url, headers, body: JSON.parse(String(rawBody)) as Record<string, unknown> });
    const response = respostas.shift();
    if (!response) throw new Error("unexpected_provider_request");
    return response;
  });
  vi.stubGlobal("fetch", fetchStub);
}

async function executar(organizationId: string, options: {
  model?: string;
  maxSteps?: number;
  tools?: Parameters<typeof runModelCall>[2]["tools"];
  refresh?: (org: string) => Promise<ResultadoDeAccessTokenSiwc>;
  budget?: { mode: string; teto: number; gasto: string };
  binding?: { provider: string; credential_id: string | null; model_id: string; base_url: string | null; is_enabled: boolean };
} = {}) {
  const pool = poolFalso(organizationId, { ...options.budget, binding: options.binding });
  return {
    pool,
    result: await runModelCall(
      pool.db,
      { openaiApiKey: "sk-synthetic-paid-fallback-must-not-be-used", anthropicApiKey: "sk-ant-synthetic", cacheTtl: "1h", budgetEnforcement: options.budget ? "on" : "off" },
      {
        tenantId: organizationId,
        purpose: "agent_preview",
        messages: [{ role: "user", content: "mensagem sintética" }],
        ...(options.model === undefined ? {} : { model: options.model }),
        ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
        ...(options.tools === undefined ? {} : { tools: options.tools }),
      },
      options.refresh ? { refreshSubscriptionToken: options.refresh } : {},
    ),
  };
}

describe("runtime Responses API da assinatura ChatGPT", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    catalogos = new Map([
      [ORG_A, [MODEL_A]],
      [ORG_B, [MODEL_B]],
    ]);
    mocks.accessToken.mockImplementation(async ({ organizationId }: { organizationId: string }) => token(organizationId));
    instalarFetch([respostaConcluida()]);
  });

  afterEach(() => vi.unstubAllGlobals());

  it("envia OAuth à Responses API pública com stream=true e store=false, preservando resposta e usage", async () => {
    const { pool, result } = await executar(ORG_A);

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer oauth-${ORG_A}`);
    expect(requests[0]?.body).toMatchObject({ stream: true, store: false, model: MODEL_A });
    const serialized = JSON.stringify(requests[0]?.body);
    for (const forbidden of ["api_key", "refresh_token", "id_token", "organization_id", "synthetic-paid-fallback"]) {
      expect(serialized).not.toContain(forbidden);
    }
    expect(serialized).not.toContain("oauth-");
    expect(result.provider).toBe("openai-assinatura");
    expect(result.model).toBe(MODEL_A);
    expect(result.result.text).toBe("resposta sintética");
    expect(result.result.responseMessages).toEqual(result.result.response.messages);
    expect(result.result.steps).toHaveLength(1);
    expect(result.usage).toMatchObject({ inputTokens: 12, outputTokens: 5, cacheReadTokens: 2 });
    expect(result.costCents).toBeNull();
    expect(pool.inserts[0]?.params).toContain("openai-assinatura");
    expect(pool.inserts[0]?.params).toContain(MODEL_A);
    expect(pool.inserts[0]?.params[11]).toBeNull();
    expect(pool.sqls.some((sql) => sql.includes("ai_models"))).toBe(false);
  });

  it("usa tokens e catálogos isolados em chamadas concorrentes de ORG_A e ORG_B", async () => {
    instalarFetch([respostaConcluida("A"), respostaConcluida("B")]);
    await Promise.all([
      executar(ORG_A, { model: MODEL_A }),
      executar(ORG_B, { model: MODEL_B }),
    ]);

    expect(requests.map((request) => [request.body.model, request.headers.get("authorization")])).toEqual([
      [MODEL_A, `Bearer oauth-${ORG_A}`],
      [MODEL_B, `Bearer oauth-${ORG_B}`],
    ]);
  });

  it("rejeita modelo manual/global ausente do catálogo tenant antes de qualquer request", async () => {
    catalogos.set(ORG_A, []);
    await expect(executar(ORG_A, { model: "manual-or-global-model" })).rejects.toMatchObject({
      code: "subscription_model_not_available",
    });
    expect(requests).toHaveLength(0);
  });

  it("não usa o catálogo de outra organização como fallback", async () => {
    await expect(executar(ORG_A, { model: MODEL_B })).rejects.toMatchObject({
      code: "subscription_model_not_available",
    });
    expect(requests).toHaveLength(0);
  });

  it("a lista substituída após reautorização remove o modelo antigo do runtime", async () => {
    await executar(ORG_A, { model: MODEL_A });
    catalogos.set(ORG_A, ["gpt-new-from-account"]);
    await expect(executar(ORG_A, { model: MODEL_A })).rejects.toMatchObject({
      code: "subscription_model_not_available",
    });
    expect(requests).toHaveLength(1);
  });

  it("faz no máximo um refresh/retry controlado em 401, com catálogo novo", async () => {
    instalarFetch([
      new Response(JSON.stringify({ error: { message: "Bearer oauth-old-token" } }), { status: 401, headers: { "content-type": "application/json" } }),
      respostaConcluida("token renovado"),
    ]);
    const refresh = vi.fn(async (organizationId: string) => token(organizationId, "oauth-new-token", [MODEL_A]));

    await executar(ORG_A, { refresh });

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(ORG_A);
    expect(requests).toHaveLength(2);
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      `Bearer oauth-${ORG_A}`,
      "Bearer oauth-new-token",
    ]);
  });

  it("falha após o segundo 401 sem uma terceira tentativa e sem expor o token", async () => {
    instalarFetch([
      new Response(JSON.stringify({ error: { message: "Bearer oauth-old-token" } }), { status: 401 }),
      new Response(JSON.stringify({ error: { message: "Bearer oauth-new-token" } }), { status: 401 }),
    ]);
    const refresh = vi.fn(async (organizationId: string) => token(organizationId, "oauth-new-token", [MODEL_A]));
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

    const pool = poolFalso(ORG_A);
    await expect(runModelCall(
      pool.db,
      { openaiApiKey: "sk-synthetic-paid-fallback-must-not-be-used", cacheTtl: "1h", budgetEnforcement: "off" },
      { tenantId: ORG_A, purpose: "agent_preview", messages: [{ role: "user", content: "sintético" }] },
      { refreshSubscriptionToken: refresh, log: log as never },
    )).rejects.toBeInstanceOf(ChatGPTSubscriptionRuntimeError);

    expect(refresh).toHaveBeenCalledTimes(1);
    expect(requests).toHaveLength(2);
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("oauth-");
    expect(JSON.stringify(pool.inserts)).not.toContain("oauth-");
    expect(JSON.stringify(pool.inserts)).not.toContain("Bearer ");
  });

  it("stream sem response.completed não devolve texto parcial como sucesso", async () => {
    instalarFetch([new Response(eventoSse({ type: "response.output_text.delta", item_id: "partial", output_index: 0, delta: "parcial" }), { status: 200, headers: { "content-type": "text/event-stream" } })]);
    await expect(executar(ORG_A)).rejects.toMatchObject({ code: "subscription_stream_incomplete" });
  });

  it("preserva tools e o limite de multi-step na Responses API", async () => {
    const executouTool = vi.fn(async ({ value }: { value: string }) => `retorno-${value}`);
    const tools = {
      lookup: tool({
        description: "consulta sintética",
        inputSchema: z.object({ value: z.string() }),
        execute: executouTool,
      }),
    };
    const primeiraResposta = [
      eventoSse({ type: "response.output_item.done", output_index: 0, item: { type: "function_call", id: "fc-1", call_id: "call-1", name: "lookup", arguments: JSON.stringify({ value: "x" }), status: "completed" } }),
      eventoSse({ type: "response.completed", response: { id: "resp-tool", status: "completed", usage: { input_tokens: 4, output_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } }),
    ].join("");
    instalarFetch([
      new Response(primeiraResposta, { status: 200, headers: { "content-type": "text/event-stream" } }),
      respostaConcluida("ferramenta usada"),
    ]);

    const { result } = await executar(ORG_A, { tools, maxSteps: 2 });

    expect(executouTool).toHaveBeenCalledWith({ value: "x" }, expect.anything());
    expect(requests).toHaveLength(2);
    expect(requests[0]?.body.tools).toBeDefined();
    expect(result.result.steps.length).toBeGreaterThanOrEqual(2);
  });

  it("não transforma rate limit em fallback para provider openai ou chave paga", async () => {
    instalarFetch([
      new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json" } }),
      new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429, headers: { "content-type": "application/json" } }),
    ]);

    let erro: unknown;
    try { await executar(ORG_A); } catch (caught) { erro = caught; }
    expect({
      code: (erro as { code?: unknown } | undefined)?.code,
      statusCode: (erro as { statusCode?: unknown } | undefined)?.statusCode,
      requests: requests.length,
      requestStatuses: fetchStub.mock.results.length,
    }).toEqual({ code: "subscription_rate_limited", statusCode: 429, requests: 3, requestStatuses: 3 });

    expect(requests.length).toBeGreaterThanOrEqual(1);
    expect(requests.every((request) => request.url === "https://api.openai.com/v1/responses")).toBe(true);
    expect(requests.every((request) => request.headers.get("authorization") === `Bearer oauth-${ORG_A}`)).toBe(true);
  });

  it("recusa base URL personalizada antes de qualquer request", async () => {
    await expect(executar(ORG_A, {
      binding: {
        provider: CHATGPT_SUBSCRIPTION_PROVIDER,
        credential_id: null,
        model_id: MODEL_A,
        base_url: "https://attacker.invalid/v1",
        is_enabled: true,
      },
    })).rejects.toMatchObject({ code: "subscription_invalid_request" });
    expect(requests).toHaveLength(0);
  });

  it("budget bloqueia antes de sair qualquer byte ao provider", async () => {
    await expect(executar(ORG_A, { budget: { mode: "bloquear", teto: 100, gasto: "200" } })).rejects.toMatchObject({
      name: "llm_budget_exceeded",
    });
    expect(requests).toHaveLength(0);
  });

  it("mapeia limite de uso em HTTP 400 para erro de limite sem chave de API", () => {
    const error = Object.assign(new Error("The ChatGPT user has reached their Subscription Sharing usage limit"), { statusCode: 400 });
    expect(classificarErroDaAssinatura(error)).toMatchObject({
      code: "subscription_usage_limit",
      statusCode: 400,
    });
  });

  it("feature off e falha de rede são tipadas antes de qualquer caminho alternativo", async () => {
    mocks.accessToken.mockResolvedValueOnce({ ok: false, error: "feature_disabled" });
    await expect(executar(ORG_A)).rejects.toMatchObject({ code: "subscription_feature_disabled" });
    expect(requests).toHaveLength(0);

    mocks.accessToken.mockImplementationOnce(async () => token(ORG_A));
    instalarFetch([]);
    fetchStub.mockRejectedValueOnce(new TypeError("network unavailable"));
    await expect(executar(ORG_A)).rejects.toMatchObject({ code: "subscription_unavailable" });
    expect(fetchStub).toHaveBeenCalledOnce();
  });
});
