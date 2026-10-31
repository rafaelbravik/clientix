import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  aesKey: Buffer.alloc(32, 19).toString("base64"),
  moduloLigado: vi.fn(async () => true),
  loggerWarn: vi.fn(),
  createAdminClient: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: { AI_CRED_AES_KEY: mocks.aesKey } }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: mocks.moduloLigado }));
vi.mock("@/lib/logger", () => ({ logger: { warn: mocks.loggerWarn } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));

import {
  apagarCredencialSiwc,
  lerTokensSiwc,
  obterAccessTokenSiwc,
  salvarCredencialSiwc,
  type ChatGPTSubscriptionEnvelope,
} from "./chatgpt-subscription";
import { CHATGPT_SCOPES, CHATGPT_SUBSCRIPTION_LABEL, CHATGPT_SUBSCRIPTION_PROVIDER } from "./chatgpt-siwc";

interface Row extends Record<string, unknown> {
  id: string;
  organization_id: string;
  provider: string;
  label: string;
  api_key_encrypted: string;
  api_key_iv: string;
  api_key_tag: string;
  api_key_last4: string;
  validated_at: string | null;
  is_active: boolean;
  updated_at: string;
}

function bancoFalso(initial: Row[] = []) {
  const rows = [...initial];
  const chamadas: Array<{ table: string; operation: string; filters: Array<[string, unknown]> }> = [];
  let sequence = 0;

  const from = vi.fn((table: string) => {
    let operation = "select";
    let patch: Record<string, unknown> = {};
    let inserted: Record<string, unknown> | null = null;
    const filters: Array<[string, unknown]> = [];
    const call = { table, operation, filters };
    chamadas.push(call);
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => {
        filters.push([column, value]);
        call.filters = filters;
        return builder;
      },
      maybeSingle: async () => {
        call.operation = operation;
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
          Object.assign(found, patch);
          if (!Object.hasOwn(patch, "updated_at")) {
            found.updated_at = new Date(1_900_000_000_000 + sequence).toISOString();
          }
          return { data: { id: found.id, updated_at: found.updated_at }, error: null };
        }
        if (operation === "insert" && inserted) {
          const duplicate = rows.some((row) =>
            row.organization_id === inserted?.organization_id &&
            row.provider === inserted?.provider &&
            row.label === inserted?.label,
          );
          if (duplicate) return { data: null, error: { code: "23505" } };
          sequence += 1;
          const created = {
            ...inserted,
            id: `credential-${sequence}`,
            updated_at: new Date(1_900_000_000_000 + sequence).toISOString(),
          } as Row;
          rows.push(created);
          return { data: { id: created.id }, error: null };
        }
        return { data: null, error: null };
      },
      update: (value: Record<string, unknown>) => {
        operation = "update";
        call.operation = operation;
        patch = value;
        return builder;
      },
      insert: (value: Record<string, unknown>) => {
        operation = "insert";
        call.operation = operation;
        inserted = value;
        return builder;
      },
      delete: () => {
        operation = "delete";
        call.operation = operation;
        return builder;
      },
      then: (resolve: (value: unknown) => unknown, reject?: (error: unknown) => unknown) => {
        call.operation = operation;
        if (operation === "delete") {
          const before = rows.length;
          for (let index = rows.length - 1; index >= 0; index -= 1) {
            if (filters.every(([key, value]) => rows[index]?.[key] === value)) rows.splice(index, 1);
          }
          return Promise.resolve({ data: null, error: null, count: before - rows.length }).then(resolve, reject);
        }
        return Promise.resolve({ data: null, error: null }).then(resolve, reject);
      },
    };
    return builder;
  });

  return { admin: { from } as never, rows, chamadas, from };
}

function envelope(subject: string, expiresAt = Date.now() + 3_600_000): ChatGPTSubscriptionEnvelope {
  return {
    access_token: `synthetic-access-${subject}-0123456789`,
    refresh_token: `synthetic-refresh-${subject}-0123456789`,
    client_id: "issued-client-id",
    subject,
    email: "synthetic@example.invalid",
    scopes: [...CHATGPT_SCOPES],
    expires_at: expiresAt,
    token_type: "Bearer",
    ext_agent_host_id: "urn:uuid:00000000-0000-4000-8000-000000000001",
    issuer: "https://auth.openai.com",
  };
}

