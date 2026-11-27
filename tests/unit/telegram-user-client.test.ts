import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as TeleprotoModule from "teleproto";

const mocks = vi.hoisted(() => ({
  sessionString: "saved-session",
  connect: vi.fn(),
  disconnect: vi.fn(),
  sendCode: vi.fn(),
  invoke: vi.fn(),
  checkAuthorization: vi.fn(),
  getMe: vi.fn(),
  signInWithPassword: vi.fn(),
  sendMessage: vi.fn(),
  sendFile: vi.fn(),
  getMessages: vi.fn(),
  downloadMedia: vi.fn(),
  editMessage: vi.fn(),
  deleteMessages: vi.fn(),
}));

vi.mock("teleproto", async (importOriginal) => {
  const actual = await importOriginal<typeof TeleprotoModule>();
  class MockTelegramClient {
    session = { save: () => mocks.sessionString };
    connect = mocks.connect;
    disconnect = mocks.disconnect;
    sendCode = mocks.sendCode;
    invoke = mocks.invoke;
    checkAuthorization = mocks.checkAuthorization;
    getMe = mocks.getMe;
    signInWithPassword = mocks.signInWithPassword;
    sendMessage = mocks.sendMessage;
    sendFile = mocks.sendFile;
    getMessages = mocks.getMessages;
    downloadMedia = mocks.downloadMedia;
    editMessage = mocks.editMessage;
    deleteMessages = mocks.deleteMessages;
  }
  return { ...actual, TelegramClient: MockTelegramClient };
});

vi.mock("teleproto/sessions", () => ({
  StringSession: class MockStringSession {},
}));

import {
  telegramUserCheckPassword,
  telegramUserEditMessage,
  telegramUserFetchMedia,
  telegramUserRevokeMessage,
  telegramUserSendCode,
  telegramUserSendMedia,
  telegramUserSendMessage,
  telegramUserSignIn,
} from "@/lib/channels/telegram-user/client";

const CREDS = {
  channelSessionId: "channel-session",
  userId: "telegram-user-1",
  phone: "+5511999990000",
  apiId: 123456,
  apiHash: "abcdef1234567890abcdef1234567890",
  sessionString: "session-string",
};

const SENDER = {
  className: "User",
  id: { toString: () => "12345" },
  phone: "+5511999990000",
  firstName: "Clientix",
  lastName: "Teste",
  username: "clientix_test",
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.connect.mockResolvedValue(undefined);
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.sendCode.mockResolvedValue({ phoneCodeHash: "code-hash", isCodeViaApp: true });
  mocks.invoke.mockResolvedValue(undefined);
  mocks.checkAuthorization.mockResolvedValue(true);
  mocks.getMe.mockResolvedValue(SENDER);
  mocks.signInWithPassword.mockResolvedValue(SENDER);
  mocks.sendMessage.mockResolvedValue({ className: "Message", id: 321, date: 1_700_000_000 });
  mocks.sendFile.mockResolvedValue({ className: "Message", id: 322, date: 1_700_000_001 });
  mocks.getMessages.mockResolvedValue([
    { className: "Message", media: { className: "MessageMediaPhoto" } },
  ]);
  mocks.downloadMedia.mockResolvedValue(Buffer.from("telegram-media"));
  mocks.editMessage.mockResolvedValue({ className: "Message" });
  mocks.deleteMessages.mockResolvedValue([]);
});

