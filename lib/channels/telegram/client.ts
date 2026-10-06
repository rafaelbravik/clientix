import type {
  TelegramApiResponse,
  TelegramMe,
  TelegramMessage,
} from "./types";

const TELEGRAM_API_BASE = "https://api.telegram.org";

function buildUrl(token: string, method: string): string {
  return `${TELEGRAM_API_BASE}/bot${token}/${method}`;
}

async function callTelegram<T>(
  token: string,
  method: string,
  body?: Record<string, unknown>,
): Promise<TelegramApiResponse<T>> {
  const url = buildUrl(token, method);
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });

  const json = (await res.json().catch(() => ({}))) as TelegramApiResponse<T>;
  return json;
}

export async function telegramGetMe(token: string): Promise<TelegramMe> {
  const res = await callTelegram<TelegramMe>(token, "getMe");
  if (!res.ok || !res.result) {
    throw new Error(res.description || `telegram_get_me_failed: ${res.error_code ?? "unknown"}`);
  }
  return res.result;
}

export async function telegramSetWebhook(
  token: string,
  url: string,
  secretToken?: string,
): Promise<boolean> {
  const res = await callTelegram<boolean>(token, "setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message", "edited_message"],
    drop_pending_updates: false,
  });

  if (!res.ok) {
    throw new Error(res.description || "telegram_set_webhook_failed");
  }
  return true;
}

export async function telegramDeleteWebhook(token: string): Promise<boolean> {
  const res = await callTelegram<boolean>(token, "deleteWebhook", {
    drop_pending_updates: false,
  });
  return res.ok;
}

export async function telegramSendMessage(
  token: string,
  chatId: string | number,
  text: string,
): Promise<TelegramMessage> {
  const res = await callTelegram<TelegramMessage>(token, "sendMessage", {
    chat_id: chatId,
    text,
  });

  if (!res.ok || !res.result) {
    throw new Error(res.description || "telegram_send_message_failed");
  }
  return res.result;
}

export async function telegramSendPhoto(
  token: string,
  chatId: string | number,
  photoUrl: string,
  caption?: string,
): Promise<TelegramMessage> {
  const res = await callTelegram<TelegramMessage>(token, "sendPhoto", {
    chat_id: chatId,
    photo: photoUrl,
    caption,
  });

  if (!res.ok || !res.result) {
    throw new Error(res.description || "telegram_send_photo_failed");
  }
  return res.result;
}

export async function telegramSendDocument(
  token: string,
  chatId: string | number,
  documentUrl: string,
  caption?: string,
): Promise<TelegramMessage> {
  const res = await callTelegram<TelegramMessage>(token, "sendDocument", {
    chat_id: chatId,
    document: documentUrl,
    caption,
  });

  if (!res.ok || !res.result) {
    throw new Error(res.description || "telegram_send_document_failed");
  }
  return res.result;
}

export async function telegramSendVoice(
  token: string,
  chatId: string | number,
  voiceUrl: string,
  caption?: string,
): Promise<TelegramMessage> {
  const res = await callTelegram<TelegramMessage>(token, "sendVoice", {
    chat_id: chatId,
    voice: voiceUrl,
    caption,
  });

  if (!res.ok || !res.result) {
    throw new Error(res.description || "telegram_send_voice_failed");
  }
  return res.result;
}
