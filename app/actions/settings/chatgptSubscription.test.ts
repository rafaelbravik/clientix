import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  user: { id: "user-a", idioma: "pt-BR", support: null as unknown },
  activeOrg: { orgId: "org-a", role: "admin" as string },
  featureEnabled: true,
  mfaRequired: false,
  supportDenied: null as unknown,
  cookieValue: null as string | null,
  requestId: "request-fixture",
  from: vi.fn(),
  audit: vi.fn(async () => {}),
  exchange: vi.fn(),
  verifyIdentity: vi.fn(),
  revoke: vi.fn(async () => true),
  platformRows: [] as Array<Record<string, unknown>>,
  credentialRows: [] as Array<Record<string, unknown>>,
  nonceRows: [] as Array<Record<string, unknown>>,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => mocks.cookieValue ? { value: mocks.cookieValue } : undefined,
    set: (_name: string, value: string) => { mocks.cookieValue = value; },
    delete: () => { mocks.cookieValue = null; },
  }),
  headers: async () => ({ get: (key: string) => key === "x-request-id" ? mocks.requestId : null }),
}));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: async () => mocks.user,
  resolveActiveOrg: async () => mocks.activeOrg,
  mfaEmDivida: async () => mocks.mfaRequired,
}));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: () => mocks.supportDenied }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: async () => mocks.featureEnabled }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: mocks.from }) }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "synthetic-internal-secret-with-more-than-thirty-two-bytes" } }));
vi.mock("@/lib/crypto/aes_gcm", () => ({
  encryptKey: (plaintext: string) => ({
    ciphertext: Buffer.from(plaintext, "utf8"),
    iv: Buffer.from("synthetic-iv"),
    tag: Buffer.from("synthetic-tag"),
    last4: "test",
  }),
  decryptKey: ({ ciphertext }: { ciphertext: Buffer }) => ciphertext.toString("utf8"),
  bufToBytea: (value: Buffer) => `\\x${value.toString("hex")}`,
  byteaToBuffer: (value: string) => Buffer.from(value.replace(/^\\x/, ""), "hex"),
}));
vi.mock("@/lib/ai/credenciais/chatgpt-siwc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/credenciais/chatgpt-siwc")>();
  return {
    ...actual,
    trocarCodigoSiwc: (...args: unknown[]) => mocks.exchange(...args),
    verificarIdTokenSiwc: (...args: unknown[]) => mocks.verifyIdentity(...args),
  };
});
vi.mock("@/lib/ai/credenciais/chatgpt-subscription", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/ai/credenciais/chatgpt-subscription")>();
  return {
    ...actual,
    revogarSessaoSiwc: (_envelope: Parameters<typeof actual.revogarSessaoSiwc>[0]) => mocks.revoke(),
  };
});

import {
  completeChatGPTSubscriptionLogin,
  disconnectChatGPTSubscription,
  startChatGPTSubscriptionLogin,
} from "./chatgptSubscription";
import { verificarStateSiwc } from "@/lib/ai/credenciais/chatgpt-siwc";

