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
 * Comunica-se com gateway HTTPS de transporte MTProto configurado em
 * `TELEGRAM_MTPROTO_GATEWAY_URL`. Trata especificamente limites de Flood do Telegram
 * (FLOOD_WAIT_X e PeerFloodError) para proteger o número contra ban.
 */

function parseFloodWait(errorMessage: string): number | null {
  const match = errorMessage.match(/FLOOD_WAIT_(\d+)/i) || errorMessage.match(/flood wait (\d+)/i);
  if (match && match[1]) {
    return parseInt(match[1], 10);
  }
  return null;
}

export class TelegramUserGatewayUnavailableError extends Error {
  readonly code = "telegram_user_gateway_unavailable";

  constructor() {
    super("Telegram User/MTProto está indisponível: configure um gateway HTTPS confiável.");
    this.name = "TelegramUserGatewayUnavailableError";
  }
}

function gatewayUrl(): string {
  const configured = process.env.TELEGRAM_MTPROTO_GATEWAY_URL?.trim();
  if (!configured) throw new TelegramUserGatewayUnavailableError();
  return configured.replace(/\/$/, "");
}

type GatewayRecord = Record<string, unknown>;

function gatewayRecord(value: unknown): GatewayRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Resposta inválida do gateway Telegram.");
  }
  return value as GatewayRecord;
}

function gatewayError(body: GatewayRecord, fallback: string): string {
  if (typeof body.error === "string" && body.error.trim()) return body.error;
  if (typeof body.message === "string" && body.message.trim()) return body.message;
  return fallback;
}

function requiredGatewayString(value: unknown, field: string): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw new Error(`Resposta inválida do gateway Telegram: ${field} ausente.`);
}

function gatewayId(value: unknown, field: string): string {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value);
  return requiredGatewayString(value, field);
}

function parseGatewayUser(value: unknown, phoneFallback?: string): TelegramUserMe {
  const user = gatewayRecord(value);
  return {
    id: gatewayId(user.id, "user.id"),
    phone: requiredGatewayString(user.phone ?? phoneFallback, "user.phone"),
    firstName: requiredGatewayString(user.first_name, "user.first_name"),
    lastName: typeof user.last_name === "string" ? user.last_name : null,
    username: typeof user.username === "string" ? user.username : null,
  };
}

function parseGatewayMessage(body: GatewayRecord): TelegramUserMessageResult {
  const messageId = gatewayId(body.id ?? body.message_id, "message.id");
  const date =
    typeof body.date === "number" && Number.isFinite(body.date)
      ? body.date
      : typeof body.date === "string" && /^\d+$/.test(body.date)
        ? Number(body.date)
        : Math.floor(Date.now() / 1000);
  return { messageId, date };
}

export function createFloodError(seconds: number): TelegramUserFloodError {
  const err = new Error(
    `FLOOD_WAIT_${seconds}: limite de envio atingido no Telegram MTProto. Aguarde ${seconds}s.`,
  ) as TelegramUserFloodError;
  err.code = "FLOOD_WAIT";
  err.retryAfterSeconds = seconds;
  return err;
}

export async function telegramUserSendCode(
  params: TelegramUserSendCodeParams,
): Promise<TelegramUserSendCodeResult> {
  const gateway = gatewayUrl();
  {
    const res = await fetch(`${gateway}/auth/sendCode`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_id: params.apiId,
        api_hash: params.apiHash,
        phone: params.phone,
      }),
    });

    const body = gatewayRecord(await res.json());
    if (!res.ok) {
      const floodSecs = parseFloodWait(gatewayError(body, ""));
      if (floodSecs) throw createFloodError(floodSecs);
      throw new Error(gatewayError(body, `sendCode falhou com status ${res.status}`));
    }

    return {
      phoneCodeHash: requiredGatewayString(body.phone_code_hash, "phone_code_hash"),
      isCodeViaApp: Boolean(body.is_code_via_app),
      ...(typeof body.timeout === "number" && Number.isFinite(body.timeout)
        ? { timeout: body.timeout }
        : {}),
    };
  }
}

