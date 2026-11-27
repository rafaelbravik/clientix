import { describe, it, expect } from "vitest";
import { telegramUserAdapter } from "@/lib/channels/adapters/telegram-user";
import { CHANNEL_CAPABILITIES } from "@/lib/channels/capabilities";
import { resolveSessionRef } from "@/lib/channels/session-ref";
import { channelBrand } from "@/lib/channels/presentation";
import { getAdapter } from "@/lib/channels";
import { createFloodError } from "@/lib/channels/telegram-user/client";

describe("Canal Telegram Usuário (MTProto) - Adapter e Capabilities", () => {
  it("endereça somente conversas privadas com peer MTProto completo", () => {
    expect(
      telegramUserAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: "telegram:user:99887766",
        providerConversationId: "tgu:99887766:123456",
      }),
    ).toBe("tgu:99887766:123456");

    expect(
      telegramUserAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "+5511999998888",
        waIdentity: null,
        providerConversationId: null,
      }),
    ).toBeNull();

    expect(
      telegramUserAdapter.resolveRecipient({
        isGroup: true,
        groupChatId: "-10099887766",
        phoneNumber: null,
        waIdentity: null,
        providerConversationId: "tgu:99887766:123456",
      }),
    ).toBeNull();

    expect(
      telegramUserAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: null,
        providerConversationId: null,
      }),
    ).toBeNull();
  });

  it("deve declarar capabilities específicas para Userbot MTProto (anti-flood e banRisk)", () => {
    const caps = CHANNEL_CAPABILITIES.telegram_user;
    expect(caps).toBeDefined();
    expect(caps.freeformOutsideWindow).toBe(true);
    expect(caps.requiresTemplates).toBe(false);
    expect(caps.canManageTemplates).toBe(false);
    expect(caps.banRisk).toBe(true);
    expect(caps.minIntervalMs).toBe(3000);
    expect(caps.voiceNote).toBe("server-convert");
    expect(caps.alteraMensagemEnviada).toBe(true);
    expect(caps.groups).toBe("none");
  });

  it("deve resolver sessionRef a partir de telegram_user_id", () => {
    const ref = resolveSessionRef({
      provider: "telegram_user",
      telegram_user_id: "user_551199999",
    });
    expect(ref).toBe("user_551199999");
  });

  it("deve mapear marca visual do canal para telegram", () => {
    expect(channelBrand({ provider: "telegram_user" })).toBe("telegram");
  });

  it("deve retornar o telegramUserAdapter através de getAdapter", () => {
    const adapter = getAdapter("telegram_user");
    expect(adapter).toBe(telegramUserAdapter);
    expect(adapter.provider).toBe("telegram_user");
  });

  it("deve estruturar erro de flood com código e tempo de espera", () => {
    const err = createFloodError(42);
    expect(err.code).toBe("FLOOD_WAIT");
    expect(err.retryAfterSeconds).toBe(42);
    expect(err.message).toContain("42 segundos");
  });
});
