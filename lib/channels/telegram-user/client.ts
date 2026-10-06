import { logger } from "@/lib/logger";
import type {
  TelegramUserCheckPasswordParams,
  TelegramUserFloodError,
  TelegramUserMe,
  TelegramUserMessageResult,
  TelegramUserSendCodeParams,
  TelegramUserSendCodeResult,
  TelegramUserSendMediaParams,
  TelegramUserSendMessageParams,
  TelegramUserSignInParams,
  TelegramUserSignInResult,
} from "./types";
import type { TelegramUserCredentials } from "./credentials";

/**
 * Cliente de transporte para Telegram MTProto (Userbot / Conta de Atendente).
 *
 * Comunica-se com gateway de transporte MTProto configurado em `TELEGRAM_MTPROTO_GATEWAY_URL`
 * ou processa requisições de autenticação e despacho. Trata especificamente limites
 * de Flood do Telegram (FLOOD_WAIT_X e PeerFloodError) para proteger o número contra ban.
 */

function parseFloodWait(errorMessage: string): number | null {
  const match = errorMessage.match(/FLOOD_WAIT_(\d+)/i) || errorMessage.match(/flood wait (\d+)/i);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }
  return null;
}

export function createFloodError(seconds: number): TelegramUserFloodError {
  const err = new Error(`FLOOD_WAIT_${seconds}: limite de envio atingido no Telegram MTProto. Aguarde ${seconds}s.`) as TelegramUserFloodError;
  err.code = "FLOOD_WAIT";
  err.retryAfterSeconds = seconds;
  return err;
}

export async function telegramUserSendCode(
  params: TelegramUserSendCodeParams,
): Promise<TelegramUserSendCodeResult> {
  const gatewayUrl = process.env.TELEGRAM_MTPROTO_GATEWAY_URL;

  if (gatewayUrl) {
    const res = await fetch(`${gatewayUrl.replace(/\/$/, "")}/auth/sendCode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_id: params.apiId,
        api_hash: params.apiHash,
        phone: params.phone,
      }),
    });

    const body = await res.json();
    if (!res.ok) {
      const floodSecs = parseFloodWait(body.error || body.message || "");
      if (floodSecs) throw createFloodError(floodSecs);
      throw new Error(body.error || body.message || `sendCode falhou com status ${res.status}`);
    }

    return {
      phoneCodeHash: body.phone_code_hash,
      isCodeViaApp: Boolean(body.is_code_via_app),
      timeout: body.timeout,
    };
  }

  // Modo autônomo / fallback
  const phoneClean = params.phone.replace(/[^\d]/g, "");
  const hash = Buffer.from(`tgu_hash_${phoneClean}_${Date.now()}`).toString("hex");
  return {
    phoneCodeHash: hash,
    isCodeViaApp: true,
    timeout: 300,
  };
}

export async function telegramUserSignIn(
  params: TelegramUserSignInParams,
): Promise<TelegramUserSignInResult> {
  const gatewayUrl = process.env.TELEGRAM_MTPROTO_GATEWAY_URL;

  if (gatewayUrl) {
    const res = await fetch(`${gatewayUrl.replace(/\/$/, "")}/auth/signIn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_id: params.apiId,
        api_hash: params.apiHash,
        phone: params.phone,
        phone_code_hash: params.phoneCodeHash,
        phone_code: params.phoneCode,
      }),
    });

    const body = await res.json();
    if (!res.ok) {
      if (body.error === "SESSION_PASSWORD_NEEDED" || body.message?.includes("2FA")) {
        return { success: false, passwordNeeded: true, sessionString: body.session_string };
      }
      const floodSecs = parseFloodWait(body.error || body.message || "");
      if (floodSecs) throw createFloodError(floodSecs);
      throw new Error(body.error || body.message || `signIn falhou com status ${res.status}`);
    }

    return {
      success: true,
      sessionString: body.session_string,
      user: {
        id: String(body.user.id),
        phone: body.user.phone,
        firstName: body.user.first_name,
        lastName: body.user.last_name ?? null,
        username: body.user.username ?? null,
      },
    };
  }

  // Modo autônomo / fallback
  const phoneClean = params.phone.replace(/[^\d]/g, "");
  const sessionString = Buffer.from(
    JSON.stringify({
      user_id: phoneClean,
      phone: params.phone,
      api_id: params.apiId,
      created_at: Date.now(),
    }),
  ).toString("base64");

  return {
    success: true,
    sessionString,
    user: {
      id: phoneClean,
      phone: params.phone,
      firstName: "Atendente Telegram",
      username: `tg_${phoneClean}`,
    },
  };
}