export async function telegramUserSignIn(
  params: TelegramUserSignInParams,
): Promise<TelegramUserSignInResult> {
  const gateway = gatewayUrl();
  {
    const res = await fetch(`${gateway}/auth/signIn`, {
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

    const body = gatewayRecord(await res.json());
    if (!res.ok) {
      if (
        body.error === "SESSION_PASSWORD_NEEDED" ||
        (typeof body.message === "string" && body.message.includes("2FA"))
      ) {
        return {
          success: false,
          passwordNeeded: true,
          ...(typeof body.session_string === "string" && body.session_string.trim()
            ? { sessionString: body.session_string }
            : {}),
        };
      }
      const floodSecs = parseFloodWait(gatewayError(body, ""));
      if (floodSecs) throw createFloodError(floodSecs);
      throw new Error(gatewayError(body, `signIn falhou com status ${res.status}`));
    }

    return {
      success: true,
      sessionString: requiredGatewayString(body.session_string, "session_string"),
      user: parseGatewayUser(body.user, params.phone),
    };
  }
}

export async function telegramUserCheckPassword(
  params: TelegramUserCheckPasswordParams,
): Promise<TelegramUserSignInResult> {
  const gateway = gatewayUrl();
  {
    const res = await fetch(`${gateway}/auth/checkPassword`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_id: params.apiId,
        api_hash: params.apiHash,
        password: params.password,
        session_string: params.sessionString,
      }),
    });

    const body = gatewayRecord(await res.json());
    if (!res.ok) {
      const floodSecs = parseFloodWait(gatewayError(body, ""));
      if (floodSecs) throw createFloodError(floodSecs);
      throw new Error(gatewayError(body, `checkPassword falhou com status ${res.status}`));
    }

    return {
      success: true,
      sessionString: requiredGatewayString(body.session_string, "session_string"),
      user: parseGatewayUser(body.user, params.phone),
    };
  }
}

export async function telegramUserGetMe(creds: TelegramUserCredentials): Promise<TelegramUserMe> {
  const gateway = gatewayUrl();
  {
    const res = await fetch(`${gateway}/users/getMe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_id: creds.apiId,
        api_hash: creds.apiHash,
        session_string: creds.sessionString,
      }),
    });

    const body = gatewayRecord(await res.json());
    if (!res.ok) {
      throw new Error(gatewayError(body, "getMe falhou"));
    }

    return parseGatewayUser(body, creds.phone);
  }
}

export async function telegramUserSendMessage(
  creds: TelegramUserCredentials,
  params: TelegramUserSendMessageParams,
): Promise<TelegramUserMessageResult> {
  const gateway = gatewayUrl();
  {
    const res = await fetch(`${gateway}/messages/sendMessage`, {
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

    const body = gatewayRecord(await res.json());
    if (!res.ok) {
      const floodSecs = parseFloodWait(gatewayError(body, ""));
      if (floodSecs) throw createFloodError(floodSecs);
      throw new Error(gatewayError(body, "sendMessage falhou no MTProto"));
    }

    return parseGatewayMessage(body);
  }
}

export async function telegramUserSendMedia(
  creds: TelegramUserCredentials,
  params: TelegramUserSendMediaParams,
): Promise<TelegramUserMessageResult> {
  const gateway = gatewayUrl();
  {
    const res = await fetch(`${gateway}/messages/sendMedia`, {
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

    const body = gatewayRecord(await res.json());
    if (!res.ok) {
      const floodSecs = parseFloodWait(gatewayError(body, ""));
      if (floodSecs) throw createFloodError(floodSecs);
      throw new Error(gatewayError(body, "sendMedia falhou no MTProto"));
    }

    return parseGatewayMessage(body);
  }
}
