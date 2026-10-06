import { describe, expect, it, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";
import type { SupabaseClient } from "@supabase/supabase-js";

// Hoisted mocks para autenticação, RBAC e DB
let currentMockAdmin: SupabaseClient;

const authMocks = vi.hoisted(() => ({
  role: vi.fn(),
  support: vi.fn(),
  audit: vi.fn(),
  sendMsg: vi.fn(),
  admin: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: authMocks.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: authMocks.support }));
vi.mock("@/lib/audit", () => ({ audit: authMocks.audit }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler: authMocks.sendMsg }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => currentMockAdmin }));

// Imports dos handlers e rotas
import { POST as acaoHandler } from "@/app/api/v1/campaigns/[id]/[acao]/route";
import { rodarUmaRodadaDeCampanha } from "@/lib/campanhas/rodada";

interface OrgStore {
  settings: Record<string, unknown>;
}

interface CampaignStore {
  id: string;
  organization_id: string;
  name: string;
  status: string;
  channel?: "whatsapp" | "telegram" | "email";
  channel_session_id: string;
  message_body: string | null;
  base_legal: string;
  lia_ref: string | null;
  audience_filter: unknown;
  audience_version: number;
  content_version: number;
  scheduled_at: string | null;
  started_at: string | null;
  paused_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  description: string | null;
  intervalo_segundos: number | null;
  janela_inicio_hora: number | null;
  janela_fim_hora: number | null;
  teto_diario: number | null;
  teto_horario: number | null;
}

interface RecipientStore {
  id: string;
  campaign_id: string;
  contact_id: string;
  recipient_address: string;
  status: string;
  eligibility_status: string;
  rendered_body: string;
  next_attempt_at: string | null;
  sent_at: string | null;
}

