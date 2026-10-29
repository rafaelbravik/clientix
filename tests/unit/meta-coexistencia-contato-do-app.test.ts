import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

import { ingestMetaAppContactSync } from "@/lib/channels/meta/ingest";
import { parseMetaWebhook } from "@/lib/channels/meta/webhook";
import { canonicalPhoneBR, phoneLookupVariants } from "@/lib/channels/phone-variants";

const ORG = "org-session-1";
const PHONE = "+5511987654321";
const PHONE_NUMBER_ID = "meta-number-1";
const EVENT = {
  kind: "app_contact_sync" as const,
  wabaId: "waba-1",
  phoneNumberId: PHONE_NUMBER_ID,
  phoneNumber: PHONE,
  displayName: "Nome recebido do app",
  action: "add" as const,
};
const OWNER = {
  organizationId: ORG,
  channelSessionId: "session-1",
  phoneNumberId: PHONE_NUMBER_ID,
};

function envelope(stateSync: unknown[]) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "waba-1",
        changes: [
          {
            field: "smb_app_state_sync",
            value: {
              metadata: { phone_number_id: PHONE_NUMBER_ID },
              state_sync: stateSync,
            },
          },
        ],
      },
    ],
  };
}

function adminFake(responses: Array<{ data: unknown; error: unknown }>) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  return {
    calls,
    admin: {
      from: (table: string) => {
        throw new Error(`Unexpected table read/write: ${table}`);
      },
      rpc: vi.fn(async (name: string, args: Record<string, unknown>) => {
        calls.push({ name, args });
        return responses.shift() ?? { data: null, error: null };
      }),
    } as never,
  };
}

describe("parser smb_app_state_sync", () => {
  it("emite contato add usando full_name ou first_name e ignora ações desconhecidas", () => {
    expect(
      parseMetaWebhook(
        envelope([
          { type: "contact", action: "add", contact: { phone_number: PHONE, full_name: "Nome Completo" } },
          { type: "contact", action: "add", contact: { phone_number: "+14155550123", first_name: "Ana" } },
          { type: "contact", action: "erase", contact: { phone_number: "+14155550124" } },
          null,
          { type: "contact", action: 3, contact: { phone_number: "+14155550126" } },
          { type: "contact", action: "add", contact: null },
          { type: "business", action: "add", contact: { phone_number: "+14155550125" } },
          { type: "contact", action: "add", contact: { full_name: "Sem telefone" } },
        ]) as never,
      ),
    ).toEqual([
      expect.objectContaining({ kind: "app_contact_sync", phoneNumber: PHONE, displayName: "Nome Completo" }),
      expect.objectContaining({ kind: "app_contact_sync", phoneNumber: "+14155550123", displayName: "Ana" }),
    ]);
  });

  it("remove e payload sem identidade não produzem evento gravável", () => {
    expect(
      parseMetaWebhook(
        envelope([
          { type: "contact", action: "remove", contact: { phone_number: PHONE } },
          { type: "contact", action: "add", contact: { phone_number: " " } },
        ]) as never,
      ),
    ).toEqual([expect.objectContaining({ kind: "app_contact_sync", action: "remove" })]);
  });
});

