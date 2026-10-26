import type { WahaClient } from "@/lib/waha/client";
import { parseChatId, resolveMessageType } from "@/lib/waha/ingest";
import type { WahaPayload } from "@/lib/waha/envelope";
import { timestampHistorico } from "@/lib/channels/historico/mapear";

export interface PreviaHistorico {
  range_days: number;
  range_start: string;
  conversations: number;
  messages: number;
  audios: number;
  images: number;
  partial: boolean;
}

const CHAT_PAGE = 50;
const MESSAGE_PAGE = 100;
const MAX_MESSAGES_PER_CHAT = 100;
export const MAX_PREVIEW_CALLS = 8;
const PREVIEW_REQUEST_TIMEOUT_MS = 5_000;

function isDirectAddress(chatId: string): boolean {
  const kind = parseChatId(chatId).kind;
  return kind === "phone" || kind === "lid";
}

function countableMessage(message: WahaPayload, from: number, until: number): boolean {
  const timestamp = timestampHistorico(message.timestamp);
  const instant = timestamp ? Date.parse(timestamp) : Number.NaN;
  return Boolean(message.id?.trim())
    && typeof message.fromMe === "boolean"
    && Number.isFinite(instant)
    && instant >= from
    && instant <= until;
}

/** Read-only provider estimate. A bounded scan is marked partial when needed. */
export async function calcularPreviaHistorico(
  waha: Pick<WahaClient, "listarChatsHistorico" | "listarMensagensHistorico">,
  session: string,
  rangeDays: number,
  opts: { now?: number; maxCalls?: number } = {},
): Promise<PreviaHistorico> {
  const now = opts.now ?? Date.now();
  const rangeStart = now - rangeDays * 86_400_000;
  const sinceSeconds = Math.floor(rangeStart / 1000);
  const until = now + 5 * 60_000;
  const maxCalls = Math.max(1, Math.min(opts.maxCalls ?? MAX_PREVIEW_CALLS, MAX_PREVIEW_CALLS));
  const result: PreviaHistorico = {
    range_days: rangeDays,
    range_start: new Date(rangeStart).toISOString(),
    conversations: 0,
    messages: 0,
    audios: 0,
    images: 0,
    partial: false,
  };
  let calls = 0;
  let chatOffset = 0;
  const chats: string[] = [];

  while (true) {
    if (calls >= maxCalls) {
      result.partial = true;
      break;
    }
    calls += 1;
    const page = await waha.listarChatsHistorico(session, {
      limit: CHAT_PAGE,
      offset: chatOffset,
      timeoutMs: PREVIEW_REQUEST_TIMEOUT_MS,
    });
    const pageChats = page.items.flatMap((chat) =>
      typeof chat.id === "string" && isDirectAddress(chat.id) ? [chat.id] : [],
    );
    chats.push(...pageChats);
    chatOffset += page.items.length;
    if (!page.hasMore || page.items.length === 0) break;
  }

  for (const chatId of chats) {
    let offset = 0;
    let messagesInChat = 0;
    let audioCount = 0;
    let imageCount = 0;
    let overLimit = false;
    while (true) {
      if (calls >= maxCalls) {
        result.partial = true;
        return result;
      }
      calls += 1;
      const page = await waha.listarMensagensHistorico(session, chatId, {
        limit: MESSAGE_PAGE,
        offset,
        desde: sinceSeconds,
        timeoutMs: PREVIEW_REQUEST_TIMEOUT_MS,
      });
      const current = page.items.filter((message) => countableMessage(message, rangeStart, until));
      messagesInChat += current.length;
      for (const message of current) {
        const type = resolveMessageType(message);
        if (type === "audio") audioCount += 1;
        if (type === "image") imageCount += 1;
      }
      offset += page.items.length;
      if (messagesInChat > MAX_MESSAGES_PER_CHAT) {
        overLimit = true;
        break;
      }
      if (!page.hasMore || page.items.length === 0) break;
    }
    if (overLimit) result.partial = true;
    if (messagesInChat > 0) result.conversations += 1;
    result.messages += messagesInChat;
    result.audios += audioCount;
    result.images += imageCount;
  }

  return result;
}
