import { describe, expect, it } from "vitest";

import { renderOperationalReceiptPdf } from "@/lib/lgpd/receipt-renderer";
import type { ReceiptContent, ReceiptIntegrity } from "@/lib/lgpd/operational-receipt";

const content: ReceiptContent = {
  organization_name: "Controlador QA",
  organization_cnpj: null,
  dpo_email: null,
  timezone: "America/Sao_Paulo",
  locale: "pt-BR",
  request_id: "41a38fbe-6890-4a15-9b64-42bc8c79a2b8",
  request_received_at: "2026-10-01T10:00:00.000Z",
  completed_at: "2026-10-01T11:00:00.000Z",
  request_scope: "contact",
  request_source: "Solicitação manual",
  requester: {
    documento_mascarado: null,
    telefone_mascarado: null,
    email_mascarado: null,
    identificacao_nao_reimpressa: "Dados de identificação não são reimpressos neste recibo.",
  },
  execution_mode: "Execução automática pelo sistema",
  execution_actor_user_id: null,
  execution_origin: "worker LGPD",
  result_counts: [{ category: "contacts", count: 1 }],
  media_queued: 0,
};

const integrity: ReceiptIntegrity = {
  algorithm: "SHA-256",
  code_type: "integridade",
  code: "0123456789ABCDEF",
  content_sha256: "0".repeat(64),
};

describe("renderer do recibo operacional", () => {
  it("gera bytes estáveis para o mesmo pedido concluído", async () => {
    const first = await renderOperationalReceiptPdf(content, integrity);
    const second = await renderOperationalReceiptPdf(content, integrity);

    expect(first.subarray(0, 8).toString("ascii")).toBe("%PDF-1.7");
    expect(first.equals(second)).toBe(true);
  });
});
