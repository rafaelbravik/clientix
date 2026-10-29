import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type * as SocialClient from "./client";

const h = vi.hoisted(() => ({ socialRequest: vi.fn() }));

vi.mock("@/lib/webhooks/secrets", () => ({
  decryptWebhookSecret: vi.fn(async () => "provider-key"),
  encryptWebhookSecret: vi.fn(async () => "encrypted"),
}));
vi.mock("./client", async (importOriginal) => ({
  ...(await importOriginal<typeof SocialClient>()),
  socialRequest: h.socialRequest,
}));

import { SocialError } from "./client";
import { resyncSocialWebhook } from "./store";

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const ACCOUNT = "a".repeat(24);
const TOKEN = "b".repeat(48);
const PATH = "/api/v1/webhooks/channel/" + TOKEN;
const CURRENT_BASE = "https://new.example.test";
const OLD_BASE = "https://old.example.test";

type RemoteWebhook = {
  _id: string;
  url: string;
  isActive: boolean;
  name: string;
  secret: string;
  events: string[];
};

function makeDb(options?: {
  row?: Record<string, unknown> | null;
  organizationId?: string;
  provider?: string;
  accountId?: string;
  archivedAt?: string | null;
  integration?: Record<string, unknown> | null;
}) {
  const selects: { table: string; filters: Record<string, unknown> }[] = [];
  const writes: unknown[] = [];
  const db = {
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder = {
        select: vi.fn(() => builder),
        eq: vi.fn((key: string, value: unknown) => {
          filters[key] = value;
          return builder;
        }),
        is: vi.fn((key: string, value: unknown) => {
          filters[key] = value;
          return builder;
        }),
        maybeSingle: vi.fn(async () => {
          selects.push({ table, filters: { ...filters } });
          if (table === "channel_integrations") {
            return {
              data:
                options?.integration === undefined
                  ? { profile_id: "p", credential_encrypted: "cipher" }
                  : options.integration,
              error: null,
            };
          }
          const row = options?.row === undefined ? sessionRow() : options.row;
          const matches =
            row &&
            filters.organization_id === (options?.organizationId ?? ORG) &&
            filters.provider === (options?.provider ?? "zernio_social") &&
            filters.zernio_account_id === (options?.accountId ?? ACCOUNT) &&
            filters.archived_at === (options?.archivedAt ?? null);
          return { data: matches ? row : null, error: null };
        }),
        update: vi.fn((patch: unknown) => {
          writes.push(patch);
          return builder;
        }),
      };
      return builder;
    },
  };
  return { db: db as unknown as SupabaseClient, selects, writes };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "session-1",
    provider: "zernio_social",
    zernio_account_id: ACCOUNT,
    status: "WORKING",
    metadata: { social_platform: "instagram", social_webhook_id: "webhook-1" },
    webhook_path_token: TOKEN,
    archived_at: null,
    ...overrides,
  };
}

function remote(overrides: Partial<RemoteWebhook> = {}): RemoteWebhook {
  return {
    _id: "webhook-1",
    url: OLD_BASE + PATH,
    isActive: true,
    name: "Clientix social callback",
    secret: "provider-secret-never-returned",
    events: ["message.received", "message.sent"],
    ...overrides,
  };
}

let webhooks: RemoteWebhook[];
let providerCalls: { key: string; path: string; body?: unknown; method?: string }[];

