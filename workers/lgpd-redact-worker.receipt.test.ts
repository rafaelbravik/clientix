import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(),
  findLgpdRequest: vi.fn(),
  issueOperationalReceipt: vi.fn(),
  receiptStatusFromResult: vi.fn(),
  cascadeRedactContact: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/lgpd/repository", () => ({
  findLgpdRequest: mocks.findLgpdRequest,
  findContactByExternalId: vi.fn(),
}));
vi.mock("@/lib/lgpd/operational-receipt", () => ({
  issueOperationalReceipt: mocks.issueOperationalReceipt,
  receiptStatusFromResult: mocks.receiptStatusFromResult,
}));
vi.mock("@/lib/lgpd/redact-cascade", () => ({ cascadeRedactContact: mocks.cascadeRedactContact }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { processLgpdRedact } from "@/workers/lgpd-redact-worker";

const ORG = "bb808fa8-b1f8-4ac8-b0cb-f7daec513b9f";
const REQUEST = "41a38fbe-6890-4a15-9b64-42bc8c79a2b8";

describe("lgpd-redact-worker — reemissão best-effort do recibo", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.createAdminClient.mockReturnValue({});
    mocks.findLgpdRequest.mockResolvedValue({
      id: REQUEST,
      organization_id: ORG,
      request_type: "redact",
      source: "admin_panel",
      status: "completed",
      scope: "contact",
      attempts: 1,
      received_at: "2026-10-01T10:00:00.000Z",
      completed_at: "2026-10-01T11:00:00.000Z",
      request_payload: {},
      result: { receipt: { status: "error", error_code: "receipt_storage_failed" } },
    });
    mocks.receiptStatusFromResult.mockReturnValue("error");
    mocks.issueOperationalReceipt.mockResolvedValue({ status: "ready" });
  });

  it("retrya apenas o recibo de uma cascata já concluída", async () => {
    const result = await processLgpdRedact({
      id: "29d3d452-ecb1-421a-a295-33d475a83ab3",
      organization_id: ORG,
      entity_id: REQUEST,
      payload: { request_id: REQUEST, manually_approved: true, approved_by: "bb808fa8-b1f8-4ac8-b0cb-f7daec513b9f" },
    } as never);

    expect(result).toMatchObject({ status: "ok", detail: "receipt_issued" });
    expect(mocks.issueOperationalReceipt).toHaveBeenCalledOnce();
    expect(mocks.issueOperationalReceipt.mock.calls[0]?.[0]).toMatchObject({
      request: { execution_actor_user_id: "bb808fa8-b1f8-4ac8-b0cb-f7daec513b9f" },
    });
    expect(mocks.cascadeRedactContact).not.toHaveBeenCalled();
  });

  it("não reenvia PDF quando o recibo já está pronto", async () => {
    mocks.receiptStatusFromResult.mockReturnValue("ready");
    const result = await processLgpdRedact({
      id: "29d3d452-ecb1-421a-a295-33d475a83ab3",
      organization_id: ORG,
      entity_id: REQUEST,
      payload: { request_id: REQUEST },
    } as never);

    expect(result).toMatchObject({ status: "skipped", detail: "already_completed" });
    expect(mocks.issueOperationalReceipt).not.toHaveBeenCalled();
    expect(mocks.cascadeRedactContact).not.toHaveBeenCalled();
  });

  it("mantém a conclusão e sinaliza falha de recibo sem repetir a cascata", async () => {
    mocks.issueOperationalReceipt.mockResolvedValue({ status: "error", error_code: "receipt_storage_failed" });
    const result = await processLgpdRedact({
      id: "29d3d452-ecb1-421a-a295-33d475a83ab3",
      organization_id: ORG,
      entity_id: REQUEST,
      payload: { request_id: REQUEST },
    } as never);

    expect(result).toMatchObject({ status: "error", detail: "receipt_unavailable" });
    expect(mocks.cascadeRedactContact).not.toHaveBeenCalled();
  });
});
