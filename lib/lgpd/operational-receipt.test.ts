import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  audit: vi.fn(),
  render: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/env", () => ({ env: { LGPD_RECEIPT_HMAC_KEY: "", LGPD_DPO_EMAIL: "" } }));
vi.mock("@/lib/instalacao/config", () => ({ valorDaInstalacao: vi.fn(async () => ({ valor: null })) }));
vi.mock("@/lib/lgpd/receipt-renderer", () => ({ renderOperationalReceiptPdf: mocks.render }));

import {
  buildReceiptContent,
  calculateReceiptIntegrity,
  issueOperationalReceipt,
  receiptObjectPath,
  receiptStatusFromResult,
} from "@/lib/lgpd/operational-receipt";

const REQUEST_ID = "41a38fbe-6890-4a15-9b64-42bc8c79a2b8";
const ORG_ID = "bb808fa8-b1f8-4ac8-b0cb-f7daec513b9f";

const request = {
  id: REQUEST_ID,
  status: "completed",
  request_type: "redact",
  source: "admin_panel",
  received_at: "2026-10-01T10:00:00.000Z",
  completed_at: "2026-10-01T11:00:00.000Z",
  scope: "contact" as const,
  request_payload: {
    customer: {
      name: "Titular Sintético",
      cpf: "123.456.789-09",
      phone: "+5511999991234",
      email: "titular@example.test",
      cpf_encrypted: "ciphertext-must-not-be-read",
    },
  },
  result: { cascaded_to: { contacts: 1, messages: 9, untrusted_secret: "must-not-print" }, media_queued: 2 },
};

function query(result: { data: unknown; error: unknown }) {
  const q: Record<string, unknown> = {};
  q["eq"] = vi.fn(() => q);
  q["select"] = vi.fn(() => q);
  q["maybeSingle"] = vi.fn(async () => result);
  q["then"] = (resolve: (value: unknown) => unknown, reject: (error: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject);
  return q;
}

function adminClient(options: { uploadError?: unknown; saveError?: unknown } = {}) {
  const patches: Array<Record<string, unknown>> = [];
  const upload = vi.fn(async () => ({ data: null, error: options.uploadError ?? null }));
  const from = vi.fn((table: string) => {
    if (table === "organizations") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            maybeSingle: vi.fn(async () => ({
              data: { legal_name: "Controlador de QA", cnpj: "12.345.678/0001-95", dpo_email: "privacidade@example.test", timezone: "America/Sao_Paulo", locale: "es" },
              error: null,
            })),
          })),
        })),
      };
    }
    return {
      update: vi.fn((patch: Record<string, unknown>) => {
        patches.push(patch);
        return query(
          options.saveError
            ? { data: null, error: options.saveError }
            : { data: { id: REQUEST_ID }, error: null },
        );
      }),
    };
  });
  return {
    client: { from, storage: { from: vi.fn(() => ({ upload })) } },
    from,
    upload,
    patches,
  };
}