describe("ingestMetaAppContactSync", () => {
  beforeEach(() => vi.clearAllMocks());

  it("consulta supressão antes do upsert, no tenant da sessão, e escreve só a identidade permitida", async () => {
    const fake = adminFake([
      { data: "allowed", error: null },
      { data: "contact-1", error: null },
    ]);

    await expect(ingestMetaAppContactSync(fake.admin, EVENT, OWNER)).resolves.toEqual({ status: "synced" });
    expect(fake.calls.map((call) => call.name)).toEqual([
      "fn_whatsapp_history_check_suppression",
      "fn_upsert_wa_contact",
    ]);
    expect(fake.calls[0]).toEqual({
      name: "fn_whatsapp_history_check_suppression",
      args: {
        p_org: ORG,
        p_identities: phoneLookupVariants(canonicalPhoneBR(PHONE)).map((variant) => `phone:${variant}`),
      },
    });
    expect(fake.calls[1]).toEqual({
      name: "fn_upsert_wa_contact",
      args: {
        p_org: ORG,
        p_kind: "phone",
        p_phone: canonicalPhoneBR(PHONE),
        p_lid: null,
        p_chat_id: null,
        p_notify: "Nome recebido do app",
      },
    });
  });

  it("evento repetido reaproveita a mesma operação atômica de identidade", async () => {
    const fake = adminFake([
      { data: "allowed", error: null },
      { data: "contact-1", error: null },
      { data: "allowed", error: null },
      { data: "contact-1", error: null },
    ]);

    const first = await ingestMetaAppContactSync(fake.admin, EVENT, OWNER);
    const second = await ingestMetaAppContactSync(fake.admin, EVENT, OWNER);
    expect(first).toEqual({ status: "synced" });
    expect(second).toEqual({ status: "synced" });
    expect(fake.calls.filter((call) => call.name === "fn_upsert_wa_contact")).toHaveLength(2);
  });

  it("titular suprimido é ignorado antes do upsert", async () => {
    const fake = adminFake([{ data: "identity_suppressed", error: null }]);
    await expect(ingestMetaAppContactSync(fake.admin, EVENT, OWNER)).resolves.toEqual({
      status: "ignored",
      reason: "subject_suppressed",
    });
    expect(fake.calls.map((call) => call.name)).toEqual(["fn_whatsapp_history_check_suppression"]);
  });

  it.each([
    ["RPC com erro", { data: null, error: { code: "08006" } }],
    ["resposta inválida", { data: true, error: null }],
    ["chave de supressão indisponível", { data: "suppression_key_unavailable", error: null }],
    ["bloqueio de importação histórica", { data: "legacy_import_blocked", error: null }],
  ])("falha fechada na supressão: %s", async (_label, response) => {
    const fake = adminFake([response]);
    await expect(ingestMetaAppContactSync(fake.admin, EVENT, OWNER)).resolves.toEqual({
      status: "failed",
      reason: "suppression_check_unavailable",
    });
    expect(fake.calls.map((call) => call.name)).toEqual(["fn_whatsapp_history_check_suppression"]);
  });

  it("ação remove, sessão divergente ou número inválido nunca consultam/gravam identidade", async () => {
    const fake = adminFake([]);
    await expect(ingestMetaAppContactSync(fake.admin, { ...EVENT, action: "remove" }, OWNER)).resolves.toMatchObject({
      status: "ignored",
    });
    await expect(
      ingestMetaAppContactSync(fake.admin, EVENT, { ...OWNER, phoneNumberId: "other-number" }),
    ).resolves.toMatchObject({ status: "ignored", reason: "session_mismatch" });
    await expect(
      ingestMetaAppContactSync(fake.admin, { ...EVENT, phoneNumber: "not-a-phone" }, OWNER),
    ).resolves.toMatchObject({ status: "ignored", reason: "invalid_contact_identity" });
    expect(fake.calls).toEqual([]);
  });

  it("falha do upsert não é sucesso e race com tombstone permanece ignorada", async () => {
    const falha = adminFake([
      { data: "allowed", error: null },
      { data: null, error: { code: "08006", message: "database unavailable" } },
    ]);
    await expect(ingestMetaAppContactSync(falha.admin, EVENT, OWNER)).resolves.toEqual({
      status: "failed",
      reason: "contact_upsert_failed",
    });

    const corrida = adminFake([
      { data: "allowed", error: null },
      { data: null, error: { code: "42501", message: "lgpd_subject_suppressed" } },
    ]);
    await expect(ingestMetaAppContactSync(corrida.admin, EVENT, OWNER)).resolves.toEqual({
      status: "ignored",
      reason: "subject_suppressed",
    });
  });
});

describe("webhook Meta da coexistência", () => {
  it("despacha após HMAC com tenant/sessão do token e responde retryável em falha de banco", async () => {
    vi.resetModules();
    const appSecret = "unit-only-meta-secret";
    const chamadas: unknown[] = [];
    vi.doMock("@/lib/channels/meta/session", () => ({
      metaSessionByWebhookToken: async () => ({
        id: "session-1",
        organizationId: ORG,
        wabaId: "waba-1",
        phoneNumberId: PHONE_NUMBER_ID,
      }),
    }));
    vi.doMock("@/lib/channels/meta/app", () => ({ appDaMeta: async () => ({ appSecret }) }));
    vi.doMock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
    vi.doMock("@/lib/channels/meta/ingest", () => ({
      ingestMetaAppContactSync: async (...args: unknown[]) => {
        chamadas.push(args);
        return { status: "failed", reason: "suppression_check_unavailable" };
      },
      ingestMetaInbound: vi.fn(),
      ingestMetaEcho: vi.fn(),
    }));

    const { POST } = await import("@/app/api/v1/webhooks/meta/[token]/route");
    const body = JSON.stringify(envelope([{ type: "contact", action: "add", contact: { phone_number: PHONE } }]));
    const signature = createHmac("sha256", appSecret).update(body, "utf8").digest("hex");
    const response = await POST(
      { text: async () => body, headers: new Headers({ "x-hub-signature-256": `sha256=${signature}` }) } as never,
      { params: Promise.resolve({ token: "token-for-session" }) } as never,
    );

    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      error: { code: "service_unavailable", message: "contact_sync_temporarily_unavailable" },
    });
    expect(chamadas).toHaveLength(1);
    expect(chamadas[0]).toEqual([
      {},
      expect.objectContaining({ kind: "app_contact_sync", phoneNumberId: PHONE_NUMBER_ID }),
      { organizationId: ORG, channelSessionId: "session-1", phoneNumberId: PHONE_NUMBER_ID },
    ]);
  });
});