describe("SEC-003: Execução de Campanhas após Downgrade de Plano", () => {
  const orgA = "11111111-1111-4111-8111-111111111111";
  const orgB = "22222222-2222-4222-8222-222222222222";
  const campaignId1 = "cccccccc-1111-4111-8111-111111111111";
  const campaignId2 = "cccccccc-2222-4222-8222-222222222222";
  const channelSessionId = "ssssssss-1111-4111-8111-111111111111";

  let orgs: Record<string, OrgStore>;
  let campaigns: Record<string, CampaignStore>;
  let recipients: RecipientStore[];
  let dbUpdates: Array<{ table: string; data: Record<string, unknown>; filter: Record<string, unknown> }>;

  function createMockAdmin(opts?: { throwOnOrganizations?: boolean }): SupabaseClient {
    return {
      from: vi.fn((table: string) => {
        if (table === "organizations") {
          if (opts?.throwOnOrganizations) {
            throw new Error("Simulated database outage on organizations table");
          }
          let queryOrgId: string | null = null;
          const b = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn((col: string, val: string) => {
              if (col === "id") queryOrgId = val;
              return b;
            }),
            neq: vi.fn().mockReturnThis(),
            single: vi.fn(async () => {
              const found = queryOrgId ? orgs[queryOrgId] : null;
              return { data: found ?? null, error: found ? null : { message: "Org not found" } };
            }),
            maybeSingle: vi.fn(async () => {
              const found = queryOrgId ? orgs[queryOrgId] : null;
              return { data: found ?? null, error: null };
            }),
            then: vi.fn((resolve: (val: unknown) => unknown) => {
              return resolve({ data: [], error: null });
            }),
          };
          return b;
        }

        if (table === "campaigns") {
          const filters: Record<string, unknown> = {};
          let limitCount = 100;

          const b = {
            select: vi.fn().mockReturnThis(),
            update: vi.fn((data: Record<string, unknown>) => {
              const upBuilder = {
                eq: vi.fn((col: string, val: unknown) => {
                  filters[col] = val;
                  return upBuilder;
                }),
                lte: vi.fn((col: string, val: unknown) => {
                  filters[`lte_${col}`] = val;
                  return upBuilder;
                }),
                select: vi.fn(async () => {
                  dbUpdates.push({ table: "campaigns", data, filter: { ...filters } });
                  const updatedList: Array<{ id: string }> = [];
                  for (const [id, c] of Object.entries(campaigns)) {
                    if (filters.id && c.id !== filters.id) continue;
                    if (filters.organization_id && c.organization_id !== filters.organization_id) continue;
                    if (filters.status && c.status !== filters.status) continue;
                    Object.assign(c, data);
                    updatedList.push({ id });
                  }
                  return { data: updatedList, error: null };
                }),
                then: vi.fn((resolve: (val: unknown) => unknown) => {
                  dbUpdates.push({ table: "campaigns", data, filter: { ...filters } });
                  for (const c of Object.values(campaigns)) {
                    if (filters.id && c.id !== filters.id) continue;
                    if (filters.organization_id && c.organization_id !== filters.organization_id) continue;
                    if (filters.status && c.status !== filters.status) continue;
                    Object.assign(c, data);
                  }
                  return resolve({ data: [], error: null });
                }),
              };
              return upBuilder;
            }),
            insert: vi.fn((data: Record<string, unknown>) => {
              const newId = `new-camp-${Date.now()}`;
              campaigns[newId] = {
                id: newId,
                organization_id: (data.organization_id as string) ?? orgA,
                name: (data.name as string) ?? "Nova",
                status: "draft",
                channel_session_id: (data.channel_session_id as string) ?? channelSessionId,
                message_body: (data.message_body as string) ?? "Corpo",
                base_legal: (data.base_legal as string) ?? "consent",
                lia_ref: null,
                audience_filter: {},
                audience_version: 1,
                content_version: 1,
                scheduled_at: null,
                started_at: null,
                paused_at: null,
                completed_at: null,
                cancelled_at: null,
                description: null,
                intervalo_segundos: null,
                janela_inicio_hora: null,
                janela_fim_hora: null,
                teto_diario: null,
                teto_horario: null,
              };
              return {
                select: vi.fn().mockReturnValue({
                  single: vi.fn(async () => ({ data: { id: newId }, error: null })),
                }),
              };
            }),
            eq: vi.fn((col: string, val: unknown) => {
              filters[col] = val;
              return b;
            }),
            lte: vi.fn(() => b),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn((l: number) => {
              limitCount = l;
              return b;
            }),
            not: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn(async () => {
              for (const c of Object.values(campaigns)) {
                if (filters.organization_id && c.organization_id !== filters.organization_id) continue;
                if (filters.id && c.id !== filters.id) continue;
                return { data: c, error: null };
              }
              return { data: null, error: null };
            }),
            then: vi.fn((resolve: (val: unknown) => unknown) => {
              const matched: CampaignStore[] = [];
              for (const c of Object.values(campaigns)) {
                if (filters.status && c.status !== filters.status) continue;
                matched.push(c);
                if (matched.length >= limitCount) break;
              }
              return resolve({ data: matched, error: null });
            }),
          };
          return b;
        }

        if (table === "campaign_recipients") {
          const filters: Record<string, unknown> = {};
          let isCount = false;

          const b = {
            select: vi.fn((_cols: string, opts?: { count?: string; head?: boolean }) => {
              if (opts?.count === "exact") isCount = true;
              return b;
            }),
            update: vi.fn((data: Record<string, unknown>) => {
              const upChain = {
                eq: vi.fn((col: string, val: unknown) => {
                  filters[col] = val;
                  return upChain;
                }),
                in: vi.fn((col: string, val: unknown) => {
                  filters[`in_${col}`] = val;
                  return upChain;
                }),
                then: vi.fn((resolve: (val: unknown) => unknown) => {
                  for (const r of recipients) {
                    if (filters.id && r.id !== filters.id) continue;
                    if (filters.campaign_id && r.campaign_id !== filters.campaign_id) continue;
                    Object.assign(r, data);
                  }
                  return resolve({ data: [], error: null });
                }),
                select: vi.fn(async () => ({ data: [], error: null })),
              };
              return upChain;
            }),
            eq: vi.fn((col: string, val: unknown) => {
              filters[col] = val;
              return b;
            }),
            in: vi.fn().mockReturnThis(),
            or: vi.fn().mockReturnThis(),
            order: vi.fn().mockReturnThis(),
            limit: vi.fn().mockReturnThis(),
            then: vi.fn((resolve: (val: unknown) => unknown) => {
              if (isCount) {
                const count = recipients.filter((r) => {
                  if (filters.campaign_id && r.campaign_id !== filters.campaign_id) return false;
                  if (filters.eligibility_status && r.eligibility_status !== filters.eligibility_status) return false;
                  return true;
                }).length;
                return resolve({ count, error: null });
              }
              const matched = recipients.filter((r) => {
                if (filters.campaign_id && r.campaign_id !== filters.campaign_id) return false;
                if (filters.status && r.status !== filters.status) return false;
                return true;
              }).map((r) => ({
                ...r,
                contacts: {
                  id: r.contact_id,
                  name: "Contato Teste",
                  display_name: "Contato Teste",
                  phone_number: r.recipient_address,
                  is_blocked: false,
                  is_anonymized: false,
                  consent: null,
                },
              }));
              return resolve({ data: matched, error: null });
            }),
          };
          return b;
        }

        if (table === "channel_sessions") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn(async () => ({
              data: { daily_message_limit: null, status: "WORKING" },
              error: null,
            })),
          };
        }

        if (table === "channel_knobs") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn(async () => ({
              data: { timezone: "America/Sao_Paulo" },
              error: null,
            })),
          };
        }

        if (table === "contacts") {
          return {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            maybeSingle: vi.fn(async () => ({
              data: {
                id: "contato-1",
                name: "Lead Teste",
                display_name: "Lead Teste",
                phone_number: "+5511999998888",
                is_blocked: false,
                is_anonymized: false,
                consent: null,
              },
              error: null,
            })),
          };
        }

        return {} as unknown;
      }),
    } as unknown as SupabaseClient;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    authMocks.support.mockResolvedValue(null);
    authMocks.role.mockResolvedValue({
      ok: true,
      org: { orgId: orgA },
      user: { id: "user-1", idioma: "pt-BR" },
    });
    authMocks.sendMsg.mockResolvedValue({ status: "sent" });

    orgs = {
      [orgA]: {
        settings: {
          plan: "pro", // Começa como Pro
        },
      },
      [orgB]: {
        settings: {
          plan: "pro",
        },
      },
    };

    campaigns = {
      [campaignId1]: {
        id: campaignId1,
        organization_id: orgA,
        name: "Campanha Black Friday",
        status: "ready",
        channel_session_id: channelSessionId,
        message_body: "Olá {{nome}}, aproveite nossa promoção!",
        base_legal: "consent",
        lia_ref: null,
        audience_filter: {},
        audience_version: 1,
        content_version: 1,
        scheduled_at: null,
        started_at: null,
        paused_at: null,
        completed_at: null,
        cancelled_at: null,
        description: null,
        intervalo_segundos: null,
        janela_inicio_hora: null,
        janela_fim_hora: null,
        teto_diario: null,
        teto_horario: null,
      },
      [campaignId2]: {
        id: campaignId2,
        organization_id: orgB,
        name: "Campanha do Tenant B",
        status: "ready",
        channel_session_id: channelSessionId,
        message_body: "Mensagem B",
        base_legal: "consent",
        lia_ref: null,
        audience_filter: {},
        audience_version: 1,
        content_version: 1,
        scheduled_at: null,
        started_at: null,
        paused_at: null,
        completed_at: null,
        cancelled_at: null,
        description: null,
        intervalo_segundos: null,
        janela_inicio_hora: null,
        janela_fim_hora: null,
        teto_diario: null,
        teto_horario: null,
      },
    };

    recipients = [
      {
        id: "rec-1",
        campaign_id: campaignId1,
        contact_id: "contato-1",
        recipient_address: "+5511999998888",
        status: "pending",
        eligibility_status: "eligible",
        rendered_body: "Olá Lead Teste, aproveite!",
        next_attempt_at: null,
        sent_at: null,
      },
    ];

    dbUpdates = [];
    currentMockAdmin = createMockAdmin();
  });

  const callAcao = (acao: string, id = campaignId1, body: unknown = {}) =>
    acaoHandler(
      new Request(`https://crm.test/api/v1/campaigns/${id}/${acao}`, {
        method: "POST",
        body: JSON.stringify(body),
      }) as NextRequest,
      { params: Promise.resolve({ id, acao }) },
    );

  // 1. Pro cria campanha -> start permitido
  it("1. Permite iniciar campanha quando a organização está no plano Pro", async () => {
    const res = await callAcao("iniciar");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data).toBeDefined();
    expect(campaigns[campaignId1]?.status).toBe("running");
  });

  // 2. Pro cria campanha -> downgrade para Standard -> start bloqueado com 403
  it("2. Bloqueia iniciar campanha (HTTP 403) após downgrade para plano Standard", async () => {
    orgs[orgA] = { settings: { plan: "standard" } };

    const res = await callAcao("iniciar");
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error.code).toBe("feature_disabled");
    expect(campaigns[campaignId1]?.status).toBe("ready"); // Não mudou para running
  });

  // 3. Pro cria campanha -> downgrade -> resume (retomar) bloqueado com 403
  it("3. Bloqueia retomar campanha pausada (HTTP 403) após downgrade para plano Standard", async () => {
    campaigns[campaignId1]!.status = "paused";
    orgs[orgA] = { settings: { plan: "standard" } };

    const res = await callAcao("retomar");
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error.code).toBe("feature_disabled");
    expect(campaigns[campaignId1]?.status).toBe("paused"); // Permaneceu pausada
  });

  // 4. Pro cria campanha -> downgrade -> retry/testar bloqueado com 403
  it("4. Bloqueia disparo de teste (HTTP 403) após downgrade para plano Standard", async () => {
    orgs[orgA] = { settings: { plan: "standard" } };

    const res = await callAcao("testar", campaignId1, { contact_id: "contato-1" });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error.code).toBe("feature_disabled");
    expect(authMocks.sendMsg).not.toHaveBeenCalled();
  });

  // 5. Pro cria campanha -> downgrade -> schedule (agendar) bloqueado com 403
  it("5. Bloqueia agendamento de campanha (HTTP 403) após downgrade para plano Standard", async () => {
    orgs[orgA] = { settings: { plan: "standard" } };

    const futureDate = new Date(Date.now() + 86400000).toISOString();
    const res = await callAcao("agendar", campaignId1, { scheduled_at: futureDate });
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error.code).toBe("feature_disabled");
    expect(campaigns[campaignId1]?.status).toBe("ready");
  });

  // 6. Pro cria campanha -> downgrade -> prepare (preparar) bloqueado com 403
  it("6. Bloqueia preparação de audiência (HTTP 403) após downgrade para plano Standard", async () => {
    campaigns[campaignId1]!.status = "draft";
    orgs[orgA] = { settings: { plan: "standard" } };

    const res = await callAcao("preparar");
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error.code).toBe("feature_disabled");
    expect(campaigns[campaignId1]?.status).toBe("draft");
  });

  // 7. Pro cria campanha -> downgrade -> duplicate (duplicar) bloqueado com 403
  it("7. Bloqueia duplicação de campanha (HTTP 403) após downgrade para plano Standard", async () => {
    orgs[orgA] = { settings: { plan: "standard" } };

    const res = await callAcao("duplicar");
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error.code).toBe("feature_disabled");
  });

  // 8. Downgrade -> pause (pausar) permitido (ação restritiva)
  it("8. Permite pausar campanha mesmo após downgrade para plano Standard", async () => {
    campaigns[campaignId1]!.status = "running";
    orgs[orgA] = { settings: { plan: "standard" } }; // Downgrade ocorreu

    const res = await callAcao("pausar");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data).toBeDefined();
    expect(campaigns[campaignId1]?.status).toBe("paused");
  });

  // 9. Downgrade -> cancel (cancelar) permitido (ação restritiva)
  it("9. Permite cancelar campanha mesmo após downgrade para plano Standard", async () => {
    campaigns[campaignId1]!.status = "running";
    orgs[orgA] = { settings: { plan: "standard" } }; // Downgrade ocorreu

    const res = await callAcao("cancelar");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data).toBeDefined();
    expect(campaigns[campaignId1]?.status).toBe("cancelled");
  });

  // 10. Job/Campanha agendada -> downgrade antes do worker -> worker pausa e não envia
  it("10. Worker de rodada detecta downgrade em campanha agendada e não dispara mensagens", async () => {
    campaigns[campaignId1]!.status = "running";
    orgs[orgA] = { settings: { plan: "standard" } }; // Sofreu downgrade

    const resultado = await rodarUmaRodadaDeCampanha(currentMockAdmin);
    expect(resultado.enviadas).toBe(0);
    expect(resultado.detalhe).toContain("bloqueado:plano_sem_campanhas");
    expect(campaigns[campaignId1]?.status).toBe("paused");
    expect(authMocks.sendMsg).not.toHaveBeenCalled();
    expect(recipients[0]?.status).toBe("pending"); // Destinatário permaneceu pendente sem ser consumido
  });

  // 11. Campanha parcialmente enviada -> downgrade -> novos recipients não são enviados
  it("11. Em campanha parcialmente enviada, downgrade pausa imediatamente sem corromper destinatários", async () => {
    campaigns[campaignId1]!.status = "running";
    recipients.push({
      id: "rec-2",
      campaign_id: campaignId1,
      contact_id: "contato-2",
      recipient_address: "+5511999997777",
      status: "pending",
      eligibility_status: "eligible",
      rendered_body: "Texto 2",
      next_attempt_at: null,
      sent_at: null,
    });

    orgs[orgA] = { settings: { plan: "standard" } }; // Downgrade ocorreu

    const resultado = await rodarUmaRodadaDeCampanha(currentMockAdmin);
    expect(resultado.enviadas).toBe(0);
    expect(campaigns[campaignId1]?.status).toBe("paused");
    expect(authMocks.sendMsg).not.toHaveBeenCalled();
    expect(recipients[0]?.status).toBe("pending");
    expect(recipients[1]?.status).toBe("pending");
  });

  // 12. Tenant A tenta executar ação em campanha do Tenant B (IDOR) -> 404
  it("12. Tenant A não consegue acionar ações na campanha do Tenant B (isolamento multi-tenant / 404)", async () => {
    // Tentativa de executar ação em campaignId2 (pertencente ao Tenant B)
    const res = await callAcao("iniciar", campaignId2);
    expect(res.status).toBe(404);
    const data = await res.json();
    expect(data.error.code).toBe("campanha_nao_encontrada");
  });

  // 13. Erro no checkFeatureQuota -> fail-closed (bloqueia com 403)
  it("13. Erro inesperado na verificação de entitlement opera em modo fail-closed", async () => {
    currentMockAdmin = createMockAdmin({ throwOnOrganizations: true });

    const res = await callAcao("iniciar");
    expect(res.status).toBe(403);
    const data = await res.json();
    expect(data.error.code).toBe("feature_disabled");
    expect(campaigns[campaignId1]?.status).toBe("ready");
  });

  // 14. Enterprise/Pro válido -> fluxo normal preservado em todas as ações
  it("14. Preserva funcionamento pleno de ações operacionais para organizações no plano Enterprise", async () => {
    orgs[orgA] = { settings: { plan: "enterprise" } };

    const res = await callAcao("iniciar");
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data).toBeDefined();
    expect(campaigns[campaignId1]?.status).toBe("running");
  });
});
