/**
 * Tipos e contratos para o canal Telegram Usuário (Userbot / MTProto).
 */

export interface TelegramUserSendCodeParams {
  apiId: number;
  apiHash: string;
  phone: string;
}

export interface TelegramUserSendCodeResult {
  phoneCodeHash: string;
  isCodeViaApp: boolean;
  timeout?: number;
}

export interface TelegramUserSignInParams {
  apiId: number;
  apiHash: string;
  phone: string;
  phoneCodeHash: string;
  phoneCode: string;
}

export interface TelegramUserSignInResult {
  success: boolean;
  passwordNeeded?: boolean;
  sessionString?: string;
  user?: TelegramUserMe;
}

export interface TelegramUserCheckPasswordParams {
  apiId: number;
  apiHash: string;
  phone: string;
  password: string;
  sessionString?: string;
}

export interface TelegramUserMe {
  id: string;
  phone: string;
  firstName: string;
  lastName?: string | null;
  username?: string | null;
}

export interface TelegramUserSendMessageParams {
  to: string;
  text: string;
  replyToMsgId?: string | number;
}

export interface TelegramUserSendMediaParams {
  to: string;
  mediaUrl: string;
  caption?: string | null;
  mediaType: "image" | "audio" | "document" | "video";
}

export interface TelegramUserMessageResult {
  messageId: string;
  date: number;
}

export interface TelegramUserFloodError extends Error {
  code: "FLOOD_WAIT";
  retryAfterSeconds: number;
}
