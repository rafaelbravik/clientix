import pg from "pg";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { seedGov } from "./gov-helpers";
import { replyFixture } from "../support/autonomia-fixture";

const runtimeMocks = vi.hoisted(() => ({ accessToken: vi.fn() }));
vi.mock("@/lib/ai/credenciais/chatgpt-subscription", () => ({
  obterAccessTokenSiwc: runtimeMocks.accessToken,
}));

import { runModelCall } from "@/lib/agent-engine/edge/llm/run-model-call";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT ?? 54329}/postgres`,
  max: 5,
});

beforeAll(() => seedGov());
afterAll(() => pool.end());

type Fixture = Awaited<ReturnType<typeof replyFixture>> & {
  draft: string;
  credential: string | null;
};

async function criarCredencial(
  organizationId: string,
  provider: string,
  models: string[] | null,
): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into ai_provider_credentials
       (id, organization_id, provider, label, api_key_encrypted, api_key_iv,
        api_key_tag, api_key_last4, validated_at, models_available)
     values ($1,$2,$3,'fixture P0-1E','\\x01'::bytea,'\\x02'::bytea,
             '\\x03'::bytea,'0000',now(),$4)`,
    [id, organizationId, provider, models],
  );
  return id;
}

async function criarRascunho(
  options: {
    organizationId?: string;
    credentialId?: string | null;
    credentialProvider?: string;
    models?: string[] | null;
    model?: string;
    provider?: string;
  } = {},
): Promise<Fixture> {
  const f = await replyFixture(pool);
  await pool.query("update ai_agents set published_version_id=null where id=$1", [f.agent]);
  await pool.query("delete from ai_agent_versions where agent_id=$1", [f.agent]);
  await pool.query("update channel_sessions set status='WORKING' where id=$1", [f.channel]);

  let credential = options.credentialId ?? null;
  if (credential === null && options.credentialId !== null) {
    credential = await criarCredencial(
      options.organizationId ?? f.org,
      options.credentialProvider ?? "openai-assinatura",
      options.models === undefined ? ["gpt-assinatura-a"] : options.models,
    );
  }

  const provider = options.provider ?? "openai-assinatura";
  const draft = randomUUID();
  await pool.query(
    `insert into ai_agent_versions
       (id,organization_id,agent_id,version_number,system_prompt,provider,model,
        credential_id,channel_session_id,status)
     values ($1,$2,$3,1,'Atenda com informações confirmadas.',
             $4,$5,$6,$7,'draft')`,
    [draft, f.org, f.agent, provider, options.model ?? "gpt-assinatura-a", credential, f.channel],
  );
  return { ...f, draft, credential };
}

async function publicar(f: Fixture, platformCredentialVerified = false) {
  return pool.query(
    "select * from fn_publish_ai_agent_version($1,$2,$3,$4)",
    [f.org, f.agent, f.draft, platformCredentialVerified],
  );
}

async function ponteiroPublicado(agentId: string): Promise<string | null> {
  const { rows } = await pool.query("select published_version_id from ai_agents where id=$1", [agentId]);
  return rows[0]?.published_version_id ?? null;
}

it("ORG_A publica somente o modelo exato presente na credencial SIWC da própria organização", async () => {
  const f = await criarRascunho();
  const result = await publicar(f);
  expect(result.rows[0]?.version_id).toBe(f.draft);
  expect(await ponteiroPublicado(f.agent)).toBe(f.draft);
});

