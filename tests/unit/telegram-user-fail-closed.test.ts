import { afterEach, describe, expect, it, vi } from "vitest";
import {
  telegramUserCheckPassword,
  telegramUserGetMe,
  telegramUserSendCode,
  telegramUserSendMedia,
  telegramUserSendMessage,
  telegramUserSignIn,
} from "@/lib/channels/telegram-user/client";

const CREDENTIALS = {
  apiId: 123,
  apiHash: "a-valid-api-hash",
  channelSessionId: "telegram-user-session",
  sessionString: "stored-session",
  userId: "user-1",
  phone: "+5511999999999",
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("Telegram User/MTProto sem gateway", () => {
  it("falha fechado em auth, consulta e envio; não inventa código, sessão, usuário ou ACK", async () => {
    vi.stubEnv("TELEGRAM_MTPROTO_GATEWAY_URL", "");

    const unavailable = { code: "telegram_user_gateway_unavailable" };
    await expect(
      telegramUserSendCode({ apiId: 123, apiHash: "a-valid-api-hash", phone: "+5511999999999" }),
    ).rejects.toMatchObject(unavailable);
    await expect(
      telegramUserSignIn({
        apiId: 123,
        apiHash: "a-valid-api-hash",
        phone: "+5511999999999",
        phoneCodeHash: "hash",
        phoneCode: "12345",
      }),
    ).rejects.toMatchObject(unavailable);
    await expect(
      telegramUserCheckPassword({ ...CREDENTIALS, password: "password" }),
    ).rejects.toMatchObject(unavailable);
    await expect(telegramUserGetMe(CREDENTIALS)).rejects.toMatchObject(unavailable);
    await expect(
      telegramUserSendMessage(CREDENTIALS, { to: "peer-1", text: "mensagem" }),
    ).rejects.toMatchObject(unavailable);
    await expect(
      telegramUserSendMedia(CREDENTIALS, {
        to: "peer-1",
        mediaUrl: "https://cdn.example.test/file",
        caption: "arquivo",
        mediaType: "image",
      }),
    ).rejects.toMatchObject(unavailable);
  });

  it("não trata HTTP 200 sem ACK do provider como envio bem-sucedido", async () => {
    vi.stubEnv("TELEGRAM_MTPROTO_GATEWAY_URL", "https://gateway.example.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ ok: true })),
    );

    await expect(
      telegramUserSendMessage(CREDENTIALS, { to: "peer-1", text: "mensagem" }),
    ).rejects.toThrow("Resposta inválida do gateway Telegram: message.id ausente.");
    await expect(
      telegramUserSendMedia(CREDENTIALS, {
        to: "peer-1",
        mediaUrl: "https://cdn.example.test/file",
        caption: "arquivo",
        mediaType: "image",
      }),
    ).rejects.toThrow("Resposta inválida do gateway Telegram: message.id ausente.");
  });

  it("só confirma outbound depois de receber o id real da mensagem", async () => {
    vi.stubEnv("TELEGRAM_MTPROTO_GATEWAY_URL", "https://gateway.example.test");
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ id: 12345, date: 1_700_000_000 })),
    );

    await expect(
      telegramUserSendMessage(CREDENTIALS, { to: "peer-1", text: "mensagem" }),
    ).resolves.toEqual({
      messageId: "12345",
      date: 1_700_000_000,
    });
  });
});
