import { describe, it, expect } from "vitest";
import { telegramAdapter } from "@/lib/channels/adapters/telegram";
import { CHANNEL_CAPABILITIES, CHANNEL_PROVIDER_TELEGRAM } from "@/lib/channels/capabilities";
import { resolveSessionRef } from "@/lib/channels/session-ref";
import { CANAIS_DE_CONVERSA, ehCanalDeConversa } from "@/lib/channels/canais-de-conversa";
import { verifyInboundWebhookSignature, acceptsInboundWebhook } from "@/lib/channels/inbound";

describe("Canal Telegram Bot Oficial - Adapter e Configurações", () => {
  it("deve resolver destinatário para chat_id de Telegram e identidades sociais", () => {
    expect(
      telegramAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: "telegram:987654321",
      }),
    ).toBe("987654321");

    expect(
      telegramAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "123456789",
        waIdentity: null,
      }),
    ).toBe("123456789");

    expect(
      telegramAdapter.resolveRecipient({
        isGroup: true,
        groupChatId: "-100123456789",
        phoneNumber: null,
        waIdentity: null,
      }),
    ).toBe("-100123456789");

    expect(
      telegramAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: null,
      }),
    ).toBeNull();
  });

  it("deve possuir capabilities condizentes com a Telegram Bot API", () => {
    const caps = CHANNEL_CAPABILITIES.telegram;
    expect(caps).toBeDefined();
    expect(caps.freeformOutsideWindow).toBe(true);
    expect(caps.requiresTemplates).toBe(false);
    expect(caps.canManageTemplates).toBe(false);
    expect(caps.banRisk).toBe(false);
    expect(caps.costPerMessage).toBe(false);
    expect(caps.alteraMensagemEnviada).toBe(true);
  });

  it("deve reconhecer telegram como canal de conversa válido", () => {
    expect(CANAIS_DE_CONVERSA).toContain("telegram");
    expect(ehCanalDeConversa("telegram")).toBe(true);
    expect(ehCanalDeConversa("whatsapp")).toBe(true);
  });

  it("deve resolver sessionRef a partir de telegram_bot_id", () => {
    const ref = resolveSessionRef({
      provider: "telegram",
      telegram_bot_id: "bot_123456",
    });
    expect(ref).toBe("bot_123456");
  });

  it("deve validar assinatura do webhook usando o header de segredo do Telegram", () => {
    expect(acceptsInboundWebhook("telegram")).toBe(true);

    const secretValido = "secret_token_1234567890abcdef";
    const headersCorretos = new Headers({
      "x-telegram-bot-api-secret-token": secretValido,
    });
    const headersErrados = new Headers({
      "x-telegram-bot-api-secret-token": "secret_incorreto_xyz123",
    });

    expect(
      verifyInboundWebhookSignature("telegram", "{}", headersCorretos, secretValido),
    ).toBe(true);

    expect(
      verifyInboundWebhookSignature("telegram", "{}", headersErrados, secretValido),
    ).toBe(false);

    expect(
      verifyInboundWebhookSignature("telegram", "{}", new Headers(), secretValido),
    ).toBe(false);
  });
});
