import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  createAdminClient: vi.fn(),
  download: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: mocks.requireRole }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));

import { GET } from "@/app/api/v1/lgpd/requests/[id]/receipt/route";

const ORG = "bb808fa8-b1f8-4ac8-b0cb-f7daec513b9f";
const REQUEST = "41a38fbe-6890-4a15-9b64-42bc8c79a2b8";

function apiAdmin(row: Record<string, unknown> | null) {
  const filters: Array<[string, unknown]> = [];
  const query: Record<string, unknown> = {};
  query["select"] = vi.fn(() => query);
  query["eq"] = vi.fn((column: string, value: unknown) => {
    filters.push([column, value]);
    return query;
  });
  query["maybeSingle"] = vi.fn(async () => ({ data: row, error: null }));
  const client = {
    from: vi.fn(() => query),
    storage: { from: vi.fn(() => ({ download: mocks.download })) },
  };
  return { client, filters };
}

describe("GET LGPD receipt — proxy autenticado", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requireRole.mockResolvedValue({ ok: true, org: { orgId: ORG }, user: { id: "user" } });
    mocks.download.mockResolvedValue({ data: new Blob(["%PDF synthetic"]), error: null });
  });

  it("revalida tenant/status e entrega o PDF sem URL portadora", async () => {
    const admin = apiAdmin({
      id: REQUEST,
      organization_id: ORG,
      request_type: "redact",
      status: "completed",
      result: { receipt: { status: "ready" } },
    });
    mocks.createAdminClient.mockReturnValue(admin.client);

    const response = await GET(
      new Request("http://localhost/api/v1/lgpd/requests/receipt") as never,
      { params: Promise.resolve({ id: REQUEST }) },
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(admin.filters).toContainEqual(["organization_id", ORG]);
    expect(admin.filters).toContainEqual(["id", REQUEST]);
    expect(mocks.download).toHaveBeenCalledWith(`${ORG}/receipts/${REQUEST}.pdf`);
    expect(JSON.stringify(await response.text())).not.toContain("signedUrl");
  });

  it("nega cross-tenant e não tenta ler o objeto privado", async () => {
    mocks.createAdminClient.mockReturnValue(apiAdmin(null).client);
    const response = await GET(
      new Request("http://localhost/api/v1/lgpd/requests/receipt") as never,
      { params: Promise.resolve({ id: REQUEST }) },
    );
    expect(response.status).toBe(404);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("não baixa pedido não concluído nem recibo com erro", async () => {
    const admin = apiAdmin({
      id: REQUEST,
      organization_id: ORG,
      request_type: "redact",
      status: "completed",
      result: { receipt: { status: "error" } },
    });
    mocks.createAdminClient.mockReturnValue(admin.client);
    const response = await GET(
      new Request("http://localhost/api/v1/lgpd/requests/receipt") as never,
      { params: Promise.resolve({ id: REQUEST }) },
    );
    expect(response.status).toBe(503);
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("respeita a recusa de RBAC antes do service role", async () => {
    mocks.requireRole.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    const response = await GET(
      new Request("http://localhost/api/v1/lgpd/requests/receipt") as never,
      { params: Promise.resolve({ id: REQUEST }) },
    );
    expect(response.status).toBe(403);
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(mocks.download).not.toHaveBeenCalled();
  });
});