describe("recibo operacional LGPD", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.render.mockResolvedValue(Buffer.from("%PDF-1.7 synthetic"));
  });

  it("mascara PII, ignora CPF cifrado e só inclui categorias conhecidas", () => {
    const content = buildReceiptContent({
      organization: { legal_name: "Controlador de QA", cnpj: "12.345.678/0001-95", dpo_email: null, timezone: "UTC", locale: "es" },
      request,
    });

    expect(content.requester.documento_mascarado).toBe("***.***.***-09");
    expect(content.requester.telefone_mascarado).toBe("(**) ****-1234");
    expect(content.requester.email_mascarado).toBe("t***@example.test");
    expect(content).not.toHaveProperty("cpf_encrypted");
    expect(JSON.stringify(content)).not.toContain("Titular Sintético");
    expect(JSON.stringify(content)).not.toContain("123.456.789-09");
    expect(JSON.stringify(content)).not.toContain("must-not-print");
    expect(content.result_counts).toEqual([
      { category: "contacts", count: 1 },
      { category: "messages", count: 9 },
    ]);
    expect(content.media_queued).toBe(2);
    expect(content.locale).toBe("es");
  });

  it("identifica o aprovador interno sem atribuir a ele a execução automática", () => {
    const content = buildReceiptContent({
      organization: { legal_name: "Controlador", cnpj: null, dpo_email: null, timezone: "UTC", locale: null },
      request: { ...request, execution_actor_user_id: "41a38fbe-6890-4a15-9b64-42bc8c79a2b8" },
    });

    expect(content.execution_mode).toBe("Execução automática após aprovação humana");
    expect(content.execution_actor_user_id).toBe("41a38fbe-6890-4a15-9b64-42bc8c79a2b8");
    expect(calculateReceiptIntegrity(content).content_sha256).not.toBe(
      calculateReceiptIntegrity(buildReceiptContent({
        organization: { legal_name: "Controlador", cnpj: null, dpo_email: null, timezone: "UTC", locale: null },
        request,
      })).content_sha256,
    );
  });

  it("usa HMAC só com chave dedicada e chama SHA-256 de integridade quando não há chave", () => {
    const content = buildReceiptContent({
      organization: { legal_name: "Controlador", cnpj: null, dpo_email: null, timezone: "UTC", locale: null },
      request,
    });
    const keyed = calculateReceiptIntegrity(content, "x".repeat(32));
    expect(keyed.algorithm).toBe("HMAC-SHA-256");
    expect(keyed.code_type).toBe("autenticidade");
    expect(keyed.code).toBe(calculateReceiptIntegrity(content, "x".repeat(32)).code);
    expect(calculateReceiptIntegrity({ ...content, organization_name: "Outro" }, "x".repeat(32)).code).not.toBe(keyed.code);

    const unkeyed = calculateReceiptIntegrity(content, "");
    expect(unkeyed.algorithm).toBe("SHA-256");
    expect(unkeyed.code_type).toBe("integridade");
  });

  it("deriva path interno e diferencia ready, missing e error", () => {
    expect(receiptObjectPath(ORG_ID, REQUEST_ID)).toBe(`${ORG_ID}/receipts/${REQUEST_ID}.pdf`);
    expect(receiptStatusFromResult({ receipt: { status: "ready" } })).toBe("ready");
    expect(receiptStatusFromResult({ receipt: { status: "error" } })).toBe("error");
    expect(receiptStatusFromResult({})).toBe("missing");
  });

  it("não tenta reemitir um recibo já pronto", async () => {
    await expect(
      issueOperationalReceipt({
        organizationId: ORG_ID,
        request: { ...request, result: { receipt: { status: "ready" } } },
      }),
    ).resolves.toEqual({ status: "ready" });
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
  });

  it("marca ready após upload privado e audita somente identificadores e integridade", async () => {
    const admin = adminClient();
    mocks.createAdminClient.mockReturnValue(admin.client);

    await expect(issueOperationalReceipt({ organizationId: ORG_ID, request })).resolves.toEqual({ status: "ready" });

    expect(admin.upload).toHaveBeenCalledWith(
      `${ORG_ID}/receipts/${REQUEST_ID}.pdf`,
      expect.any(Buffer),
      expect.objectContaining({ contentType: "application/pdf", upsert: true }),
    );
    expect(admin.patches.at(-1)?.["result"]).toMatchObject({ receipt: { status: "ready", algorithm: "SHA-256" } });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "lgpd.receipt_issued",
      organizationId: ORG_ID,
      resourceId: REQUEST_ID,
      metadata: expect.objectContaining({ request_id: REQUEST_ID, algorithm: "SHA-256", result: "ready" }),
    }));
    const auditPayload = JSON.stringify(mocks.audit.mock.calls[0]?.[0]);
    expect(auditPayload).not.toContain("titular@example.test");
    expect(auditPayload).not.toContain("123.456.789-09");
    expect(auditPayload).not.toContain("/receipts/");
  });

  it("falha de storage grava erro sanitizado sem alterar o status concluído", async () => {
    const admin = adminClient({ uploadError: { message: "private storage diagnostic" } });
    mocks.createAdminClient.mockReturnValue(admin.client);

    await expect(issueOperationalReceipt({ organizationId: ORG_ID, request })).resolves.toMatchObject({
      status: "error",
      error_code: "receipt_storage_failed",
    });

    const failurePatch = admin.patches.at(-1)!;
    expect(failurePatch).toEqual({ result: expect.objectContaining({ receipt: { status: "error", error_code: "receipt_storage_failed" } }) });
    expect(failurePatch).not.toHaveProperty("status");
    expect(mocks.audit).not.toHaveBeenCalled();
  });
});
