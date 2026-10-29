import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isInternalNoticeNumber: vi.fn(async () => false),
  findContactByPhone: vi.fn(async () => null),
}));

vi.mock("@/lib/escalacao/numero-interno-de-aviso", () => ({
  ehNumeroInternoDeAviso: mocks.isInternalNoticeNumber,
  registrarMensagemIgnorada: vi.fn(),
}));
vi.mock("../contato-por-telefone", () => ({
  encontrarContatoPorTelefone: mocks.findContactByPhone,
}));

import { ingestMetaEcho, ingestMetaInbound } from "@/lib/channels/meta/ingest";
import type { InboundMessageEvent, OutboundEchoEvent } from "@/lib/channels/meta/webhook";

const SUPPRESSED = { code: "42501", message: "lgpd_subject_suppressed" };

function adminComSupressao() {
  const rpc = vi.fn(async (..._args: unknown[]) => ({ data: null, error: SUPPRESSED }));
  return { rpc, from: vi.fn() };
}

const owner = { organizationId: "org-qa", channelSessionId: "session-qa" } as never;

describe("Meta não recria titular anonimizado", () => {
  it("ingresso inbound reconhece a recusa canônica antes de abrir conversa", async () => {
    const admin = adminComSupressao();
    const event: InboundMessageEvent = {
      kind: "inbound_message",
      wabaId: "waba-qa",
      phoneNumberId: "phone-number-qa",
      externalId: "wamid.qa.inbound",
      from: "5531999991234",
      profileName: "Contato QA",
      sentAt: new Date("2026-10-28T12:00:00.000Z"),
      type: "text",
      text: "mensagem de teste",
      media: null,
    };

    await expect(ingestMetaInbound(admin as never, event, owner)).resolves.toEqual({
      status: "ignored",
      reason: "titular_apagado_a_pedido",
    });
    expect(admin.rpc).toHaveBeenCalledTimes(1);
    expect(admin.rpc.mock.calls[0]?.[0]).toBe("fn_upsert_wa_contact");
  });

  it("eco do WhatsApp Business também não cria conversa para identidade suprimida", async () => {
    const admin = adminComSupressao();
    const event: OutboundEchoEvent = {
      kind: "outbound_echo",
      wabaId: "waba-qa",
      phoneNumberId: "phone-number-qa",
      externalId: "wamid.qa.echo",
      to: "5531999991234",
      sentAt: new Date("2026-10-28T12:00:00.000Z"),
      type: "text",
      text: "resposta de teste",
      media: null,
    };

    await expect(ingestMetaEcho(admin as never, event, owner)).resolves.toEqual({
      status: "ignored",
      reason: "titular_apagado_a_pedido",
    });
    expect(admin.rpc).toHaveBeenCalledTimes(1);
    expect(admin.rpc.mock.calls[0]?.[0]).toBe("fn_upsert_wa_contact");
  });
});