function fakeDatabase() {
  mocks.from.mockClear();
  mocks.platformRows = [];
  mocks.credentialRows = [];
  mocks.nonceRows = [];
  let sequence = 0;

  mocks.from.mockImplementation((table: string) => {
    let operation = "select";
    let patch: Record<string, unknown> = {};
    let payload: Record<string, unknown> | null = null;
    const filters: Array<[string, unknown]> = [];
    const rows = table === "platform_config"
      ? mocks.platformRows
      : table === "ai_provider_credentials"
        ? mocks.credentialRows
        : table === "calendar_oauth_nonces"
          ? mocks.nonceRows
          : [];
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => { filters.push([column, value]); return builder; },
      maybeSingle: async () => {
        const found = rows.find((row) => filters.every(([key, value]) => row[key] === value));
        if (operation === "select") return { data: found ? structuredClone(found) : null, error: null };
        if (operation === "delete") {
          if (!found) return { data: null, error: null };
          rows.splice(rows.indexOf(found), 1);
          return { data: { id: found.id }, error: null };
        }
        if (operation === "update") {
          if (!found) return { data: null, error: null };
          sequence += 1;
          Object.assign(found, patch, { updated_at: new Date(2_000_000_000_000 + sequence).toISOString() });
          return { data: { id: found.id }, error: null };
        }
        if (operation === "insert" && payload) {
          if (
            (table === "calendar_oauth_nonces" && rows.some((row) => row.nonce === payload?.nonce)) ||
            (table === "ai_provider_credentials" && rows.some((row) =>
              row.organization_id === payload?.organization_id && row.provider === payload?.provider && row.label === payload?.label,
            ))
          ) return { data: null, error: { code: "23505" } };
          sequence += 1;
          const created = {
            ...payload,
            id: `fixture-${table}-${sequence}`,
            updated_at: new Date(2_000_000_000_000 + sequence).toISOString(),
            ...(table === "ai_provider_credentials" ? { validated_at: new Date().toISOString(), is_active: true } : {}),
          };
          rows.push(created);
          return { data: { id: created.id }, error: null };
        }
        return { data: null, error: null };
      },
      insert: (value: Record<string, unknown>) => { operation = "insert"; payload = value; return builder; },
      update: (value: Record<string, unknown>) => { operation = "update"; patch = value; return builder; },
      delete: () => { operation = "delete"; return builder; },
      then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => {
        if (operation === "insert" && payload) {
          if (table === "calendar_oauth_nonces" && rows.some((row) => row.nonce === payload?.nonce)) {
            return Promise.resolve({ data: null, error: { code: "23505" } }).then(resolve, reject);
          }
          if (
            table === "ai_provider_credentials" &&
            rows.some((row) => row.organization_id === payload?.organization_id && row.provider === payload?.provider && row.label === payload?.label)
          ) {
            return Promise.resolve({ data: null, error: { code: "23505" } }).then(resolve, reject);
          }
          sequence += 1;
          const created = {
            ...payload,
            id: `fixture-${table}-${sequence}`,
            updated_at: new Date(2_000_000_000_000 + sequence).toISOString(),
            ...(table === "ai_provider_credentials" ? { validated_at: new Date().toISOString(), is_active: true } : {}),
          };
          rows.push(created);
          return Promise.resolve({ data: created, error: null }).then(resolve, reject);
        }
        if (operation === "delete") {
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            if (filters.every(([key, value]) => rows[index]?.[key] === value)) rows.splice(index, 1);
          }
          return Promise.resolve({ data: null, error: null }).then(resolve, reject);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  });
}

function callbackUrl(authorizationUrl: string, code = "authorization-code-fixture") {
  const auth = new URL(authorizationUrl);
  const callback = new URL("http://127.0.0.1:1455/auth/callback");
  callback.searchParams.set("code", code);
  callback.searchParams.set("state", auth.searchParams.get("state") ?? "");
  callback.searchParams.set("client_id", "issued-client-id");
  return callback.toString();
}

describe("ChatGPT subscription server actions", () => {
  beforeEach(() => {
    mocks.user = { id: "user-a", idioma: "pt-BR", support: null };
    mocks.activeOrg = { orgId: "org-a", role: "admin" };
    mocks.featureEnabled = true;
    mocks.mfaRequired = false;
    mocks.supportDenied = null;
    mocks.cookieValue = null;
    mocks.requestId = "request-fixture";
    mocks.audit.mockClear();
    mocks.exchange.mockReset();
    mocks.verifyIdentity.mockReset();
    mocks.revoke.mockReset();
    mocks.revoke.mockResolvedValue(true);
    mocks.exchange.mockResolvedValue({
      accessToken: "synthetic-access-token-0123456789",
      refreshToken: "synthetic-refresh-token-0123456789",
      idToken: "synthetic-id-token-0123456789",
      tokenType: "Bearer",
      scopes: ["resource.invoke", "chatgpt.tokens.use.direct"],
      expiresAt: Date.now() + 3_600_000,
    });
    mocks.verifyIdentity.mockResolvedValue({ subject: "siwc-subject-a", email: "synthetic@example.invalid" });
    fakeDatabase();
  });

  it("feature off bloqueia início e conclusão sem consulta de nonce nem chamada SIWC", async () => {
    mocks.featureEnabled = false;
    expect(await startChatGPTSubscriptionLogin()).toEqual({ ok: false, error: "feature_disabled" });
    expect(await completeChatGPTSubscriptionLogin({ callbackUrl: "http://127.0.0.1:1455/auth/callback?code=x&state=y" })).toEqual({ ok: false, error: "feature_disabled" });
    expect(mocks.from).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("exige admin e MFA em dia antes de ler configuração ou iniciar autorização", async () => {
    mocks.activeOrg = { orgId: "org-a", role: "manager" };
    expect(await startChatGPTSubscriptionLogin()).toEqual({ ok: false, error: "permission_denied" });
    expect(mocks.from).not.toHaveBeenCalled();

    mocks.activeOrg = { orgId: "org-a", role: "admin" };
    mocks.mfaRequired = true;
    expect(await startChatGPTSubscriptionLogin()).toEqual({ ok: false, error: "mfa_required" });
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it("state e autorização usam a organização ativa da sessão, não input do cliente", async () => {
    const started = await startChatGPTSubscriptionLogin();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const authorization = new URL(started.authorizationUrl);
    const state = verificarStateSiwc(authorization.searchParams.get("state") ?? "", "synthetic-internal-secret-with-more-than-thirty-two-bytes");
    expect(state).toMatchObject({
      ok: true,
      state: { organizationId: "org-a", userId: "user-a", clientId: "dynamic_agent_client" },
    });
    expect(authorization.searchParams.get("client_id")).toBe("dynamic_agent_client");
    expect(mocks.cookieValue).toBeTruthy();
  });

  it("conclui SIWC no servidor e grava somente na organização ativa mesmo com organization_id forjado", async () => {
    const started = await startChatGPTSubscriptionLogin();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const callback = callbackUrl(started.authorizationUrl);
    const result = await completeChatGPTSubscriptionLogin({ callbackUrl: callback, organization_id: "org-b" } as never);
    expect(result).toEqual({ ok: true, reconnected: false });
    expect(mocks.exchange).toHaveBeenCalledWith(expect.objectContaining({
      code: "authorization-code-fixture",
      clientId: "issued-client-id",
    }));
    expect(mocks.verifyIdentity).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "issued-client-id",
      nonce: expect.any(String),
    }));
    expect(mocks.credentialRows).toHaveLength(1);
    expect(mocks.credentialRows[0]).toMatchObject({ organization_id: "org-a", provider: "openai-assinatura" });
    expect(mocks.nonceRows).toHaveLength(1);
    expect(mocks.nonceRows[0]).toMatchObject({ organization_id: "org-a", user_id: "user-a" });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "ai.subscription.connected",
      organizationId: "org-a",
      requestId: "request-fixture",
    }));
    const auditPayload = JSON.stringify(mocks.audit.mock.calls);
    for (const segredo of [
      "authorization-code-fixture",
      "synthetic-access-token",
      "synthetic-refresh-token",
      "synthetic-id-token",
    ]) expect(auditPayload).not.toContain(segredo);
  });

  it("troca de usuário ou organização entre start e callback invalida state antes da troca de código", async () => {
    const started = await startChatGPTSubscriptionLogin();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    mocks.activeOrg = { orgId: "org-b", role: "admin" };
    const result = await completeChatGPTSubscriptionLogin({ callbackUrl: callbackUrl(started.authorizationUrl) });
    expect(result).toEqual({ ok: false, error: "invalid_state" });
    expect(mocks.nonceRows).toHaveLength(0);
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("callback e nonce são single-use; replay não troca outro código", async () => {
    const started = await startChatGPTSubscriptionLogin();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    const callback = callbackUrl(started.authorizationUrl);
    expect(await completeChatGPTSubscriptionLogin({ callbackUrl: callback })).toEqual({ ok: true, reconnected: false });
    expect(await completeChatGPTSubscriptionLogin({ callbackUrl: callback })).toEqual({ ok: false, error: "invalid_state" });
    expect(mocks.exchange).toHaveBeenCalledTimes(1);
    expect(mocks.nonceRows).toHaveLength(1);
  });

  it("duas conclusões concorrentes do mesmo state só consomem uma vez e não auditam verifier", async () => {
    const started = await startChatGPTSubscriptionLogin();
    expect(started.ok).toBe(true);
    if (!started.ok || !mocks.cookieValue) return;
    const cookieCiphertext = mocks.cookieValue.split(".")[0];
    const pending = JSON.parse(Buffer.from(cookieCiphertext ?? "", "base64url").toString("utf8")) as { verifier: string };
    const callback = callbackUrl(started.authorizationUrl);
    const [first, second] = await Promise.all([
      completeChatGPTSubscriptionLogin({ callbackUrl: callback }),
      completeChatGPTSubscriptionLogin({ callbackUrl: callback }),
    ]);
    expect([first, second]).toEqual(expect.arrayContaining([
      { ok: true, reconnected: false },
      { ok: false, error: "replayed_nonce" },
    ]));
    expect(mocks.exchange).toHaveBeenCalledTimes(1);
    expect(mocks.nonceRows).toHaveLength(1);
    expect(JSON.stringify(mocks.audit.mock.calls)).not.toContain(pending.verifier);
  });

  it("identidade diferente na reconexão é recusada sem sobrescrever a conta atual", async () => {
    const first = await startChatGPTSubscriptionLogin();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(await completeChatGPTSubscriptionLogin({ callbackUrl: callbackUrl(first.authorizationUrl) })).toEqual({ ok: true, reconnected: false });
    const storedBefore = structuredClone(mocks.credentialRows[0]);

    const reconnect = await startChatGPTSubscriptionLogin();
    expect(reconnect.ok).toBe(true);
    if (!reconnect.ok) return;
    mocks.verifyIdentity.mockResolvedValueOnce({ subject: "different-subject" });
    const result = await completeChatGPTSubscriptionLogin({ callbackUrl: callbackUrl(reconnect.authorizationUrl) });
    expect(result).toEqual({ ok: false, error: "identity_mismatch" });
    expect(mocks.credentialRows[0]).toEqual(storedBefore);
  });

  it("disconnect remove o envelope local mesmo quando revogação remota não é confirmada", async () => {
    const started = await startChatGPTSubscriptionLogin();
    expect(started.ok).toBe(true);
    if (!started.ok) return;
    await completeChatGPTSubscriptionLogin({ callbackUrl: callbackUrl(started.authorizationUrl) });
    mocks.revoke.mockResolvedValueOnce(false);
    const result = await disconnectChatGPTSubscription();
    expect(result).toEqual({ ok: true, remoteRevocation: "not_confirmed" });
    expect(mocks.credentialRows).toHaveLength(0);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "ai.subscription.disconnected",
      metadata: expect.objectContaining({ status: "remote_revocation_not_confirmed" }),
    }));
    const auditPayload = JSON.stringify(mocks.audit.mock.calls);
    expect(auditPayload).not.toContain("synthetic-access-token");
    expect(auditPayload).not.toContain("synthetic-refresh-token");
  });
});
