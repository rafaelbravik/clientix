import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSupportWrite: vi.fn(),
  mfaEmDivida: vi.fn(),
  createAdminClient: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.requireSupportWrite }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: mocks.mfaEmDivida }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));

import { POST } from "./route";

const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "44444444-4444-4444-8444-444444444444";
const IMPORT = "55555555-5555-4555-8555-555555555555";

function makeAdmin(options: { visibleOrg?: string; active?: boolean; latest?: string | null } = {}) {
  const queries: Array<{ table: string; op: string; filters: Record<string, unknown>; payload: Record<string, unknown> }> = [];
  const db = {
    from(table: string) {
      const novoQuery = () => ({ table, op: "select", filters: {} as Record<string, unknown>, payload: {} as Record<string, unknown> });
      let query = novoQuery();
      let resolvida = false;
      queries.push(query);
      const builder = {
        select() {
          if (resolvida) {
            query = novoQuery();
            queries.push(query);
            resolvida = false;
          }
          return builder;
        },
        eq(column: string, value: unknown) { query.filters[column] = value; return builder; },
        in(column: string, value: unknown) { query.filters[column] = value; return builder; },
        order: () => builder,
        limit: () => builder,
        update(payload: Record<string, unknown>) { query.op = "update"; query.payload = payload; return builder; },
        async maybeSingle() {
          if (table === "channel_sessions") {
            resolvida = true;
            return { data: (options.visibleOrg ?? ORG_A) === query.filters.organization_id && query.filters.id === SESSION ? { id: SESSION } : null, error: null };
          }
          if (query.op === "update" && options.active !== false) {
            resolvida = true;
            return { data: { id: IMPORT, status: "cancelled", imported_count: 2, skipped_count: 1, failed_count: 0 }, error: null };
          }
          resolvida = true;
          if (query.op === "select") return { data: options.latest ? { status: options.latest } : null, error: null };
          return { data: null, error: null };
        },
      };
      return builder;
    },
  };
  return { db, queries };
}

const request = new NextRequest(`http://localhost/api/v1/channel-sessions/${SESSION}/historico/cancel`, { method: "POST" });
const context = { params: Promise.resolve({ id: SESSION }) };

describe("cancelamento da importação histórica", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({ ok: true, user: { id: USER }, org: { orgId: ORG_A } });
    mocks.requireSupportWrite.mockResolvedValue(null);
    mocks.mfaEmDivida.mockResolvedValue(false);
    mocks.audit.mockResolvedValue(undefined);
  });

  it("cancela somente o job ativo da conexão do tenant autenticado e registra o motivo", async () => {
    const { db, queries } = makeAdmin();
    mocks.createAdminClient.mockReturnValue(db);

    const response = await POST(request, context);
    const body = await response.json();
    const update = queries.find((query) => query.table === "whatsapp_history_imports" && query.op === "update");

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("cancelled");
    expect(update?.filters).toMatchObject({ organization_id: ORG_A, channel_session_id: SESSION, status: ["pending", "running"] });
    expect(update?.payload).toMatchObject({ status: "cancelled", last_error_code: "manual_cancel", lease_token: null, lease_expires_at: null, next_attempt_at: null });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "channel.history_import_cancelled",
      organizationId: ORG_A,
      resourceId: IMPORT,
      metadata: expect.objectContaining({ reason_code: "manual_cancel", imported_count: 2 }),
    }));
  });

  it("não revela nem cancela uma conexão de outro tenant", async () => {
    const { db, queries } = makeAdmin({ visibleOrg: ORG_B });
    mocks.createAdminClient.mockReturnValue(db);

    const response = await POST(request, context);

    expect(response.status).toBe(404);
    expect(queries.some((query) => query.table === "whatsapp_history_imports")).toBe(false);
  });

  it("recusa support_readonly antes de consultar ou alterar jobs", async () => {
    const { db } = makeAdmin();
    mocks.createAdminClient.mockReturnValue(db);
    mocks.requireSupportWrite.mockResolvedValue(new Response("forbidden", { status: 403 }));

    const response = await POST(request, context);

    expect(response.status).toBe(403);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("repete cancelamento já confirmado sem transformar o estado terminal em erro", async () => {
    const { db, queries } = makeAdmin({ active: false, latest: "cancelled" });
    mocks.createAdminClient.mockReturnValue(db);

    const response = await POST(request, context);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.status).toBe("cancelled");
    expect(queries.filter((query) => query.table === "whatsapp_history_imports" && query.op === "update")).toHaveLength(1);
  });
});
