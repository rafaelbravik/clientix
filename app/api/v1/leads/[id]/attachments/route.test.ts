// @vitest-environment node

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const ORG = "11111111-1111-4111-8111-111111111111";
const USER = "22222222-2222-4222-8222-222222222222";
const LEAD = "33333333-3333-4333-8333-333333333333";
const PIPELINE = "44444444-4444-4444-8444-444444444444";
const ATTACHMENT = "55555555-5555-4555-8555-555555555555";

const metadata = {
  id: ATTACHMENT,
  safe_filename: "contrato.pdf",
  mime_type: "application/pdf",
  size_bytes: 32,
  created_at: "2026-10-26T12:00:00.000Z",
};

function clientBuilder(table: string, inserted?: Record<string, unknown>, multiple = false) {
  let mode: "select" | "insert" | "delete" = "select";
  const builder: Record<string, unknown> = {
    select: () => builder,
    eq: () => builder,
    order: () => builder,
    in: () => builder,
    insert: (row: Record<string, unknown>) => {
      mode = "insert";
      if (inserted) Object.assign(inserted, row);
      return builder;
    },
    delete: () => {
      mode = "delete";
      return builder;
    },
    maybeSingle: async () => {
      if (table === "crm_leads") return { data: { id: LEAD, pipeline_id: PIPELINE }, error: null };
      if (table === "crm_pipelines") return { data: { settings: { fields: [{ key: "contrato", label: "Contrato", type: "file", multiple }] } }, error: null };
      if (mode === "insert") return {
        data: {
          ...metadata,
          id: String(inserted?.id ?? metadata.id),
          safe_filename: String(inserted?.original_filename ?? metadata.safe_filename),
        },
        error: null,
      };
      return { data: null, error: null };
    },
    then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
      const data = table === "crm_lead_attachments" && mode === "select" ? [] : null;
      return Promise.resolve({ data, error: null }).then(resolve, reject);
    },
  };
  return builder;
}