function mockProvider(options?: { failPut?: boolean; ignorePut?: boolean; failList?: boolean }) {
  h.socialRequest.mockImplementation(async (key, path, body, method) => {
    providerCalls.push({ key, path, body, method });
    if (options?.failList && method === undefined)
      throw new SocialError("O provedor não concluiu a operação (HTTP 503).", 502);
    if (method === "PUT") {
      if (options?.failPut)
        throw new SocialError("O provedor não concluiu a operação (HTTP 503).", 502);
      if (!options?.ignorePut) {
        const patch = body as { webhookId: string; url: string; isActive: boolean };
        const target = webhooks.find((item) => item._id === patch.webhookId);
        if (target) {
          target.url = patch.url;
          target.isActive = patch.isActive;
        }
      }
      return {};
    }
    return { webhooks: webhooks.map((item) => ({ ...item, events: [...item.events] })) };
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  webhooks = [remote()];
  providerCalls = [];
  mockProvider();
});

describe("resyncSocialWebhook", () => {
  it("atualiza in-place, preserva caminho/ID e não grava channel_sessions", async () => {
    const { db, selects, writes } = makeDb();
    const result = await resyncSocialWebhook(db, ORG, ACCOUNT, CURRENT_BASE);

    expect(result).toEqual({ channel_id: "session-1", resynced: true });
    expect(providerCalls.filter((call) => call.method === "PUT")).toEqual([
      {
        key: "provider-key",
        path: "webhooks/settings",
        body: { webhookId: "webhook-1", url: CURRENT_BASE + PATH, isActive: true },
        method: "PUT",
      },
    ]);
    expect(webhooks[0]).toEqual({
      _id: "webhook-1",
      url: CURRENT_BASE + PATH,
      isActive: true,
      name: "Clientix social callback",
      secret: "provider-secret-never-returned",
      events: ["message.received", "message.sent"],
    });
    expect(writes).toEqual([]);
    expect(selects).toContainEqual({
      table: "channel_sessions",
      filters: {
        organization_id: ORG,
        provider: "zernio_social",
        zernio_account_id: ACCOUNT,
        archived_at: null,
      },
    });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(result)).not.toContain("provider-secret");
  });

  it("retorna NO_CHANGE sem PUT quando o callback já está atual", async () => {
    webhooks = [remote({ url: CURRENT_BASE + PATH })];
    const { db, writes } = makeDb();
    await expect(resyncSocialWebhook(db, ORG, ACCOUNT, CURRENT_BASE)).resolves.toEqual({
      channel_id: "session-1",
      resynced: false,
    });
    expect(providerCalls.filter((call) => call.method === "PUT")).toHaveLength(0);
    expect(writes).toEqual([]);
  });

  it("converge em chamadas repetidas e concorrentes sem criar webhook", async () => {
    const { db, writes } = makeDb();
    const results = await Promise.all([
      resyncSocialWebhook(db, ORG, ACCOUNT, CURRENT_BASE),
      resyncSocialWebhook(db, ORG, ACCOUNT, CURRENT_BASE),
    ]);
    expect(results.every((item) => item.resynced)).toBe(true);
    expect(webhooks).toHaveLength(1);
    expect(webhooks[0]?._id).toBe("webhook-1");
    expect(webhooks[0]?.url).toBe(CURRENT_BASE + PATH);
    expect(providerCalls.filter((call) => call.method === "PUT").length).toBeLessThanOrEqual(2);
    expect(writes).toEqual([]);
    await expect(resyncSocialWebhook(db, ORG, ACCOUNT, CURRENT_BASE)).resolves.toMatchObject({
      resynced: false,
    });
  });

  it("recusa assinatura que não corresponda ao ID e ao caminho desta sessão", async () => {
    webhooks = [remote({ _id: "different-webhook" })];
    const { db } = makeDb();
    await expect(resyncSocialWebhook(db, ORG, ACCOUNT, CURRENT_BASE)).rejects.toMatchObject({
      status: 422,
    });
    expect(providerCalls.filter((call) => call.method === "PUT")).toHaveLength(0);

    webhooks = [remote({ url: OLD_BASE + "/api/v1/webhooks/channel/" + "c".repeat(48) })];
    await expect(resyncSocialWebhook(db, ORG, ACCOUNT, CURRENT_BASE)).rejects.toMatchObject({
      status: 422,
    });
  });

  it("falha fechado para sessão ausente, de outro tenant, não social, arquivada ou sem ID", async () => {
    const absent = makeDb({ row: null });
    await expect(resyncSocialWebhook(absent.db, ORG, ACCOUNT, CURRENT_BASE)).rejects.toMatchObject({
      status: 404,
    });

    const otherTenant = makeDb({ organizationId: OTHER_ORG });
    await expect(resyncSocialWebhook(otherTenant.db, ORG, ACCOUNT, CURRENT_BASE)).rejects.toMatchObject({
      status: 404,
    });

    const otherProvider = makeDb({ provider: "meta_cloud" });
    await expect(resyncSocialWebhook(otherProvider.db, ORG, ACCOUNT, CURRENT_BASE)).rejects.toMatchObject({
      status: 404,
    });

    const archived = makeDb({ archivedAt: "2026-10-01T00:00:00.000Z" });
    await expect(resyncSocialWebhook(archived.db, ORG, ACCOUNT, CURRENT_BASE)).rejects.toMatchObject({
      status: 404,
    });

    const missingId = makeDb({ row: sessionRow({ metadata: { social_platform: "instagram" } }) });
    await expect(resyncSocialWebhook(missingId.db, ORG, ACCOUNT, CURRENT_BASE)).rejects.toMatchObject({
      status: 422,
    });
    expect(providerCalls.filter((call) => call.method !== "PUT")).toHaveLength(0);
  });

  it("recusa plataforma sem Inbox, token malformado e origem não HTTPS antes do provider", async () => {
    const unsupported = makeDb({
      row: sessionRow({
        metadata: { social_platform: "linkedin", social_webhook_id: "webhook-1" },
      }),
    });
    await expect(resyncSocialWebhook(unsupported.db, ORG, ACCOUNT, CURRENT_BASE)).rejects.toMatchObject({
      status: 422,
    });

    const badToken = makeDb({ row: sessionRow({ webhook_path_token: "not-a-token" }) });
    await expect(resyncSocialWebhook(badToken.db, ORG, ACCOUNT, CURRENT_BASE)).rejects.toMatchObject({
      status: 422,
    });

    const { db } = makeDb();
    await expect(resyncSocialWebhook(db, ORG, ACCOUNT, "http://crm.example.test")).rejects.toMatchObject({
      status: 422,
    });
    expect(providerCalls).toHaveLength(0);
  });

  it("não reativa assinatura já atual e desativada, mas reativa a URL antiga corrigida", async () => {
    const { db } = makeDb();
    webhooks = [remote({ url: CURRENT_BASE + PATH, isActive: false })];
    await expect(resyncSocialWebhook(db, ORG, ACCOUNT, CURRENT_BASE)).rejects.toMatchObject({
      status: 409,
    });
    expect(providerCalls.filter((call) => call.method === "PUT")).toHaveLength(0);

    webhooks = [remote({ isActive: false })];
    await expect(resyncSocialWebhook(db, ORG, ACCOUNT, CURRENT_BASE)).resolves.toMatchObject({
      resynced: true,
    });
    expect(webhooks[0]?.isActive).toBe(true);
    expect(webhooks[0]?.events).toEqual(["message.received", "message.sent"]);
  });

  it("mantém estado local intacto e não declara sucesso em falha/não confirmação", async () => {
    const { db, writes } = makeDb();
    mockProvider({ failPut: true });
    await expect(resyncSocialWebhook(db, ORG, ACCOUNT, CURRENT_BASE)).rejects.toThrow(
      "O provedor não concluiu a operação (HTTP 503).",
    );
    expect(webhooks[0]?.url).toBe(OLD_BASE + PATH);
    expect(writes).toEqual([]);

    mockProvider({ ignorePut: true });
    await expect(resyncSocialWebhook(db, ORG, ACCOUNT, CURRENT_BASE)).rejects.toThrow(
      "O provedor não confirmou o novo endereço do webhook.",
    );
    expect(writes).toEqual([]);
  });

  it("não devolve detalhe do provider quando a leitura das subscriptions falha", async () => {
    const { db } = makeDb();
    mockProvider({ failList: true });
    await expect(resyncSocialWebhook(db, ORG, ACCOUNT, CURRENT_BASE)).rejects.toThrow(
      "O provedor não concluiu a operação (HTTP 503).",
    );
  });
});
