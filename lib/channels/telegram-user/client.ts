import { Api, TelegramClient, utils } from "teleproto";
import { StringSession } from "teleproto/sessions";

import type { TelegramUserCredentials } from "./credentials";
import type {
  TelegramUserCheckPasswordParams,
  TelegramUserFloodError,
  TelegramUserMediaResult,
  TelegramUserMe,
  TelegramUserMessageResult,
  TelegramUserSendCodeParams,
  TelegramUserSendCodeResult,
  TelegramUserSendMediaParams,
  TelegramUserSendMessageParams,
  TelegramUserSignInParams,
  TelegramUserSignInResult,
} from "./types";
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";

const CONNECTION_OPTIONS = {
  connectionRetries: 3,
  requestRetries: 2,
  reconnectRetries: 3,
  retryDelay: 1_000,
  timeout: 20,
  autoReconnect: false,
  sequentialUpdates: true,
} as const;

function createClient(apiId: number, apiHash: string, sessionString = ""): TelegramClient {
  return new TelegramClient(new StringSession(sessionString), apiId, apiHash, CONNECTION_OPTIONS);
}

function saveSession(client: TelegramClient): string {
  const session = client.session.save();
  if (typeof session !== "string" || session.length === 0) {
    throw new Error("telegram_session_unavailable");
  }
  return session;
}

export function createTelegramUserClient(creds: TelegramUserCredentials): TelegramClient {
  return createClient(creds.apiId, creds.apiHash, creds.sessionString);
}

async function withClient<T>(
  apiId: number,
  apiHash: string,
  sessionString: string,
  operation: (client: TelegramClient) => Promise<T>,
): Promise<T> {
  const client = createClient(apiId, apiHash, sessionString);
  try {
    await client.connect();
    return await operation(client);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

function floodWaitSeconds(error: unknown): number | null {
  if (error && typeof error === "object" && "seconds" in error) {
    const seconds = Number(error.seconds);
    if (Number.isFinite(seconds) && seconds > 0) return seconds;
  }
  const message = error instanceof Error ? error.message : String(error);
  const match = message.match(/(?:FLOOD(?:_PREMIUM)?_WAIT_(\d+)|wait of (\d+) seconds)/i);
  const seconds = match?.[1] ?? match?.[2];
  return seconds ? Number(seconds) : null;
}

export function createFloodError(seconds: number): TelegramUserFloodError {
  const err = new Error(
    `O Telegram pediu uma pausa de ${seconds} segundos antes de novas mensagens.`,
  ) as TelegramUserFloodError;
  err.code = "FLOOD_WAIT";
  err.retryAfterSeconds = seconds;
  return err;
}

function throwIfFlood(error: unknown): never {
  const seconds = floodWaitSeconds(error);
  if (seconds !== null) throw createFloodError(seconds);
  throw error;
}

function isPasswordNeeded(error: unknown): boolean {
  if (error instanceof Error && error.name === "SessionPasswordNeededError") return true;
  return String(error).toUpperCase().includes("SESSION_PASSWORD_NEEDED");
}

function toUser(user: Api.TypeUser | undefined, phoneFallback: string): TelegramUserMe {
  if (!user || user.className !== "User") throw new Error("telegram_user_unavailable");
  return {
    id: user.id.toString(),
    phone: user.phone ?? phoneFallback,
    firstName: user.firstName ?? "Telegram",
    lastName: user.lastName ?? null,
    username: user.username ?? null,
  };
}

function peerFromReference(reference: string): Api.InputPeerUser {
  const match = /^tgu:(\d+):(-?\d+)$/.exec(reference);
  if (!match?.[1] || !match[2]) throw new Error("telegram_user_peer_unavailable");
  const userId = utils.parseID(match[1]);
  const accessHash = utils.parseID(match[2]);
  if (!userId || !accessHash) throw new Error("telegram_user_peer_unavailable");
  return new Api.InputPeerUser({ userId, accessHash });
}

function messageResult(message: Api.Message): TelegramUserMessageResult {
  return { messageId: String(message.id), date: message.date };
}

export async function telegramUserSendCode(
  params: TelegramUserSendCodeParams,
): Promise<TelegramUserSendCodeResult> {
  const client = createClient(params.apiId, params.apiHash);
  try {
    await client.connect();
    const sent = await client.sendCode(
      { apiId: params.apiId, apiHash: params.apiHash },
      params.phone,
    );
    return {
      phoneCodeHash: sent.phoneCodeHash,
      isCodeViaApp: sent.isCodeViaApp,
      ...(sent.emailRequired ? { emailRequired: true } : {}),
      sessionString: saveSession(client),
    };
  } catch (error) {
    throwIfFlood(error);
  } finally {
    await client.disconnect().catch(() => undefined);
  }
}

export async function telegramUserSignIn(
  params: TelegramUserSignInParams,
): Promise<TelegramUserSignInResult> {
  return withClient(params.apiId, params.apiHash, params.sessionString, async (client) => {
    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber: params.phone,
          phoneCodeHash: params.phoneCodeHash,
          phoneCode: params.phoneCode,
        }),
      );
    } catch (error) {
      if (isPasswordNeeded(error)) {
        return {
          success: false,
          passwordNeeded: true,
          sessionString: saveSession(client),
        };
      }
      throwIfFlood(error);
    }

    if (!(await client.checkAuthorization())) throw new Error("telegram_authorization_incomplete");
    return {
      success: true,
      sessionString: saveSession(client),
      user: toUser(await client.getMe(), params.phone),
    };
  });
}