function sessionClient(options: { leadExists?: boolean; attachments?: unknown[]; inserted?: Record<string, unknown>; multiple?: boolean } = {}) {
  return {
    from: (table: string) => {
      const builder = clientBuilder(table, options.inserted, options.multiple);
      if (table === "crm_leads" && options.leadExists === false) {
        (builder as { maybeSingle: () => Promise<unknown> }).maybeSingle = async () => ({ data: null, error: null });
      }
      if (table === "crm_lead_attachments" && options.attachments) {
        (builder as { then: (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => unknown }).then = (resolve, reject) =>
          Promise.resolve({ data: options.attachments, error: null }).then(resolve, reject);
      }
      return builder;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(requireRole).mockResolvedValue({
    ok: true,
    user: { id: USER, idioma: "pt-BR" },
    org: { orgId: ORG, role: "agent" },
  } as never);
  vi.mocked(requireSupportWrite).mockResolvedValue(null as never);
});

describe("/api/v1/leads/[id]/attachments", () => {
  it("GET devolve só metadados e proxy autenticado, sem caminho ou URL permanente", async () => {
    vi.mocked(createClient).mockResolvedValue(sessionClient({ attachments: [metadata] }) as never);
    const { GET } = await import("./route");
    const req = new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments?custom_field_key=contrato`);
    const response = await GET(req, { params: Promise.resolve({ id: LEAD }) });
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json.data.attachments[0]).toMatchObject({
      id: ATTACHMENT,
      filename: "contrato.pdf",
      media_url: `/api/v1/leads/${LEAD}/attachments/${ATTACHMENT}/media`,
    });
    expect(JSON.stringify(json)).not.toContain("storage_path");
    expect(JSON.stringify(json)).not.toContain("internal-media");
    expect(JSON.stringify(json)).not.toContain("signedURL");
  });

  it("GET es tenant-scoped e não consulta Storage quando o lead não existe na organização ativa", async () => {
    vi.mocked(createClient).mockResolvedValue(sessionClient({ leadExists: false }) as never);
    const { GET } = await import("./route");
    const response = await GET(
      new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments?custom_field_key=contrato`),
      { params: Promise.resolve({ id: LEAD }) },
    );
    expect(response.status).toBe(404);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("POST rejeita HTML renomeado para PDF antes de tocar no Storage", async () => {
    vi.mocked(createClient).mockResolvedValue(sessionClient() as never);
    const form = new FormData();
    form.set("custom_field_key", "contrato");
    form.append("files", new File(["<!doctype html><script>bad()</script>"], "proposta.pdf", { type: "application/pdf" }));
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments`, { method: "POST", body: form }),
      { params: Promise.resolve({ id: LEAD }) },
    );
    const json = await response.json();
    expect(response.status, JSON.stringify(json)).toBe(415);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("POST não alcança Storage quando o lead não pertence à organização ativa", async () => {
    vi.mocked(createClient).mockResolvedValue(sessionClient({ leadExists: false }) as never);
    const form = new FormData();
    form.set("custom_field_key", "contrato");
    form.append("files", new File(["%PDF-1.7\\n1 0 obj\\n<<>>\\nendobj\\n"], "contrato.pdf", { type: "application/pdf" }));
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments`, { method: "POST", body: form }),
      { params: Promise.resolve({ id: LEAD }) },
    );
    expect(response.status).toBe(404);
    expect(createAdminClient).not.toHaveBeenCalled();
  });

  it("limita o corpo mesmo sem Content-Length antes de materializar o multipart", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(51 * 1024 * 1024 + 1));
        controller.close();
      },
    });
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments`, {
        method: "POST",
        headers: { "content-type": "multipart/form-data; boundary=unused" },
        body,
        duplex: "half",
      } as never),
      { params: Promise.resolve({ id: LEAD }) },
    );
    expect(response.status).toBe(413);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("POST válido usa Storage privado e devolve apenas capability do proxy", async () => {
    const inserted: Record<string, unknown> = {};
    vi.mocked(createClient).mockResolvedValue(sessionClient({ inserted }) as never);
    const upload = vi.fn(async () => ({ error: null }));
    const admin = {
      from: (table: string) => clientBuilder(table, inserted),
      storage: { from: vi.fn(() => ({ upload, remove: vi.fn(async () => ({ error: null })) })) },
    };
    vi.mocked(createAdminClient).mockReturnValue(admin as never);
    const form = new FormData();
    form.set("custom_field_key", "contrato");
    form.append("files", new File(["%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"], "contrato.pdf", { type: "application/pdf" }));
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments`, { method: "POST", body: form }),
      { params: Promise.resolve({ id: LEAD }) },
    );
    const json = await response.json();
    expect(response.status, JSON.stringify(json)).toBe(201);
    expect(upload).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${ORG}/lead-attachments/${LEAD}/[0-9a-f-]+\\.pdf$`)),
      expect.any(Buffer),
      { contentType: "application/pdf", upsert: false },
    );
    expect(json.data.attachments[0].media_url).toContain(`/api/v1/leads/${LEAD}/attachments/`);
    expect(JSON.stringify(json)).not.toContain("internal-media");
    expect(JSON.stringify(json)).not.toContain("storage_path");
  });

  it("POST aceita vários anexos quando o campo do pipeline permite", async () => {
    const inserted: Record<string, unknown> = {};
    vi.mocked(createClient).mockResolvedValue(sessionClient({ inserted, multiple: true }) as never);
    const upload = vi.fn(async () => ({ error: null }));
    const admin = {
      from: (table: string) => clientBuilder(table, inserted),
      storage: { from: vi.fn(() => ({ upload, remove: vi.fn(async () => ({ error: null })) })) },
    };
    vi.mocked(createAdminClient).mockReturnValue(admin as never);
    const form = new FormData();
    form.set("custom_field_key", "contrato");
    const bytes = "%PDF-1.7\\n1 0 obj\\n<<>>\\nendobj\\n";
    form.append("files", new File([bytes], "contrato-a.pdf", { type: "application/pdf" }));
    form.append("files", new File([bytes], "contrato-b.pdf", { type: "application/pdf" }));
    const { POST } = await import("./route");
    const response = await POST(
      new NextRequest(`http://localhost/api/v1/leads/${LEAD}/attachments`, { method: "POST", body: form }),
      { params: Promise.resolve({ id: LEAD }) },
    );
    const json = await response.json();
    expect(response.status, JSON.stringify(json)).toBe(201);
    expect(upload).toHaveBeenCalledTimes(2);
    expect(json.data.attachments).toHaveLength(2);
    expect(json.data.attachments.map((item: { filename: string }) => item.filename)).toEqual([
      "contrato-a.pdf",
      "contrato-b.pdf",
    ]);
  });
});
