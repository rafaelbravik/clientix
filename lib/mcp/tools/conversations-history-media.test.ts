import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/api/v1/conversations/_handler", () => ({
  getConversationHandler: vi.fn(),
  listConversationsHandler: vi.fn(),
}));
vi.mock("@/app/api/v1/messages/_handler", () => ({ listMessagesHandler: vi.fn() }));

import { getConversationHandler } from "@/app/api/v1/conversations/_handler";
import { listMessagesHandler } from "@/app/api/v1/messages/_handler";
import type { McpContext } from "@/lib/mcp/types";

import { crmGetConversationHistory } from "./conversations";

const ORG = "11111111-1111-4111-8111-111111111111";
const CONV = "22222222-2222-4222-8222-222222222222";
const CONTACT = "33333333-3333-4333-8333-333333333333";
const PATH = `${ORG}/${CONV}/44444444-4444-4444-8444-444444444444.pdf`;

const mockedGetConversation = vi.mocked(getConversationHandler);
const mockedListMessages = vi.mocked(listMessagesHandler);

function makeContext(options: { actor?: McpContext["actor"]; contact?: string; sign?: ReturnType<typeof vi.fn> } = {}) {
  const createSignedUrl = options.sign ?? vi.fn(async () => ({
    data: { signedUrl: "https://storage.invalid/signed/neutral" },
    error: null,
  }));
  const ctx = {
    organizationId: ORG,
    role: "agent",
    actor: options.actor ?? { type: "api_token", id: "token-test" },
    ...(options.contact ? { contatoDoTurno: options.contact } : {}),
    apiTokenId: "token-test",
    requestId: "request-test",
    supabase: { storage: { from: vi.fn(() => ({ createSignedUrl })) } },
  } as unknown as McpContext;
  return { ctx, createSignedUrl };
}

const mediaMessage = {
  id: "message-1",
  direction: "inbound",
  type: "document",
  body: null,
  media_url: "https://provider.invalid/private-original",
  media_mime: "application/pdf",
  media_size_bytes: 1234,
  media_storage_path: PATH,
  metadata: { media_status: "stored" },
  sent_via: "external_device",
  sent_at: "2026-10-01T12:00:00.000Z",
  status: "received",
};

beforeEach(() => {
  mockedGetConversation.mockReset();
  mockedListMessages.mockReset();
  mockedGetConversation.mockResolvedValue({ contact_id: CONTACT } as never);
  mockedListMessages.mockResolvedValue({
    messages: [mediaMessage],
    cursor: null,
    has_more: false,
  } as never);
});

describe("crm_get_conversation_history — mídia e escopo", () => {
  it("autoriza organização/conversa antes de assinar e não devolve storage path", async () => {
    const { ctx, createSignedUrl } = makeContext();
    const result = (await crmGetConversationHistory.handler(
      { conversation_id: CONV, limit: 20, cursor: undefined } as never,
      ctx,
    )) as { messages: Array<Record<string, unknown>> };

    expect(mockedGetConversation).toHaveBeenCalledWith(
      ctx.supabase,
      expect.objectContaining({ organization_id: ORG }),
      CONV,
    );
    expect(mockedGetConversation.mock.invocationCallOrder[0]!).toBeLessThan(
      mockedListMessages.mock.invocationCallOrder[0]!,
    );
    expect(mockedListMessages.mock.invocationCallOrder[0]!).toBeLessThan(
      createSignedUrl.mock.invocationCallOrder[0]!,
    );
    expect(createSignedUrl).toHaveBeenCalledWith(PATH, 3600);
    expect(result.messages[0]).toMatchObject({
      media_mime: "application/pdf",
      media_size_bytes: 1234,
      media_status: "ready",
      media_signed_url: "https://storage.invalid/signed/neutral",
    });
    expect(result.messages[0]?.media_url).toBe("https://storage.invalid/signed/neutral");
    expect(JSON.stringify(result)).not.toContain(PATH);
    expect(JSON.stringify(result)).not.toContain("provider.invalid");
  });

  it("o contato fora do turno é recusado antes de listar ou assinar", async () => {
    mockedGetConversation.mockResolvedValue({ contact_id: "55555555-5555-4555-8555-555555555555" } as never);
    const { ctx, createSignedUrl } = makeContext({ actor: { type: "ai_agent", id: "agent-a", role: "ai_operator" }, contact: CONTACT });

    await expect(
      crmGetConversationHistory.handler(
        { conversation_id: CONV, limit: 20, cursor: undefined } as never,
        ctx,
      ),
    ).rejects.toThrow("conversation_not_found");
    expect(mockedListMessages).not.toHaveBeenCalled();
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("agente sem contato confiável não lê histórico nem recebe link", async () => {
    const { ctx, createSignedUrl } = makeContext({ actor: { type: "ai_agent", id: "agent-a", role: "ai_operator" } });
    await expect(
      crmGetConversationHistory.handler(
        { conversation_id: CONV, limit: 20, cursor: undefined } as never,
        ctx,
      ),
    ).rejects.toThrow("conversation_not_found");
    expect(mockedListMessages).not.toHaveBeenCalled();
    expect(createSignedUrl).not.toHaveBeenCalled();
  });

  it("turno do agente recebe metadados sem link bearer nem media_url legado", async () => {
    const { ctx, createSignedUrl } = makeContext({
      actor: { type: "ai_agent", id: "agent-a", role: "ai_operator" },
      contact: CONTACT,
    });
    const result = (await crmGetConversationHistory.handler(
      { conversation_id: CONV, limit: 20, cursor: undefined } as never,
      ctx,
    )) as { messages: Array<Record<string, unknown>> };

    expect(result.messages[0]).toMatchObject({
      media_status: "ready",
      media_signed_url: null,
      media_url: null,
      media_mime: "application/pdf",
      media_size_bytes: 1234,
    });
    expect(createSignedUrl).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("provider.invalid");
  });
});