it("a versão publicada alimenta o preview canônico com OAuth e Responses API sintéticos", async () => {
  const model = "gpt-p0-1e-published-preview";
  const f = await criarRascunho({ models: [model], model });
  const publishResult = await publicar(f);
  expect(publishResult.rows[0]?.version_id).toBe(f.draft);

  const { rows } = await pool.query<{
    provider: string;
    model: string;
    credential_id: string;
    status: string;
  }>(
    `select provider, model, credential_id, status
       from ai_agent_versions
      where id=$1 and organization_id=$2`,
    [f.draft, f.org],
  );
  const published = rows[0];
  expect(published).toMatchObject({
    provider: "openai-assinatura",
    model,
    credential_id: f.credential,
    status: "published",
  });

  runtimeMocks.accessToken.mockResolvedValue({
    ok: true,
    accessToken: `oauth-synthetic-${f.org}`,
    credentialId: f.credential,
    subject: `sub-synthetic-${f.org}`,
    scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
    modelsAvailable: [model],
  });

  const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  const event = (value: Record<string, unknown>) => `data: ${JSON.stringify(value)}\n\n`;
  const sse = [
    event({ type: "response.created", response: { id: "resp-p0-1e", created_at: 1_793_433_600, model } }),
    event({ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "item-p0-1e" } }),
    event({ type: "response.output_text.delta", item_id: "item-p0-1e", output_index: 0, delta: "Resposta publicada sintética" }),
    event({ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "item-p0-1e" } }),
    event({ type: "response.completed", response: { id: "resp-p0-1e", status: "completed", usage: { input_tokens: 9, output_tokens: 4 } } }),
  ].join("");
  vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    requests.push({
      url,
      headers: new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined)),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
    });
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  }));

  const inserts: unknown[][] = [];
  const runtimeDb = {
    query: vi.fn(async (sql: string, _params: unknown[] = []) => {
      if (sql.includes("settings->'llm'")) {
        return { rows: [{ llm: { provider: "anthropic", default_model: null, params: {}, enabled_models: [] }, teto: null, modo: "off", efetivo_em: null, limiar_pct: 80 }] };
      }
      if (sql.includes("from ai_purpose_bindings")) return { rows: [] };
      if (sql.toLowerCase().includes("insert into llm_calls")) {
        inserts.push(_params);
        return { rows: [{ id: "llm-call-p0-1e-synthetic" }] };
      }
      if (sql.includes("ai_models")) throw new Error("subscription_preview_must_not_read_global_catalog");
      return { rows: [] };
    }),
  };

  try {
    const runtime = await runModelCall(
      runtimeDb as never,
      { openaiApiKey: "sk-synthetic-paid-key-must-not-be-used", anthropicApiKey: "sk-synthetic", cacheTtl: "1h", budgetEnforcement: "off" },
      {
        tenantId: f.org,
        purpose: "agent_preview",
        model: published!.model,
        messages: [{ role: "user", content: "Faça um resumo sintético." }],
        llmOverride: { provider: published!.provider, credentialId: published!.credential_id },
      },
    );

    expect(runtimeMocks.accessToken).toHaveBeenCalledWith({ organizationId: f.org });
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.openai.com/v1/responses");
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer oauth-synthetic-${f.org}`);
    expect(requests[0]?.body).toMatchObject({ model, stream: true, store: false });
    expect(JSON.stringify(requests[0]?.body)).not.toContain("sk-synthetic-paid-key");
    expect(runtime.provider).toBe("openai-assinatura");
    expect(runtime.model).toBe(model);
    expect(runtime.result.text).toBe("Resposta publicada sintética");
    expect(inserts).toHaveLength(1);
    expect(inserts[0]).toContain("openai-assinatura");
    expect(inserts[0]).toContain(model);
    expect(inserts[0]).not.toContain(`oauth-synthetic-${f.org}`);
  } finally {
    vi.unstubAllGlobals();
  }
});

it.each([
  ["modelo fora da lista", ["gpt-outra-conta"], "gpt-assinatura-a"],
  ["lista nula", null, "gpt-assinatura-a"],
  ["lista vazia", [], "gpt-assinatura-a"],
  ["modelo vazio", [""], ""],
  ["modelo com caixa diferente", ["gpt-assinatura-a"], "GPT-ASSINATURA-A"],
])("recusa %s sem publicar a versão", async (_caso, models, model) => {
  const f = await criarRascunho({ models, model });
  await expect(publicar(f)).rejects.toThrow("model_not_found");
  expect(await ponteiroPublicado(f.agent)).toBeNull();
});

it("credential_id nulo não usa a credencial de plataforma para assinatura", async () => {
  const f = await criarRascunho({ credentialId: null });
  await expect(publicar(f, true)).rejects.toThrow("credential_missing");
  expect(await ponteiroPublicado(f.agent)).toBeNull();
});

it.each(["openai", "custom"])("recusa credencial provider=%s", async (provider) => {
  const f = await criarRascunho({ credentialProvider: provider, models: ["gpt-assinatura-a"] });
  await expect(publicar(f)).rejects.toThrow("credential_provider_mismatch");
  expect(await ponteiroPublicado(f.agent)).toBeNull();
});

it("ORG_A não publica com credential_id nem models_available da ORG_B", async () => {
  const orgB = await replyFixture(pool);
  const credentialB = await criarCredencial(orgB.org, "openai-assinatura", ["gpt-so-da-org-b"]);
  const f = await criarRascunho({
    credentialId: credentialB,
    organizationId: orgB.org,
    model: "gpt-so-da-org-b",
  });

  await expect(publicar(f)).rejects.toThrow("credential_not_found");
  expect(await ponteiroPublicado(f.agent)).toBeNull();
});

it("modelo global da OpenAI API não autoriza o provider de assinatura", async () => {
  const model = `model-only-openai-${randomUUID()}`;
  await pool.query(
    `insert into ai_models(provider,model_id,display_name)
     values ('openai',$1,'Modelo sintético OpenAI API')`,
    [model],
  );
  const f = await criarRascunho({ models: [] , model });

  await expect(publicar(f)).rejects.toThrow("model_not_found");
  expect(await ponteiroPublicado(f.agent)).toBeNull();
});

it("openai continua publicando pelo catálogo global com sua própria credencial", async () => {
  const model = `model-openai-api-${randomUUID()}`;
  await pool.query(
    `insert into ai_models(provider,model_id,display_name)
     values ('openai',$1,'Modelo sintético OpenAI API')`,
    [model],
  );
  const f = await criarRascunho({
    provider: "openai",
    credentialProvider: "openai",
    models: [],
    model,
  });

  const result = await publicar(f);
  expect(result.rows[0]?.version_id).toBe(f.draft);
  expect(await ponteiroPublicado(f.agent)).toBe(f.draft);
});

it("preserva os grants service_role-only da função canônica", async () => {
  const { rows } = await pool.query(
    `select has_function_privilege('anon', 'public.fn_publish_ai_agent_version(uuid,uuid,uuid,boolean,text)', 'EXECUTE') as anon_can,
            has_function_privilege('authenticated', 'public.fn_publish_ai_agent_version(uuid,uuid,uuid,boolean,text)', 'EXECUTE') as authenticated_can,
            has_function_privilege('service_role', 'public.fn_publish_ai_agent_version(uuid,uuid,uuid,boolean,text)', 'EXECUTE') as service_role_can`,
  );
  expect(rows[0]).toEqual({ anon_can: false, authenticated_can: false, service_role_can: true });
});

it("a asserção de tenant reprova sob sabotagem que remove o filtro organization_id", async () => {
  const orgB = await replyFixture(pool);
  const credentialB = await criarCredencial(orgB.org, "openai-assinatura", ["gpt-so-da-org-b"]);
  const f = await criarRascunho({
    credentialId: credentialB,
    organizationId: orgB.org,
    model: "gpt-so-da-org-b",
  });
  const client = await pool.connect();
  try {
    await client.query("begin");
    const { rows } = await client.query<{ definition: string }>(
      `select pg_get_functiondef(
         'public.fn_publish_ai_agent_version(uuid,uuid,uuid,boolean,text)'::regprocedure
       ) as definition`,
    );
    const predicate = /\s+and\s+c\.organization_id\s*=\s*p_org_id(?=;)/i;
    expect(rows[0]?.definition).toMatch(predicate);
    const sabotagedDefinition = rows[0]!.definition.replace(predicate, "");
    expect(sabotagedDefinition).not.toBe(rows[0]!.definition);

    await client.query(sabotagedDefinition);
    const published = await client.query(
      "select * from fn_publish_ai_agent_version($1,$2,$3,false)",
      [f.org, f.agent, f.draft],
    );
    expect(published.rows[0]?.version_id).toBe(f.draft);
    await client.query("rollback");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
});