describe("cliente Telegram MTProto", () => {
  it("solicita o código e mantém a sessão temporária necessária para continuar o login", async () => {
    await expect(
      telegramUserSendCode({
        apiId: CREDS.apiId,
        apiHash: CREDS.apiHash,
        phone: CREDS.phone,
      }),
    ).resolves.toEqual({
      phoneCodeHash: "code-hash",
      isCodeViaApp: true,
      sessionString: "saved-session",
    });
  });

  it("pede a senha 2FA sem tratar a tentativa como login concluído", async () => {
    const passwordNeeded = Object.assign(new Error("SESSION_PASSWORD_NEEDED"), {
      name: "SessionPasswordNeededError",
    });
    mocks.invoke.mockRejectedValueOnce(passwordNeeded);

    await expect(
      telegramUserSignIn({
        apiId: CREDS.apiId,
        apiHash: CREDS.apiHash,
        phone: CREDS.phone,
        phoneCodeHash: "code-hash",
        phoneCode: "12345",
        sessionString: "temporary-session",
      }),
    ).resolves.toEqual({
      success: false,
      passwordNeeded: true,
      sessionString: "saved-session",
    });
    expect(mocks.checkAuthorization).not.toHaveBeenCalled();
  });

  it("finaliza login por código e por senha 2FA com dados reais do usuário retornados pelo SDK", async () => {
    await expect(
      telegramUserSignIn({
        apiId: CREDS.apiId,
        apiHash: CREDS.apiHash,
        phone: CREDS.phone,
        phoneCodeHash: "code-hash",
        phoneCode: "12345",
        sessionString: "temporary-session",
      }),
    ).resolves.toMatchObject({
      success: true,
      sessionString: "saved-session",
      user: { id: "12345", phone: CREDS.phone, firstName: "Clientix" },
    });

    await expect(
      telegramUserCheckPassword({
        apiId: CREDS.apiId,
        apiHash: CREDS.apiHash,
        phone: CREDS.phone,
        password: "password",
        sessionString: "temporary-session",
      }),
    ).resolves.toMatchObject({
      success: true,
      sessionString: "saved-session",
      user: { id: "12345", phone: CREDS.phone },
    });
  });

  it("envia texto e mídia para o peer com access hash e devolve o id real", async () => {
    await expect(
      telegramUserSendMessage(CREDS, { to: "tgu:12345:987654", text: "Olá" }),
    ).resolves.toEqual({ messageId: "321", date: 1_700_000_000 });
    await expect(
      telegramUserSendMedia(CREDS, {
        to: "tgu:12345:987654",
        mediaUrl: "https://storage.example.test/signed-file",
        caption: "arquivo",
        mediaType: "document",
      }),
    ).resolves.toEqual({ messageId: "322", date: 1_700_000_001 });
    expect(mocks.sendMessage).toHaveBeenCalledOnce();
    expect(mocks.sendFile).toHaveBeenCalledOnce();
  });

  it("não aceita URL HTTP como mídia de saída", async () => {
    await expect(
      telegramUserSendMedia(CREDS, {
        to: "tgu:12345:987654",
        mediaUrl: "http://storage.example.test/file",
        mediaType: "image",
      }),
    ).rejects.toThrow("telegram_media_url_invalid");
    expect(mocks.sendFile).not.toHaveBeenCalled();
  });

  it("baixa mídia pelo peer completo e impede ultrapassar o limite de tamanho", async () => {
    await expect(telegramUserFetchMedia(CREDS, "tgu:12345:987654", "88")).resolves.toMatchObject({
      mime: "image/jpeg",
      buffer: Buffer.from("telegram-media"),
    });
    expect(mocks.getMessages).toHaveBeenCalledWith(
      expect.objectContaining({ className: "InputPeerUser" }),
      { ids: 88 },
    );
  });

  it("edita e revoga apenas mensagem pertencente ao peer indicado", async () => {
    await telegramUserEditMessage(CREDS, {
      to: "tgu:12345:987654",
      externalId: "tgu:12345:987654:321",
      text: "Atualizado",
    });
    await telegramUserRevokeMessage(CREDS, {
      to: "tgu:12345:987654",
      externalId: "tgu:12345:987654:321",
    });
    expect(mocks.editMessage).toHaveBeenCalledWith(
      expect.objectContaining({ className: "InputPeerUser" }),
      { message: 321, text: "Atualizado" },
    );
    expect(mocks.deleteMessages).toHaveBeenCalledWith(
      expect.objectContaining({ className: "InputPeerUser" }),
      [321],
      { revoke: true },
    );
    await expect(
      telegramUserEditMessage(CREDS, {
        to: "tgu:12345:987654",
        externalId: "tgu:99999:987654:321",
        text: "Não deve editar outro peer",
      }),
    ).rejects.toThrow("telegram_message_reference_invalid");
  });

  it("converte FloodWait da biblioteca em erro recuperável com intervalo", async () => {
    mocks.sendMessage.mockRejectedValueOnce(Object.assign(new Error("flood"), { seconds: 47 }));
    await expect(
      telegramUserSendMessage(CREDS, { to: "tgu:12345:987654", text: "Olá" }),
    ).rejects.toMatchObject({ code: "FLOOD_WAIT", retryAfterSeconds: 47 });
  });
});
