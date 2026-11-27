import { describe, expect, it, vi } from "vitest";

import {
  agruparPendenciasDeLeituraTelegram,
  extrairReciboLeituraTelegramUsuario,
  mensagensTelegramLidasAte,
  sincronizarLeituraTelegramUsuario,
  telegramMessageIdFromExternalId,
} from "./read-receipts";

describe("recibos de leitura do Telegram User", () => {
  it("agrupa mensagens pendentes por peer e conserva os limites de ID", () => {
    expect(
      agruparPendenciasDeLeituraTelegram(
        [
          { id: "c1", provider_conversation_id: "tgu:123:456" },
          { id: "c2", provider_conversation_id: "tgu:456:-789" },
          { id: "c3", provider_conversation_id: "webchat:abc" },
        ],
        [
          { conversation_id: "c1", external_id: "tgu:123:456:40" },
          { conversation_id: "c1", external_id: "tgu:123:456:42" },
          { conversation_id: "c2", external_id: "tgu:456:-789:9" },
          { conversation_id: "c3", external_id: "webchat:abc:1" },
          { conversation_id: "missing", external_id: "tgu:123:456:99" },
        ],
      ),
    ).toEqual([
      {
        peerId: "123",
        providerConversationId: "tgu:123:456",
        minMessageId: 40,
        maxMessageId: 42,
      },
      {
        peerId: "456",
        providerConversationId: "tgu:456:-789",
        minMessageId: 9,
        maxMessageId: 9,
      },
    ]);
  });

  it("extrai o peer e o limite do recibo de saída sem depender de instanceof", () => {
    expect(
      extrairReciboLeituraTelegramUsuario(true, {
        className: "UpdateReadHistoryOutbox",
        peer: { className: "PeerUser", userId: 123456 },
        maxId: 42,
      }),
    ).toEqual({ peerId: "123456", maxId: 42 });

    expect(
      extrairReciboLeituraTelegramUsuario(true, {
        className: "UpdateReadHistoryOutbox",
        peer: { className: "PeerChat", chatId: 123456 },
        maxId: 42,
      }),
    ).toBeNull();
    expect(
      extrairReciboLeituraTelegramUsuario(false, {
        className: "UpdateReadHistoryOutbox",
        peer: { className: "PeerUser", userId: 123456 },
        maxId: 42,
      }),
    ).toBeNull();
  });

  it("lê o ID do último segmento sem depender do formato do prefixo", () => {
    expect(telegramMessageIdFromExternalId("tgu:123456:987654:42")).toBe(42);
    expect(telegramMessageIdFromExternalId("tgu:123456:987654:arquivo:43")).toBe(43);
    expect(telegramMessageIdFromExternalId(null)).toBeNull();
    expect(telegramMessageIdFromExternalId("tgu:123456:sem-id")).toBeNull();
    expect(telegramMessageIdFromExternalId("tgu:123456:9007199254740992")).toBeNull();
  });

  it("considera lidas as mensagens até maxId, inclusive, sem incluir IDs posteriores", () => {
    const messages = [
      { id: "m41", external_id: "tgu:123:hash:41", status: "sent" },
      { id: "m42", external_id: "tgu:123:hash:42", status: "delivered" },
      { id: "m43", external_id: "tgu:123:hash:43", status: "sent" },
      { id: "sem-id", external_id: null, status: "sent" },
    ];

    expect(mensagensTelegramLidasAte(messages, 42).map((message) => message.id)).toEqual([
      "m41",
      "m42",
    ]);
    expect(mensagensTelegramLidasAte(messages, 0)).toEqual([]);
  });

  it("atualiza somente mensagens outbound da organização e sessão até o limite lido", async () => {
    const responses = [
      { data: [{ id: "conversation-1" }], error: null },
      {
        data: [
          { id: "message-41", external_id: "tgu:123:hash:41", status: "sent" },
          { id: "message-42", external_id: "tgu:123:hash:42", status: "delivered" },
          { id: "message-43", external_id: "tgu:123:hash:43", status: "sent" },
          { id: "already-read", external_id: "tgu:123:hash:40", status: "read" },
        ],
        error: null,
      },
      { data: [{ id: "message-41" }, { id: "message-42" }], error: null },
    ];
    const calls: Array<{ table: string; method: string; args: unknown[] }> = [];

    const admin = {
      from(table: string) {
        const response = responses.shift();
        if (!response) throw new Error("unexpected_database_query");
        const query: Record<string, unknown> & {
          then: (resolve: (value: unknown) => unknown) => Promise<unknown>;
        } = {
          then: (resolve) => Promise.resolve(response).then(resolve),
        };
        for (const method of ["select", "eq", "like", "in", "not", "update"]) {
          query[method] = vi.fn((...args: unknown[]) => {
            calls.push({ table, method, args });
            return query;
          });
        }
        return query;
      },
    };

    const result = await sincronizarLeituraTelegramUsuario(admin as never, {
      organizationId: "org-1",
      channelSessionId: "session-1",
      peerId: "123",
      maxId: 42,
      readAt: "2026-11-27T13:00:00.000Z",
    });

    expect(result).toEqual({ conversationFound: true, messageMatched: true, updated: 2 });
    expect(calls).toContainEqual({
      table: "conversations",
      method: "eq",
      args: ["organization_id", "org-1"],
    });
    expect(calls).toContainEqual({
      table: "conversations",
      method: "eq",
      args: ["channel_session_id", "session-1"],
    });
    expect(calls).toContainEqual({
      table: "messages",
      method: "eq",
      args: ["direction", "outbound"],
    });
    expect(calls).toContainEqual({
      table: "messages",
      method: "in",
      args: ["id", ["message-41", "message-42"]],
    });
    expect(calls).toContainEqual({
      table: "messages",
      method: "update",
      args: [
        {
          status: "read",
          delivered_at: "2026-11-27T13:00:00.000Z",
          read_at: "2026-11-27T13:00:00.000Z",
        },
      ],
    });
    expect(responses).toHaveLength(0);
  });
});