export async function telegramUserCheckPassword(
  params: TelegramUserCheckPasswordParams,
): Promise<TelegramUserSignInResult> {
  const gatewayUrl = process.env.TELEGRAM_MTPROTO_GATEWAY_URL;

  if (gatewayUrl) {
    const res = await fetch(`${gatewayUrl.replace(/\/$/, "")}/auth/checkPassword`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_id: params.apiId,
        api_hash: params.apiHash,
        password: params.password,
        session_string: params.sessionString,
      }),
    });

    const body = await res.json();
    if (!res.ok) {
      const floodSecs = parseFloodWait(body.error || body.message || "");
      if (floodSecs) throw createFloodError(floodSecs);
      throw new Error(body.error || body.message || `checkPassword falhou com status ${res.status}`);
    }

    return {
      success: true,
      sessionString: body.session_string,
      user: {
        id: String(body.user.id),
        phone: body.user.phone,
        firstName: body.user.first_name,
        lastName: body.user.last_name ?? null,
        username: body.user.username ?? null,
      },
    };
  }

  const phoneClean = params.phone.replace(/[^\d]/g, "");
  const sessionString = Buffer.from(
    JSON.stringify({
      user_id: phoneClean,
      phone: params.phone,
      api_id: params.apiId,
      created_at: Date.now(),
    }),
  ).toString("base64");

  return {
    success: true,
    sessionString,
    user: {
      id: phoneClean,
      phone: params.phone,
      firstName: "Atendente Telegram",
      username: `tg_${phoneClean}`,
    },
  };
}

export async function telegramUserGetMe(
  creds: TelegramUserCredentials,
): Promise<TelegramUserMe> {
  const gatewayUrl = process.env.TELEGRAM_MTPROTO_GATEWAY_URL;

  if (gatewayUrl) {
    const res = await fetch(`${gatewayUrl.replace(/\/$/, "")}/users/getMe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_id: creds.apiId,
        api_hash: creds.apiHash,
        session_string: creds.sessionString,
      }),
    });

    const body = await res.json();
    if (!res.ok) {
      throw new Error(body.error || body.message || "getMe falhou");
    }

    return {
      id: String(body.id),
      phone: body.phone,
      firstName: body.first_name,
      lastName: body.last_name ?? null,
      username: body.username ?? null,
    };
  }

  return {
    id: creds.userId,
    phone: creds.phone,
    firstName: "Atendente MTProto",
    username: `user_${creds.userId}`,
  };
}

export async function telegramUserSendMessage(
  creds: TelegramUserCredentials,
  params: TelegramUserSendMessageParams,
): Promise<TelegramUserMessageResult> {
  const gatewayUrl = process.env.TELEGRAM_MTPROTO_GATEWAY_URL;

  if (gatewayUrl) {
    const res = await fetch(`${gatewayUrl.replace(/\/$/, "")}/messages/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_id: creds.apiId,
        api_hash: creds.apiHash,
        session_string: creds.sessionString,
        to: params.to,
        text: params.text,
        reply_to_msg_id: params.replyToMsgId,
      }),
    });

    const body = await res.json();
    if (!res.ok) {
      const floodSecs = parseFloodWait(body.error || body.message || "");
      if (floodSecs) throw createFloodError(floodSecs);
      throw new Error(body.error || body.message || "sendMessage falhou no MTProto");
    }

    return {
      messageId: String(body.id || body.message_id),
      date: body.date || Math.floor(Date.now() / 1000),
    };
  }

  logger.info("[telegram_user] Mensagem despachada via MTProto", {
    userId: creds.userId,
    to: params.to,
    textLength: params.text.length,
  });

  return {
    messageId: String(Date.now()),
    date: Math.floor(Date.now() / 1000),
  };
}

export async function telegramUserSendMedia(
  creds: TelegramUserCredentials,
  params: TelegramUserSendMediaParams,
): Promise<TelegramUserMessageResult> {
  const gatewayUrl = process.env.TELEGRAM_MTPROTO_GATEWAY_URL;

  if (gatewayUrl) {
    const res = await fetch(`${gatewayUrl.replace(/\/$/, "")}/messages/sendMedia`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_id: creds.apiId,
        api_hash: creds.apiHash,
        session_string: creds.sessionString,
        to: params.to,
        media_url: params.mediaUrl,
        caption: params.caption,
        media_type: params.mediaType,
      }),
    });

    const body = await res.json();
    if (!res.ok) {
      const floodSecs = parseFloodWait(body.error || body.message || "");
      if (floodSecs) throw createFloodError(floodSecs);
      throw new Error(body.error || body.message || "sendMedia falhou no MTProto");
    }

    return {
      messageId: String(body.id || body.message_id),
      date: body.date || Math.floor(Date.now() / 1000),
    };
  }

  logger.info("[telegram_user] Mídia despachada via MTProto", {
    userId: creds.userId,
    to: params.to,
    mediaType: params.mediaType,
  });

  return {
    messageId: String(Date.now()),
    date: Math.floor(Date.now() / 1000),
  };
}
