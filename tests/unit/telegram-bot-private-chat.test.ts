import { describe, expect, it, vi } from "vitest";
import { ingestTelegramInbound } from "@/lib/channels/telegram/ingest";

describe("Telegram Bot API não aceita grupos", () => {
  it("ignora grupo antes de qualquer leitura ou escrita no banco", async () => {
    const from = vi.fn();
    const result = await ingestTelegramInbound({ from } as never, {
      organizationId: "org-a",
      channelSessionId: "telegram-bot-a",
      payload: {
        update_id: 10,
        message: {
          message_id: 2,
          date: 1_760_000_000,
          from: { id: 7, is_bot: false, first_name: "Pessoa" },
          chat: { id: -1001, type: "supergroup" },
          text: "teste",
        },
      },
    });

    expect(result).toEqual({ status: "ignored", reason: "telegram_bot_api_somente_chat_privado" });
    expect(from).not.toHaveBeenCalled();
  });
});
