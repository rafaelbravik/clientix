import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { POST } from "@/app/api/v1/webhooks/nuvemshop/[event]/route";
import { signWebhook } from "@/lib/nuvemshop/oauth";

const FAKE_CLIENT_SECRET = "super-secret-client-token-123456";
const FAKE_ENCRYPTED_SECRET = "encrypted-secret-blob";
const FAKE_STORE_ID = "998877";
const FAKE_ORG_ID = "org-test-nuvemshop-123";

let capturedAudits: Record<string, unknown>[] = [];
let capturedWebhookEventsLogs: Record<string, unknown>[] = [];
let emittedEvents: Record<string, unknown>[] = [];
let existingWebhookEvent: Record<string, unknown> | null = null;
let rpcDecryptResult: { data: string | null; error: { message: string } | null } = {
  data: FAKE_CLIENT_SECRET,
  error: null,
};
let integrationRecord: Record<string, unknown> | null = {
  id: "integration-001",
  organization_id: FAKE_ORG_ID,
  webhook_secret_encrypted: FAKE_ENCRYPTED_SECRET,
};

vi.mock("@/lib/audit", () => ({
  audit: async (entry: Record<string, unknown>) => {
    capturedAudits.push(entry);
  },
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "tenant_integrations") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: integrationRecord,
                  error: null,
                }),
              }),
            }),
          }),
        };
      }
      if (table === "webhook_events_log") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                eq: () => ({
                  maybeSingle: async () => ({
                    data: existingWebhookEvent,
                    error: null,
                  }),
                }),
              }),
            }),
          }),
          insert: async (row: Record<string, unknown>) => {
            capturedWebhookEventsLogs.push(row);
            return { error: null };
          },
        };
      }
      return {};
    },
    rpc: async (fn: string, args: Record<string, unknown>) => {
      if (fn === "fn_decrypt_oauth") {
        return rpcDecryptResult;
      }
      if (fn === "emit_event") {
        emittedEvents.push(args);
        return { error: null };
      }
      return { data: null, error: null };
    },
  }),
}));

describe("AUD-01: Proteção e Hardening do Webhook Nuvemshop", () => {
  beforeEach(() => {
    capturedAudits = [];
    capturedWebhookEventsLogs = [];
    emittedEvents = [];
    existingWebhookEvent = null;
    rpcDecryptResult = { data: FAKE_CLIENT_SECRET, error: null };
    integrationRecord = {
      id: "integration-001",
      organization_id: FAKE_ORG_ID,
      webhook_secret_encrypted: FAKE_ENCRYPTED_SECRET,
    };
  });

  it("1. Payload válido + assinatura HMAC válida -> 200 sucesso com evento emitido", async () => {
    const payload = JSON.stringify({
      store_id: FAKE_STORE_ID,
      event: "order/created",
      id: 12345,
    });
    const signature = signWebhook(payload, FAKE_CLIENT_SECRET);

    const req = new NextRequest("http://localhost/api/v1/webhooks/nuvemshop/order-created", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-linkedstore-hmac-sha256": signature,
      },
      body: payload,
    });

    const res = await POST(req, { params: Promise.resolve({ event: "order-created" }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.accepted).toBe(true);

    expect(capturedWebhookEventsLogs.length).toBe(1);
    expect(emittedEvents.length).toBe(1);
    expect(emittedEvents[0]?.p_event_type).toBe("nuvemshop.order_created");
  });

  it("2. Payload válido + assinatura HMAC inválida -> 401 unauthenticated e sem emissão de evento", async () => {
    const payload = JSON.stringify({
      store_id: FAKE_STORE_ID,
      event: "order/created",
      id: 12345,
    });
    const invalidSignature = "deadbeef00112233445566778899aabbccddeeff00112233445566778899aabb";

    const req = new NextRequest("http://localhost/api/v1/webhooks/nuvemshop/order-created", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-linkedstore-hmac-sha256": invalidSignature,
      },
      body: payload,
    });

    const res = await POST(req, { params: Promise.resolve({ event: "order-created" }) });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("unauthenticated");

    // Zero processamento de negócio
    expect(capturedWebhookEventsLogs.length).toBe(0);
    expect(emittedEvents.length).toBe(0);
    expect(capturedAudits.some((a) => a.action === "nuvemshop.webhook_invalid_signature")).toBe(true);
  });

  it("3. Requisição sem header de assinatura -> 401 unauthenticated imediato", async () => {
    const payload = JSON.stringify({
      store_id: FAKE_STORE_ID,
      event: "order/created",
      id: 12345,
    });

    const req = new NextRequest("http://localhost/api/v1/webhooks/nuvemshop/order-created", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: payload,
    });

    const res = await POST(req, { params: Promise.resolve({ event: "order-created" }) });
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.code).toBe("unauthenticated");
    expect(json.error.message).toBe("missing_signature");

    // Não deve consultar descriptografia nem emitir eventos
    expect(capturedWebhookEventsLogs.length).toBe(0);
    expect(emittedEvents.length).toBe(0);
  });

  it("4. Body acima do limite de 256KB -> 413 Payload Too Large sem parse nem query", async () => {
    // Cria string de 300KB
    const largeBody = JSON.stringify({
      store_id: FAKE_STORE_ID,
      big_junk: "A".repeat(300 * 1024),
    });

    const req = new NextRequest("http://localhost/api/v1/webhooks/nuvemshop/order-created", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(largeBody, "utf8")),
        "x-linkedstore-hmac-sha256": "fake",
      },
      body: largeBody,
    });

    const res = await POST(req, { params: Promise.resolve({ event: "order-created" }) });
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error.code).toBe("payload_too_large");

    expect(capturedWebhookEventsLogs.length).toBe(0);
    expect(emittedEvents.length).toBe(0);
  });

  it("5. JSON malformado com HMAC válido -> 400 invalid_request (após verificação HMAC)", async () => {
    const malformedBody = `{"store_id": "${FAKE_STORE_ID}", "unclosed_json": `;
    const signature = signWebhook(malformedBody, FAKE_CLIENT_SECRET);

    const req = new NextRequest("http://localhost/api/v1/webhooks/nuvemshop/order-created", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-linkedstore-hmac-sha256": signature,
      },
      body: malformedBody,
    });

    const res = await POST(req, { params: Promise.resolve({ event: "order-created" }) });
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.code).toBe("invalid_request");
    expect(json.error.message).toBe("invalid_json");

    expect(capturedWebhookEventsLogs.length).toBe(0);
    expect(emittedEvents.length).toBe(0);
  });

  it("6. Evento duplicado -> Idempotência preservada (accepted: true, idempotent: true)", async () => {
    existingWebhookEvent = { id: "log-already-processed-001" };

    const payload = JSON.stringify({
      store_id: FAKE_STORE_ID,
      event: "order/created",
      id: 12345,
    });
    const signature = signWebhook(payload, FAKE_CLIENT_SECRET);

    const req = new NextRequest("http://localhost/api/v1/webhooks/nuvemshop/order-created", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-linkedstore-hmac-sha256": signature,
      },
      body: payload,
    });

    const res = await POST(req, { params: Promise.resolve({ event: "order-created" }) });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.accepted).toBe(true);
    expect(json.data.idempotent).toBe(true);

    // Não deve duplicar log nem emitir novo evento
    expect(capturedWebhookEventsLogs.length).toBe(0);
    expect(emittedEvents.length).toBe(0);
  });
});