export async function telegramUserCheckPassword(
  params: TelegramUserCheckPasswordParams,
): Promise<TelegramUserSignInResult> {
  if (!params.sessionString) throw new Error("telegram_session_required");
  return withClient(params.apiId, params.apiHash, params.sessionString, async (client) => {
    try {
      await client.signInWithPassword(
        { apiId: params.apiId, apiHash: params.apiHash },
        {
          password: async () => params.password,
          onError: (error) => {
            throw error;
          },
        },
      );
    } catch (error) {
      throwIfFlood(error);
    }

    if (!(await client.checkAuthorization())) throw new Error("telegram_authorization_incomplete");
    return {
      success: true,
      sessionString: saveSession(client),
      user: toUser(await client.getMe(), params.phone),
    };
  });
}

export async function telegramUserGetMe(creds: TelegramUserCredentials): Promise<TelegramUserMe> {
  return withClient(creds.apiId, creds.apiHash, creds.sessionString, async (client) => {
    if (!(await client.checkAuthorization())) throw new Error("telegram_session_expired");
    return toUser(await client.getMe(), creds.phone);
  });
}

export async function telegramUserSendMessage(
  creds: TelegramUserCredentials,
  params: TelegramUserSendMessageParams,
): Promise<TelegramUserMessageResult> {
  return withClient(creds.apiId, creds.apiHash, creds.sessionString, async (client) => {
    if (!(await client.checkAuthorization())) throw new Error("telegram_session_expired");
    try {
      const sent = await client.sendMessage(peerFromReference(params.to), {
        message: params.text,
      });
      if (!sent || sent.className !== "Message") throw new Error("telegram_send_ack_missing");
      return messageResult(sent);
    } catch (error) {
      throwIfFlood(error);
    }
  });
}

export async function telegramUserSendMedia(
  creds: TelegramUserCredentials,
  params: TelegramUserSendMediaParams,
): Promise<TelegramUserMessageResult> {
  return withClient(creds.apiId, creds.apiHash, creds.sessionString, async (client) => {
    if (!(await client.checkAuthorization())) throw new Error("telegram_session_expired");
    let mediaUrl: URL;
    try {
      mediaUrl = new URL(params.mediaUrl);
    } catch {
      throw new Error("telegram_media_url_invalid");
    }
    if (mediaUrl.protocol !== "https:" || mediaUrl.username || mediaUrl.password) {
      throw new Error("telegram_media_url_invalid");
    }

    try {
      const sent = await client.sendFile(peerFromReference(params.to), {
        file: mediaUrl.toString(),
        caption: params.caption ?? undefined,
        forceDocument: params.mediaType === "document",
      });
      if (!sent || sent.className !== "Message") throw new Error("telegram_send_ack_missing");
      return messageResult(sent);
    } catch (error) {
      throwIfFlood(error);
    }
  });
}

export async function telegramUserFetchMedia(
  creds: TelegramUserCredentials,
  peerReference: string,
  messageId: string,
): Promise<TelegramUserMediaResult> {
  let peer: Api.InputPeerUser;
  try {
    peer = peerFromReference(peerReference);
  } catch {
    throw new Error("telegram_media_reference_invalid");
  }
  const numericMessageId = Number(messageId);
  if (!Number.isSafeInteger(numericMessageId) || numericMessageId <= 0) {
    throw new Error("telegram_media_reference_invalid");
  }

  return withClient(creds.apiId, creds.apiHash, creds.sessionString, async (client) => {
    if (!(await client.checkAuthorization())) throw new Error("telegram_session_expired");
    const messages = await client.getMessages(peer, { ids: numericMessageId });
    const message = messages[0];
    if (!message?.media) throw new Error("telegram_media_missing");
    const content = await client.downloadMedia(message);
    if (!Buffer.isBuffer(content) || content.length === 0) throw new Error("telegram_media_empty");
    if (content.length > MAX_MEDIA_BYTES) throw new Error("telegram_media_too_large");
    const document =
      message.media.className === "MessageMediaDocument" ? message.media.document : undefined;
    if (document?.className === "Document" && Number(document.size) > MAX_MEDIA_BYTES) {
      throw new Error("telegram_media_too_large");
    }
    const mime =
      document?.className === "Document"
        ? document.mimeType || "application/octet-stream"
        : message.media.className === "MessageMediaPhoto"
          ? "image/jpeg"
          : "application/octet-stream";
    return { buffer: content, mime };
  });
}

function messageIdFromExternalId(externalId: string, recipient: string): number {
  if (!externalId.startsWith(`${recipient}:`)) {
    throw new Error("telegram_message_reference_invalid");
  }
  const messageId = Number(externalId.slice(recipient.length + 1));
  if (!Number.isSafeInteger(messageId) || messageId <= 0) {
    throw new Error("telegram_message_reference_invalid");
  }
  return messageId;
}

export async function telegramUserEditMessage(
  creds: TelegramUserCredentials,
  params: { to: string; externalId: string; text: string },
): Promise<void> {
  await withClient(creds.apiId, creds.apiHash, creds.sessionString, async (client) => {
    if (!(await client.checkAuthorization())) throw new Error("telegram_session_expired");
    const messageId = messageIdFromExternalId(params.externalId, params.to);
    await client.editMessage(peerFromReference(params.to), {
      message: messageId,
      text: params.text,
    });
  });
}

export async function telegramUserRevokeMessage(
  creds: TelegramUserCredentials,
  params: { to: string; externalId: string },
): Promise<void> {
  await withClient(creds.apiId, creds.apiHash, creds.sessionString, async (client) => {
    if (!(await client.checkAuthorization())) throw new Error("telegram_session_expired");
    const messageId = messageIdFromExternalId(params.externalId, params.to);
    await client.deleteMessages(peerFromReference(params.to), [messageId], { revoke: true });
  });
}
