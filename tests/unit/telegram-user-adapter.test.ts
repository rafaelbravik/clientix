import { describe, it, expect, vi } from "vitest";
import { telegramUserAdapter } from "@/lib/channels/adapters/telegram-user";
import { CHANNEL_CAPABILITIES, CHANNEL_PROVIDER_TELEGRAM_USER } from "@/lib/channels/capabilities";
import { resolveSessionRef } from "@/lib/channels/session-ref";
import { channelBrand } from "@/lib/channels/presentation";
import { getAdapter } from "@/lib/channels";
import {
  createFloodError,
  telegramUserSendCode,
  telegramUserSignIn,
  telegramUserCheckPassword,
} from "@/lib/channels/telegram-user/client";

describe("Canal Telegram Usuário (MTProto) - Adapter e Capabilities", () => {
  it("deve resolver destinatário para id numérico ou identidade social", () => {
    expect(
      telegramUserAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: "telegram:user:99887766",
      }),
    ).toBe("99887766");

    expect(
      telegramUserAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "+5511999998888",
        waIdentity: null,
      }),
    ).toBe("5511999998888");

    expect(
      telegramUserAdapter.resolveRecipient({
        isGroup: true,
        groupChatId: "-10099887766",
        phoneNumber: null,
        waIdentity: null,
      }),
    ).toBe("-10099887766");

    expect(
      telegramUserAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: null,
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
    expect(err.message).toContain("42s");
  });

  it("deve executar o fluxo de autenticação pelas respostas do gateway HTTPS", async () => {
    const gatewayCalls: string[] = [];
    vi.stubEnv("TELEGRAM_MTPROTO_GATEWAY_URL", "https://telegram-gateway.example.test");
    vi.stubGlobal(
      "fetch",
      async (input: RequestInfo | URL): Promise<Response> => {
        const url = String(input);
        gatewayCalls.push(url);

        const responseByEndpoint: Record<string, object> = {
          "/auth/sendCode": { phone_code_hash: "hash-123", is_code_via_app: true },
          "/auth/signIn": {
            session_string: "session-after-code",
            user: {
              id: 12345,
              phone: "+5511999990000",
              first_name: "Clientix",
              last_name: null,
              username: "clientix-user",
            },
          },
          "/auth/checkPassword": {
            session_string: "session-after-2fa",
            user: {
              id: 12345,
              phone: "+5511999990000",
              first_name: "Clientix",
              last_name: null,
              username: "clientix-user",
            },
          },
        };
        const endpoint = new URL(url).pathname;
        return new Response(JSON.stringify(responseByEndpoint[endpoint]), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      },
    );

    try {
      const sendResult = await telegramUserSendCode({
        apiId: 123456,
        apiHash: "abcdef1234567890abcdef",
        phone: "+5511999990000",
      });
      expect(sendResult.phoneCodeHash).toBe("hash-123");
      expect(sendResult.isCodeViaApp).toBe(true);

      const loginResult = await telegramUserSignIn({
        apiId: 123456,
        apiHash: "abcdef1234567890abcdef",
        phone: "+5511999990000",
        phoneCodeHash: sendResult.phoneCodeHash,
        phoneCode: "12345",
      });
      expect(loginResult.success).toBe(true);
      expect(loginResult.sessionString).toBe("session-after-code");
      expect(loginResult.user?.id).toBe("12345");

      const pwdResult = await telegramUserCheckPassword({
        apiId: 123456,
        apiHash: "abcdef1234567890abcdef",
        phone: "+5511999990000",
        password: "secret_password",
      });
      expect(pwdResult.success).toBe(true);
      expect(pwdResult.sessionString).toBe("session-after-2fa");
      expect(gatewayCalls.map((url) => new URL(url).pathname)).toEqual([
        "/auth/sendCode",
        "/auth/signIn",
        "/auth/checkPassword",
      ]);
    } finally {
      vi.unstubAllGlobals();
      vi.unstubAllEnvs();
    }
  });
});
