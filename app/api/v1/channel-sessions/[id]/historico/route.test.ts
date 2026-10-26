import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  requireSupportWrite: vi.fn(),
  mfaEmDivida: vi.fn(),
  createAdminClient: vi.fn(),
  getHistoryProvider: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: mocks.requireSupportWrite }));
vi.mock("@/lib/auth/server", () => ({ mfaEmDivida: mocks.mfaEmDivida }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/channels/historico/provider", () => ({ getHistoryProvider: mocks.getHistoryProvider }));
vi.mock("@/lib/channels", () => ({
  CHANNEL_SESSION_REF_COLUMNS: "provider, session_ref",
  resolveSessionRef: vi.fn(() => "session-ref"),
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));

import { GET, POST } from "./route";

const ORG_A = "22222222-2222-4222-8222-222222222222";
const ORG_B = "33333333-3333-4333-8333-333333333333";
const USER = "11111111-1111-4111-8111-111111111111";
const SESSION = "44444444-4444-4444-8444-444444444444";
const IMPORT = "55555555-5555-4555-8555-555555555555";

const sessionRow = {
  id: SESSION,
  organization_id: ORG_A,
  provider: "channel-under-test",
  session_ref: "session-ref",
  status: "WORKING",
  archived_at: null,
};

function makeAdmin(options: { sessionOrg?: string; active?: Record<string, unknown> | null } = {}) {
  const inserted: Record<string, unknown>[] = [];
  const observed: { table: string; filters: Record<string, unknown>; op: string }[] = [];
  const db = {
    from(table: string) {
      const query = { table, filters: {} as Record<string, unknown>, op: "select", payload: {} as Record<string, unknown> };
      observed.push(query);
      const builder = {
        select: () => builder,
        eq(column: string, value: unknown) { query.filters[column] = value; return builder; },
        in(column: string, value: unknown) { query.filters[column] = value; return builder; },
        order: () => builder,
        limit: () => builder,
        insert(value: Record<string, unknown>) { query.op = "insert"; query.payload = value; inserted.push(value); return builder; },
        async maybeSingle() {
          if (table === "channel_sessions") {
            const visibleOrg = options.sessionOrg ?? ORG_A;
            const row = query.filters.organization_id === visibleOrg && query.filters.id === SESSION
              ? { ...sessionRow, organization_id: visibleOrg }
              : null;
            return { data: row, error: null };
          }
          if (table === "whatsapp_history_imports" && query.op === "insert") {
            return { data: { id: IMPORT, status: "pending", range_days: 30, range_start: "2026-09-26T00:00:00.000Z", imported_count: 0, skipped_count: 0, failed_count: 0, last_error_code: null, started_at: null, finished_at: null, updated_at: "2026-10-26T00:00:00.000Z", ...query.payload }, error: null };
          }
          return { data: options.active ?? null, error: null };
        },
        async single() {
          if (table === "whatsapp_history_imports" && query.op === "insert") {
            return { data: { id: IMPORT, status: "pending", range_days: 30, range_start: "2026-09-26T00:00:00.000Z", imported_count: 0, skipped_count: 0, failed_count: 0, last_error_code: null, started_at: null, finished_at: null, updated_at: "2026-10-26T00:00:00.000Z", ...query.payload }, error: null };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
    rpc: vi.fn(async () => ({ data: "allowed", error: null })),
  };
  return { db, inserted, observed };
}

function request(url: string, body?: unknown): NextRequest {
  return new NextRequest(url, body === undefined ? undefined : {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("channel history import route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({ ok: true, user: { id: USER }, org: { orgId: ORG_A } });
    mocks.requireSupportWrite.mockResolvedValue(null);
    mocks.mfaEmDivida.mockResolvedValue(false);
    mocks.audit.mockResolvedValue(undefined);
    mocks.getHistoryProvider.mockReturnValue({
      getVerifiedSession: vi.fn(async () => ({ status: "WORKING" })),
      isHistoryStoreEnabled: vi.fn(() => true),
      listarChatsHistorico: vi.fn(),
      listarMensagensHistorico: vi.fn(),
    });
  });

  it("escopa a conexão pelo tenant autenticado e não revela sessão de outro tenant", async () => {
    const { db, observed } = makeAdmin({ sessionOrg: ORG_B });
    mocks.createAdminClient.mockReturnValue(db);

    const response = await GET(request(`http://localhost/api/v1/channel-sessions/${SESSION}/historico`), {
      params: Promise.resolve({ id: SESSION }),
    });

    expect(response.status).toBe(404);
    expect(observed[0]?.filters).toEqual({ id: SESSION, organization_id: ORG_A });
    expect(observed.some((query) => query.table === "whatsapp_history_imports")).toBe(false);
  });

  it("inicia a importação com o tenant da sessão autenticada, ignorando organização enviada pelo cliente", async () => {
    const { db, inserted, observed } = makeAdmin();
    mocks.createAdminClient.mockReturnValue(db);

    const response = await POST(
      request(`http://localhost/api/v1/channel-sessions/${SESSION}/historico`, {
        range_days: 30,
        preview_confirmed: true,
        organization_id: ORG_B,
      }),
      { params: Promise.resolve({ id: SESSION }) },
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body.data.import.id).toBe(IMPORT);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]).toMatchObject({ organization_id: ORG_A, channel_session_id: SESSION, created_by: USER });
    expect(inserted[0]).not.toHaveProperty("organization_id", ORG_B);
    expect(observed.some((query) => query.table === "channel_sessions" && query.filters.organization_id === ORG_A)).toBe(true);
  });
});