describe("ChatGPT subscription credential storage", () => {
  beforeEach(() => {
    mocks.moduloLigado.mockReset();
    mocks.moduloLigado.mockResolvedValue(true);
    mocks.loggerWarn.mockReset();
  });

  it("cifra o envelope, usa o provider reservado e nunca grava fragmento de token em last4", async () => {
    const db = bancoFalso();
    const result = await salvarCredencialSiwc({
      admin: db.admin,
      organizationId: "org-a",
      userId: "user-a",
      envelope: envelope("subject-a"),
    });
    expect(result).toMatchObject({ ok: true, reconnected: false });
    const row = db.rows[0];
    expect(row).toMatchObject({
      organization_id: "org-a",
      provider: CHATGPT_SUBSCRIPTION_PROVIDER,
      label: CHATGPT_SUBSCRIPTION_LABEL,
      api_key_last4: "SIWC",
      is_active: true,
    });
    expect(JSON.stringify(row)).not.toContain("synthetic-access-subject-a");
    expect(JSON.stringify(row)).not.toContain("synthetic-refresh-subject-a");
    expect(await lerTokensSiwc(db.admin, "org-a")).toMatchObject({
      envelope: { access_token: "synthetic-access-subject-a-0123456789", refresh_token: "synthetic-refresh-subject-a-0123456789" },
    });
  });

  it("mantém uma identidade por organização e não permite troca silenciosa de sub", async () => {
    const db = bancoFalso();
    const primeiro = await salvarCredencialSiwc({ admin: db.admin, organizationId: "org-a", userId: "u-a", envelope: envelope("sub-a") });
    expect(primeiro.ok).toBe(true);
    const trocado = await salvarCredencialSiwc({ admin: db.admin, organizationId: "org-a", userId: "u-a", envelope: envelope("sub-b") });
    expect(trocado).toEqual({ ok: false, error: "identity_mismatch" });
    expect(db.rows).toHaveLength(1);
    expect((await lerTokensSiwc(db.admin, "org-a"))?.envelope.subject).toBe("sub-a");
  });

  it("isola A e B: leitura e exclusão de B não alcançam a credencial de A", async () => {
    const db = bancoFalso();
    await salvarCredencialSiwc({ admin: db.admin, organizationId: "org-a", userId: "u-a", envelope: envelope("sub-a") });
    expect(await lerTokensSiwc(db.admin, "org-b")).toBeNull();
    expect(await apagarCredencialSiwc(db.admin, "org-b")).toEqual({ ok: true, id: null });
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0]?.organization_id).toBe("org-a");
    expect(db.chamadas.filter((call) => call.table === "ai_provider_credentials" && call.operation !== "insert").every((call) =>
      call.filters.some(([column]) => column === "organization_id"),
    )).toBe(true);
  });

  it("B não lê nem renova a credencial de A", async () => {
    const db = bancoFalso();
    await salvarCredencialSiwc({ admin: db.admin, organizationId: "org-a", userId: "u-a", envelope: envelope("sub-a", 1) });
    const renovar = vi.fn();
    const result = await obterAccessTokenSiwc({ admin: db.admin, organizationId: "org-b", agora: 2, renovar });
    expect(result).toEqual({ ok: false, error: "not_connected" });
    expect(renovar).not.toHaveBeenCalled();
    expect(db.rows[0]?.organization_id).toBe("org-a");
  });

  it("permite a organização B criar sua própria identidade sem ler ou sobrescrever A", async () => {
    const db = bancoFalso();
    await salvarCredencialSiwc({ admin: db.admin, organizationId: "org-a", userId: "u-a", envelope: envelope("sub-a") });
    await salvarCredencialSiwc({ admin: db.admin, organizationId: "org-b", userId: "u-b", envelope: envelope("sub-b") });
    expect(db.rows).toHaveLength(2);
    expect((await lerTokensSiwc(db.admin, "org-a"))?.envelope.subject).toBe("sub-a");
    expect((await lerTokensSiwc(db.admin, "org-b"))?.envelope.subject).toBe("sub-b");
  });

  it("feature desligada bloqueia uso e não lê storage nem faz refresh", async () => {
    const db = bancoFalso();
    mocks.moduloLigado.mockResolvedValue(false);
    const renovar = vi.fn();
    const result = await obterAccessTokenSiwc({ admin: db.admin, organizationId: "org-a", renovar });
    expect(result).toEqual({ ok: false, error: "feature_disabled" });
    expect(db.from).not.toHaveBeenCalled();
    expect(renovar).not.toHaveBeenCalled();
  });

  it("refresh faz rotação por CAS e requests concorrentes não reutilizam nem sobrescrevem o token", async () => {
    const db = bancoFalso();
    await salvarCredencialSiwc({
      admin: db.admin,
      organizationId: "org-a",
      userId: "u-a",
      envelope: envelope("sub-a", 9_999_999_950),
    });
    const renovar = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
      accessToken: "rotated-access-token-0123456789",
      refreshToken: "rotated-refresh-token-0123456789",
      scopes: [...CHATGPT_SCOPES],
      tokenType: "Bearer",
      expiresAt: 9_999_999_999,
      };
    });
    const [a, b] = await Promise.all([
      obterAccessTokenSiwc({ admin: db.admin, organizationId: "org-a", agora: 9_999_999_960, renovar }),
      obterAccessTokenSiwc({ admin: db.admin, organizationId: "org-a", agora: 9_999_999_960, renovar }),
    ]);
    expect(renovar).toHaveBeenCalledTimes(1);
    expect([a, b].filter((value) => value.ok)).toHaveLength(1);
    expect([a, b].some((value) => !value.ok && value.error === "refresh_in_progress")).toBe(true);
    expect((await lerTokensSiwc(db.admin, "org-a"))?.envelope.refresh_token).toBe("rotated-refresh-token-0123456789");
  });

  it("devolve o catálogo da credencial do tenant junto com sua identidade", async () => {
    const db = bancoFalso();
    await salvarCredencialSiwc({ admin: db.admin, organizationId: "org-a", userId: "u-a", envelope: envelope("sub-a") });
    db.rows[0]!.models_available = ["gpt-org-a"];

    const result = await obterAccessTokenSiwc({ admin: db.admin, organizationId: "org-a" });

    expect(result).toMatchObject({
      ok: true,
      credentialId: "credential-1",
      modelsAvailable: ["gpt-org-a"],
    });
    const read = db.chamadas.find((call) => call.operation === "select");
    expect(read?.filters).toContainEqual(["organization_id", "org-a"]);
    expect(read?.filters).toContainEqual(["provider", CHATGPT_SUBSCRIPTION_PROVIDER]);
  });

  it("refresh forçado após 401 gira o token uma vez e nunca devolve o token rejeitado", async () => {
    const db = bancoFalso();
    await salvarCredencialSiwc({ admin: db.admin, organizationId: "org-a", userId: "u-a", envelope: envelope("sub-a") });
    const renovar = vi.fn(async () => ({
      accessToken: "rotated-access-token-0123456789",
      refreshToken: "rotated-refresh-token-0123456789",
      scopes: [...CHATGPT_SCOPES],
      tokenType: "Bearer",
      expiresAt: Date.now() + 3_600_000,
    }));

    const result = await obterAccessTokenSiwc({
      admin: db.admin,
      organizationId: "org-a",
      forceRefresh: true,
      renovar,
    });

    expect(renovar).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ ok: true, accessToken: "rotated-access-token-0123456789" });
  });

  it("dois refresh forçados concorrentes não reutilizam o token já rejeitado", async () => {
    const db = bancoFalso();
    await salvarCredencialSiwc({ admin: db.admin, organizationId: "org-a", userId: "u-a", envelope: envelope("sub-a") });
    const renovar = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        accessToken: "rotated-access-token-0123456789",
        refreshToken: "rotated-refresh-token-0123456789",
        scopes: [...CHATGPT_SCOPES],
        tokenType: "Bearer",
        expiresAt: Date.now() + 3_600_000,
      };
    });

    const results = await Promise.all([
      obterAccessTokenSiwc({ admin: db.admin, organizationId: "org-a", forceRefresh: true, renovar }),
      obterAccessTokenSiwc({ admin: db.admin, organizationId: "org-a", forceRefresh: true, renovar }),
    ]);

    expect(renovar).toHaveBeenCalledTimes(1);
    expect(results.filter((result) => result.ok)).toHaveLength(1);
    expect(results.some((result) => !result.ok && result.error === "refresh_in_progress")).toBe(true);
    expect(results.filter((result) => result.ok).every((result) => result.accessToken !== envelope("sub-a").access_token)).toBe(true);
  });

  it("reconnect invalida models_available antigo até buscar o catálogo novo", async () => {
    const db = bancoFalso();
    await salvarCredencialSiwc({ admin: db.admin, organizationId: "org-a", userId: "u-a", envelope: envelope("sub-a") });
    db.rows[0]!.models_available = ["gpt-old"];

    const result = await salvarCredencialSiwc({
      admin: db.admin,
      organizationId: "org-a",
      userId: "u-a",
      envelope: envelope("sub-a"),
      expectedSubject: "sub-a",
    });

    expect(result).toMatchObject({ ok: true, reconnected: true });
    expect(db.rows[0]!.models_available).toBeNull();
    expect(await obterAccessTokenSiwc({ admin: db.admin, organizationId: "org-a" })).toMatchObject({
      ok: true,
      modelsAvailable: [],
    });
  });

  it("falha de refresh é tipada e conserva a credencial cifrada", async () => {
    const db = bancoFalso();
    await salvarCredencialSiwc({
      admin: db.admin,
      organizationId: "org-a",
      userId: "u-a",
      envelope: envelope("sub-a", 1),
    });
    const renovar = vi.fn(async () => { throw new Error("secret response body must not escape"); });
    const result = await obterAccessTokenSiwc({ admin: db.admin, organizationId: "org-a", agora: 2, renovar });
    expect(result).toEqual({ ok: false, error: "refresh_failed" });
    expect((await lerTokensSiwc(db.admin, "org-a"))?.envelope.refresh_token).toBe("synthetic-refresh-sub-a-0123456789");
    expect(mocks.loggerWarn).toHaveBeenCalledWith("ChatGPT subscription refresh failed", expect.objectContaining({
      organization_id: "org-a",
      reason: "refresh_failed",
    }));
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain("secret response body");
    expect(JSON.stringify(mocks.loggerWarn.mock.calls)).not.toContain("synthetic-refresh-sub-a");
  });
});
