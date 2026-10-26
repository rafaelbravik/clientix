// @vitest-environment node

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const ATTACHMENT = "55555555-5555-4555-8555-555555555555";
const PATH = `${ORG}/lead-attachments/${LEAD}/${ATTACHMENT}.pdf`;

function sessionClient(options: { lead?: unknown; visible?: unknown } = {}) {
  let table = "";
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({
      data: table === "crm_leads"
        ? (Object.prototype.hasOwnProperty.call(options, "lead") ? options.lead : { id: LEAD })
        : (Object.prototype.hasOwnProperty.call(options, "visible") ? options.visible : {
            id: ATTACHMENT,
            safe_filename: "contrato.pdf",
            mime_type: "application/pdf",
          }),
      error: null,
    }),
  };
  return { from: vi.fn((name: string) => { table = name; return builder; }) };
}

function adminClient(storagePath = PATH) {
  const download = vi.fn(async () => ({
    data: new Blob(["%PDF-1.7\n"], { type: "application/pdf" }),
    error: null,
  }));
  let table = "";
  const builder = {
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: table === "crm_lead_attachments" ? {
      storage_bucket: "internal-media",
      storage_path: storagePath,
    } : null, error: null }),
  };
  return {
    from: vi.fn((name: string) => { table = name; return builder; }),
    storage: { from: vi.fn(() => ({ download })) },
    download,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, role: "viewer" },
  } as never);
  vi.mocked(createClient).mockResolvedValue(sessionClient() as never);
});

describe("GET /api/v1/leads/[id]/attachments/[attachmentId]/media", () => {
  it("faz stream privado autenticado com headers seguros", async () => {
    const admin = adminClient();
    vi.mocked(createAdminClient).mockReturnValue(admin as never);
    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments/${ATTACHMENT}/media?inline=1`),
      { params: Promise.resolve({ id: LEAD, attachmentId: ATTACHMENT }) },
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toMatch(/^inline;/);
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.text()).toContain("%PDF-1.7");
    expect(admin.download).toHaveBeenCalledWith(PATH);
  });

  it("um lead invisível de outro tenant vira 404 antes do service role", async () => {
    vi.mocked(createClient).mockResolvedValue(sessionClient({ lead: null }) as never);
    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments/${ATTACHMENT}/media`),
      { params: Promise.resolve({ id: LEAD, attachmentId: ATTACHMENT }) },
    );
    expect(response.status).toBe(404);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("recusa path adulterado e não acessa o objeto", async () => {
    const admin = adminClient(`${ORG}/lead-attachments/${LEAD}/${ATTACHMENT}.pdf/extra`);
    vi.mocked(createAdminClient).mockReturnValue(admin as never);
    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments/${ATTACHMENT}/media`),
      { params: Promise.resolve({ id: LEAD, attachmentId: ATTACHMENT }) },
    );
    expect(response.status).toBe(404);
    expect(admin.download).not.toHaveBeenCalled();
  });
});
