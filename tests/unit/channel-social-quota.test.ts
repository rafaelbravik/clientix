import { describe, expect, it, vi, beforeEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { connectSocialInbox } from "@/lib/channels/social/store";
import { SocialError } from "@/lib/channels/social/client";
import type * as SocialClientModule from "@/lib/channels/social/client";

// Mocks dos módulos externos
vi.mock("@/lib/channels/social/client", async (importOriginal) => {
  const actual = await importOriginal<typeof SocialClientModule>();
  return {
    ...actual,
    listSocialAccounts: vi.fn(),
    socialRequest: vi.fn(),
  };
});

import { listSocialAccounts, socialRequest } from "@/lib/channels/social/client";

interface MockChannelSessionRow {
  id: string;
  organization_id: string;
  provider: string;
  zernio_account_id: string;
  display_name: string;
  status: string;
  metadata: Record<string, unknown>;
  updated_at: string;
  archived_at: string | null;
  webhook_path_token?: string;
  webhook_secret_encrypted?: string;
}

describe("SEC-002: Entitlement e Quota de Canais Sociais (connectSocialInbox)", () => {
  const orgA = "11111111-1111-4111-8111-111111111111";
  const orgB = "22222222-2222-4222-8222-222222222222";
  const accountIdInstagram = "60c72b2f9b1d8b001f8e4a01";
  const accountIdFacebook = "60c72b2f9b1d8b001f8e4a02";

  let insertedSessions: Record<string, unknown>[];
  let updatedSessions: Record<string, unknown>[];
  let organizationsStore: Record<string, { settings: Record<string, unknown> }>;
  let channelSessionsStore: MockChannelSessionRow[];

  function createMockDb(options?: { throwOnOrganizations?: boolean }): SupabaseClient {
    return {
      rpc: vi.fn(async (name: string) => {
        if (name === "fn_decrypt_oauth") return { data: "mock-decrypted-key", error: null };
        if (name === "fn_encrypt_oauth") return { data: "mock-encrypted-val", error: null };
        return { data: null, error: null };
      }),
      from: vi.fn((table: string) => {
        if (table === "organizations" && options?.throwOnOrganizations) {
          throw new Error("Unexpected crash during quota check");
        }
        if (table === "channel_integrations") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn(async () => ({
              data: { profile_id: "profile-1", credential_encrypted: "\\xencrypted-key" },
              error: null,
            })),
          };
        }

        if (table === "organizations") {
          let selectedOrgId: string | null = null;
          let shouldSimulateError = false;

          const orgBuilder = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn((col: string, val: string) => {
              if (col === "id") selectedOrgId = val;
              if (val === "error-org-id") shouldSimulateError = true;
              return orgBuilder;
            }),
            single: vi.fn(async () => {
              if (shouldSimulateError) {
                return { data: null, error: { message: "Simulated DB error in organizations" } };
              }
              const orgData = selectedOrgId ? organizationsStore[selectedOrgId] : null;
              return { data: orgData ?? null, error: null };
            }),
            maybeSingle: vi.fn(async () => {
              if (shouldSimulateError) {
                return { data: null, error: { message: "Simulated DB error in organizations" } };
              }
              const orgData = selectedOrgId ? organizationsStore[selectedOrgId] : null;
              return { data: orgData ?? null, error: null };
            }),
          };
          return orgBuilder;
        }

        if (table === "channel_sessions") {
          const filters: {
            orgId?: string;
            provider?: string;
            archivedNull?: boolean;
            excludeId?: string;
            id?: string;
          } = {};

          let isCountExact = false;

          const sessionBuilder = {
            select: vi.fn((_cols?: string, opts?: { count?: string; head?: boolean }) => {
              if (opts?.count === "exact") isCountExact = true;
              return sessionBuilder;
            }),
            insert: vi.fn((row: Record<string, unknown>) => {
              const newRow: MockChannelSessionRow = {
                id: (row.id as string) ?? `session-${Date.now()}-${Math.random()}`,
                organization_id: (row.organization_id as string) ?? "",
                provider: (row.provider as string) ?? "",
                zernio_account_id: (row.zernio_account_id as string) ?? "",
                display_name: (row.display_name as string) ?? "",
                status: (row.status as string) ?? "STARTING",
                metadata: (row.metadata as Record<string, unknown>) ?? {},
                archived_at: null,
                updated_at: new Date().toISOString(),
                webhook_path_token: row.webhook_path_token as string | undefined,
                webhook_secret_encrypted: row.webhook_secret_encrypted as string | undefined,
              };
              insertedSessions.push(row);
              channelSessionsStore.push(newRow);
              return {
                select: vi.fn().mockReturnValue({
                  single: vi.fn(async () => ({ data: { id: newRow.id }, error: null })),
                }),
              };
            }),
            update: vi.fn((row: Record<string, unknown>) => {
              updatedSessions.push(row);
              return sessionBuilder;
            }),
            eq: vi.fn((col: string, val: string) => {
              if (col === "organization_id") filters.orgId = val;
              if (col === "provider") filters.provider = val;
              if (col === "id") filters.id = val;
              return sessionBuilder;
            }),
            is: vi.fn((col: string, val: unknown) => {
              if (col === "archived_at" && val === null) filters.archivedNull = true;
              return sessionBuilder;
            }),
            neq: vi.fn((col: string, val: string) => {
              if (col === "id") filters.excludeId = val;
              return sessionBuilder;
            }),
            maybeSingle: vi.fn(async () => {
              const match = channelSessionsStore.find((s) => {
                if (filters.orgId && s.organization_id !== filters.orgId) return false;
                if (filters.id && s.id !== filters.id) return false;
                return true;
              });
              return { data: match ?? null, error: null };
            }),
            single: vi.fn(async () => {
              const match = channelSessionsStore.find((s) => {
                if (filters.orgId && s.organization_id !== filters.orgId) return false;
                if (filters.id && s.id !== filters.id) return false;
                return true;
              });
              return { data: match ?? null, error: null };
            }),
            then: vi.fn((resolve: (val: unknown) => unknown) => {
              if (isCountExact) {
                const matching = channelSessionsStore.filter((s) => {
                  if (filters.orgId && s.organization_id !== filters.orgId) return false;
                  if (filters.archivedNull && s.archived_at !== null) return false;
                  if (filters.excludeId && s.id === filters.excludeId) return false;
                  return true;
                });
                return resolve({ count: matching.length, error: null });
              }

              const matching = channelSessionsStore.filter((s) => {
                if (filters.orgId && s.organization_id !== filters.orgId) return false;
                if (filters.provider && s.provider !== filters.provider) return false;
                if (filters.archivedNull && s.archived_at !== null) return false;
                return true;
              });
              return resolve({ data: matching, error: null });
            }),
          };
          return sessionBuilder;
        }

        return {} as unknown;
      }),
    } as unknown as SupabaseClient;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    insertedSessions = [];
    updatedSessions = [];
    channelSessionsStore = [];

    // Base mock de contas sociais retornadas pelo parceiro
    vi.mocked(listSocialAccounts).mockResolvedValue([
      {
        _id: accountIdInstagram,
        platform: "instagram",
        username: "insta_brand",
        isActive: true,
        profileId: "profile-1",
      },
      {
        _id: accountIdFacebook,
        platform: "facebook",
        username: "fb_brand",
        isActive: true,
        profileId: "profile-1",
      },
    ]);

    // Mock das chamadas de webhook do Zernio
    vi.mocked(socialRequest).mockImplementation(async (_key, path, _body) => {
      if (path === "webhooks/settings") {
        return {
          webhooks: [],
          webhook: { _id: "wh_12345678" },
        };
      }
      return {};
    });

    // Estado padrão das organizações
    organizationsStore = {
      [orgA]: {
        settings: {
          plan: "standard",
        },
      },
      [orgB]: {
        settings: {
          plan: "pro",
        },
      },
    };
  });

  // 1. Standard + Instagram -> 403, 0 inserts, 0 webhooks
  it("1. Bloqueia conexão de Instagram para organização no plano Standard (403, zero inserts e zero webhooks)", async () => {
    const db = createMockDb();
    organizationsStore[orgA] = { settings: { plan: "standard" } };

    let caughtError: unknown = null;
    try {
      await connectSocialInbox(db, orgA, accountIdInstagram, "https://crm.exemplo.com");
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(SocialError);
    if (caughtError instanceof SocialError) {
      expect(caughtError.status).toBe(403);
      expect(caughtError.message).toContain("não está disponível no plano STANDARD");
    }
    expect(insertedSessions).toHaveLength(0);
    expect(socialRequest).not.toHaveBeenCalled();
  });

  // 2. Standard + Facebook -> 403, 0 inserts, 0 webhooks
  it("2. Bloqueia conexão de Facebook para organização no plano Standard (403, zero inserts)", async () => {
    const db = createMockDb();
    organizationsStore[orgA] = { settings: { plan: "standard" } };

    let caughtError: unknown = null;
    try {
      await connectSocialInbox(db, orgA, accountIdFacebook, "https://crm.exemplo.com");
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(SocialError);
    if (caughtError instanceof SocialError) {
      expect(caughtError.status).toBe(403);
      expect(caughtError.message).toContain("não está disponível no plano STANDARD");
    }
    expect(insertedSessions).toHaveLength(0);
    expect(socialRequest).not.toHaveBeenCalled();
  });

  // 3. Pro + Instagram -> 200 / permitido
  it("3. Permite conexão de Instagram para organização no plano Pro", async () => {
    const db = createMockDb();
    organizationsStore[orgA] = { settings: { plan: "pro" } };

    const result = await connectSocialInbox(
      db,
      orgA,
      accountIdInstagram,
      "https://crm.exemplo.com",
    );

    expect(result.channel_id).toBeDefined();
    expect(result.already_connected).toBe(false);
    expect(insertedSessions).toHaveLength(1);
    expect(insertedSessions[0]?.provider).toBe("zernio_social");
    expect(socialRequest).toHaveBeenCalledWith(
      expect.anything(),
      "webhooks/settings",
      expect.anything(),
    );
  });

  // 4. Pro + Messenger/Facebook -> bloqueado se não estiver na matriz Pro / permitido com override
  it("4. Bloqueia Facebook no Pro padrão (sem override) e permite quando há override de canais", async () => {
    const db = createMockDb();
    // Pro padrão: não tem facebook/messenger na lista permitida
    organizationsStore[orgA] = { settings: { plan: "pro" } };

    let caughtError: unknown = null;
    try {
      await connectSocialInbox(db, orgA, accountIdFacebook, "https://crm.exemplo.com");
    } catch (err) {
      caughtError = err;
    }
    expect(caughtError).toBeInstanceOf(SocialError);
    if (caughtError instanceof SocialError) {
      expect(caughtError.status).toBe(403);
    }
    expect(insertedSessions).toHaveLength(0);

    // Agora com override no plan_limits permitindo messenger
    organizationsStore[orgA] = {
      settings: {
        plan: "pro",
        plan_limits: {
          allowed_channels: ["whatsapp", "instagram", "messenger"],
        },
      },
    };

    const result = await connectSocialInbox(
      db,
      orgA,
      accountIdFacebook,
      "https://crm.exemplo.com",
    );
    expect(result.channel_id).toBeDefined();
    expect(insertedSessions).toHaveLength(1);
  });

  // 5. Enterprise -> permitido
  it("5. Permite conexão irrestrita para organização no plano Enterprise", async () => {
    const db = createMockDb();
    organizationsStore[orgA] = { settings: { plan: "enterprise" } };

    const result = await connectSocialInbox(
      db,
      orgA,
      accountIdInstagram,
      "https://crm.exemplo.com",
    );
    expect(result.channel_id).toBeDefined();
    expect(insertedSessions).toHaveLength(1);
  });

  // 6. Pro com max_channels atingido (5) -> 403 bloqueado
  it("6. Bloqueia conexão no Pro quando atinge o limite máximo de 5 conexões ativas", async () => {
    const db = createMockDb();
    organizationsStore[orgA] = { settings: { plan: "pro" } };

    // Simula 5 canais ativos existentes
    for (let i = 1; i <= 5; i++) {
      channelSessionsStore.push({
        id: `sess-${i}`,
        organization_id: orgA,
        provider: "whatsapp",
        zernio_account_id: `acc-${i}`,
        display_name: `Canal ${i}`,
        status: "WORKING",
        metadata: {},
        updated_at: new Date().toISOString(),
        archived_at: null,
      });
    }

    let caughtError: unknown = null;
    try {
      await connectSocialInbox(db, orgA, accountIdInstagram, "https://crm.exemplo.com");
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(SocialError);
    if (caughtError instanceof SocialError) {
      expect(caughtError.status).toBe(403);
      expect(caughtError.message).toContain("Limite de conexões de canais atingido");
    }
    expect(insertedSessions).toHaveLength(0);
    expect(socialRequest).not.toHaveBeenCalled();
  });

  // 7. Reconexão de sessão existente com cota cheia -> permitido (usa excludeChannelSessionId)
  it("7. Permite reconexão de sessão social existente mesmo quando a cota do plano está no teto", async () => {
    const db = createMockDb();
    organizationsStore[orgA] = { settings: { plan: "pro" } };

    const existingSessionId = "existing-instagram-session-id";
    // 4 outros canais ativos
    for (let i = 1; i <= 4; i++) {
      channelSessionsStore.push({
        id: `sess-${i}`,
        organization_id: orgA,
        provider: "whatsapp",
        zernio_account_id: `acc-${i}`,
        display_name: `Canal ${i}`,
        status: "WORKING",
        metadata: {},
        updated_at: new Date().toISOString(),
        archived_at: null,
      });
    }

    // 5º canal é o canal a ser reconectado (status STOPPED, com token e secret)
    channelSessionsStore.push({
      id: existingSessionId,
      organization_id: orgA,
      provider: "zernio_social",
      zernio_account_id: accountIdInstagram,
      display_name: "Instagram Anterior",
      status: "STOPPED",
      metadata: {},
      webhook_secret_encrypted: "\\xencrypted-secret",
      webhook_path_token: "token-abc",
      updated_at: new Date(Date.now() - 100_000).toISOString(),
      archived_at: null,
    });

    const result = await connectSocialInbox(
      db,
      orgA,
      accountIdInstagram,
      "https://crm.exemplo.com",
    );

    expect(result.channel_id).toBe(existingSessionId);
    expect(result.already_connected).toBe(true);
    expect(insertedSessions).toHaveLength(0); // Reaproveitou a sessão existente sem violar o teto
  });

  // 8. Override Standard permitindo Instagram -> permitido
  it("8. Permite conexão no Standard quando há override explícito de allowed_channels contendo instagram", async () => {
    const db = createMockDb();
    organizationsStore[orgA] = {
      settings: {
        plan: "standard",
        plan_limits: {
          allowed_channels: ["whatsapp", "email", "instagram"],
        },
      },
    };

    const result = await connectSocialInbox(
      db,
      orgA,
      accountIdInstagram,
      "https://crm.exemplo.com",
    );
    expect(result.channel_id).toBeDefined();
    expect(insertedSessions).toHaveLength(1);
  });

  // 9. Override Standard permitindo Messenger -> permitido
  it("9. Permite conexão no Standard quando há override explícito de allowed_channels contendo messenger", async () => {
    const db = createMockDb();
    organizationsStore[orgA] = {
      settings: {
        plan: "standard",
        plan_limits: {
          allowed_channels: ["whatsapp", "messenger"],
        },
      },
    };

    const result = await connectSocialInbox(
      db,
      orgA,
      accountIdFacebook,
      "https://crm.exemplo.com",
    );
    expect(result.channel_id).toBeDefined();
    expect(insertedSessions).toHaveLength(1);
  });

  // 10. Plataforma desconhecida -> bloqueada fail-closed
  it("10. Rejeita fail-closed plataforma desconhecida ou sem suporte a atendimento", async () => {
    const db = createMockDb();
    organizationsStore[orgA] = { settings: { plan: "pro" } };

    vi.mocked(listSocialAccounts).mockResolvedValueOnce([
      {
        _id: "acc-unknown",
        platform: "twitter",
        username: "x_brand",
        isActive: true,
        profileId: "profile-1",
      },
    ]);

    let caughtError: unknown = null;
    try {
      await connectSocialInbox(db, orgA, "acc-unknown", "https://crm.exemplo.com");
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(SocialError);
    if (caughtError instanceof SocialError) {
      expect(caughtError.status).toBe(422);
      expect(caughtError.message).toContain("ainda não está disponível no CRM");
    }
    expect(insertedSessions).toHaveLength(0);
  });

  // 11. Tenant A não consome/influencia quota do Tenant B
  it("11. Garante isolamento multi-tenant: conexões do Tenant B não consomem a cota do Tenant A", async () => {
    const db = createMockDb();
    organizationsStore[orgA] = { settings: { plan: "pro" } };
    organizationsStore[orgB] = { settings: { plan: "pro" } };

    // Tenant B tem 5 conexões cheias
    for (let i = 1; i <= 5; i++) {
      channelSessionsStore.push({
        id: `sess-orgb-${i}`,
        organization_id: orgB,
        provider: "whatsapp",
        zernio_account_id: `acc-orgb-${i}`,
        display_name: `B Canal ${i}`,
        status: "WORKING",
        metadata: {},
        updated_at: new Date().toISOString(),
        archived_at: null,
      });
    }

    // Tenant A ainda tem 0 conexões -> deve conseguir conectar normalmente
    const result = await connectSocialInbox(
      db,
      orgA,
      accountIdInstagram,
      "https://crm.exemplo.com",
    );
    expect(result.channel_id).toBeDefined();
    expect(insertedSessions).toHaveLength(1);
  });

  // 12. Erro explícito de consulta em organizations -> bloqueado fail-closed (status 403)
  it("12. Bloqueia fail-closed com status 403 quando ocorre erro explícito na leitura de organizations", async () => {
    const db = createMockDb();
    const errorOrgId = "error-org-id";

    let caughtError: unknown = null;
    try {
      await connectSocialInbox(db, errorOrgId, accountIdInstagram, "https://crm.exemplo.com");
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(SocialError);
    if (caughtError instanceof SocialError) {
      expect(caughtError.status).toBe(403);
      expect(caughtError.message).toContain("Falha ao carregar configurações do plano");
    }
    expect(insertedSessions).toHaveLength(0);
    expect(socialRequest).not.toHaveBeenCalled();
  });

  // 13. Exceção inesperada durante o entitlement -> bloqueado fail-closed
  it("13. Bloqueia fail-closed com 403 se ocorrer exceção inesperada durante o processo de verificação", async () => {
    const db = createMockDb({ throwOnOrganizations: true });

    let caughtError: unknown = null;
    try {
      await connectSocialInbox(db, orgA, accountIdInstagram, "https://crm.exemplo.com");
    } catch (err) {
      caughtError = err;
    }

    expect(caughtError).toBeInstanceOf(SocialError);
    if (caughtError instanceof SocialError) {
      expect(caughtError.status).toBe(403);
    }
    expect(insertedSessions).toHaveLength(0);
    expect(socialRequest).not.toHaveBeenCalled();
  });
});
