import type { SupabaseClient } from "@supabase/supabase-js";

export interface TelegramReadReceiptMessage {
  id: string;
  external_id: string | null;
  status: string;
}

export interface TelegramReadReceiptResult {
  conversationFound: boolean;
  messageMatched: boolean;
  updated: number;
}

export interface TelegramOutboxReadUpdate {
  peerId: string;
  maxId: number;
}

export interface TelegramPendingReadConversation {
  peerId: string;
  providerConversationId: string;
  minMessageId: number;
  maxMessageId: number;
}

export function agruparPendenciasDeLeituraTelegram(
  conversations: readonly { id: string; provider_conversation_id: string | null }[],
  messages: readonly { conversation_id: string | null; external_id: string | null }[],
): TelegramPendingReadConversation[] {
  const byConversation = new Map(
    conversations.map((conversation) => [conversation.id, conversation.provider_conversation_id]),
  );
  const byPeer = new Map<string, TelegramPendingReadConversation>();

  for (const message of messages) {
    if (!message.conversation_id) continue;
    const providerConversationId = byConversation.get(message.conversation_id);
    const peerMatch = providerConversationId?.match(/^tgu:(\d+):-?\d+$/);
    const maxMessageId = telegramMessageIdFromExternalId(message.external_id);
    if (!providerConversationId || !peerMatch?.[1] || maxMessageId === null) continue;

    const peerId = peerMatch[1];
    const existing = byPeer.get(peerId);
    if (!existing) {
      byPeer.set(peerId, {
        peerId,
        providerConversationId,
        minMessageId: maxMessageId,
        maxMessageId,
      });
    } else {
      byPeer.set(peerId, {
        ...existing,
        minMessageId: Math.min(existing.minMessageId, maxMessageId),
        maxMessageId: Math.max(existing.maxMessageId, maxMessageId),
      });
    }
  }

  return [...byPeer.values()];
}

/** Busca apenas mensagens outbound ainda sem confirmação de leitura. */
export async function listarPendenciasDeLeituraTelegram(
  admin: SupabaseClient,
  input: { organizationId: string; channelSessionId: string },
): Promise<TelegramPendingReadConversation[]> {
  const { data: conversations, error: conversationError } = await admin
    .from("conversations")
    .select("id, provider_conversation_id")
    .eq("organization_id", input.organizationId)
    .eq("channel_session_id", input.channelSessionId)
    .eq("channel", "telegram")
    .like("provider_conversation_id", "tgu:%");

  if (conversationError) throw new Error("telegram_read_receipt_pending_conversation_query_failed");
  if (!conversations?.length) return [];

  const { data: messages, error: messageError } = await admin
    .from("messages")
    .select("conversation_id, external_id")
    .eq("organization_id", input.organizationId)
    .eq("channel_session_id", input.channelSessionId)
    .eq("direction", "outbound")
    .in("status", ["sent", "delivered"])
    .in(
      "conversation_id",
      conversations.map((conversation) => conversation.id),
    )
    .not("external_id", "is", null)
    .order("created_at", { ascending: false })
    .limit(500);

  if (messageError) throw new Error("telegram_read_receipt_pending_message_query_failed");

  return agruparPendenciasDeLeituraTelegram(
    conversations as { id: string; provider_conversation_id: string | null }[],
    (messages ?? []) as { conversation_id: string | null; external_id: string | null }[],
  );
}

/**
 * Extrai o recibo de leitura sem depender de `instanceof`: o worker pode
 * empacotar TL classes por caminhos distintos, embora os objetos sejam do
 * mesmo protocolo. O nome da classe faz parte do contrato serializado do MTProto.
 */
export function extrairReciboLeituraTelegramUsuario(
  outbox: boolean,
  update: unknown,
): TelegramOutboxReadUpdate | null {
  if (!outbox || !update || typeof update !== "object") return null;

  const record = update as {
    className?: unknown;
    peer?: unknown;
    maxId?: unknown;
  };
  if (record.className !== "UpdateReadHistoryOutbox") return null;
  if (!record.peer || typeof record.peer !== "object") return null;

  const peer = record.peer as { className?: unknown; userId?: unknown };
  if (peer.className !== "PeerUser" || peer.userId == null) return null;

  const peerId = String(peer.userId);
  const maxId = Number(record.maxId);
  if (!/^\d+$/.test(peerId) || !Number.isSafeInteger(maxId) || maxId < 1) return null;

  return { peerId, maxId };
}

/**
 * O ID de mensagem do MTProto é o último segmento do external_id do adapter.
 * O prefixo identifica o peer e pode variar entre textos e arquivos; o listener
 * já limita a busca à conversa daquele peer antes de usar este parser.
 */
export function telegramMessageIdFromExternalId(externalId: string | null): number | null {
  if (!externalId) return null;
  const suffix = externalId.slice(externalId.lastIndexOf(":") + 1);
  if (!/^\d+$/.test(suffix)) return null;
  const messageId = Number(suffix);
  return Number.isSafeInteger(messageId) && messageId > 0 ? messageId : null;
}

/** Telegram informa que todas as mensagens até maxId foram lidas. */
export function mensagensTelegramLidasAte(
  messages: readonly TelegramReadReceiptMessage[],
  maxId: number,
): TelegramReadReceiptMessage[] {
  if (!Number.isSafeInteger(maxId) || maxId < 1) return [];
  return messages.filter((message) => {
    const messageId = telegramMessageIdFromExternalId(message.external_id);
    return messageId !== null && messageId <= maxId;
  });
}

/**
 * Aplica o recibo de leitura de uma DM do Telegram às mensagens outbound do
 * tenant. O service role exige filtro explícito de organização e sessão.
 */
export async function sincronizarLeituraTelegramUsuario(
  admin: SupabaseClient,
  input: {
    organizationId: string;
    channelSessionId: string;
    peerId: string;
    maxId: number;
    readAt?: string;
  },
): Promise<TelegramReadReceiptResult> {
  if (!/^\d+$/.test(input.peerId) || !Number.isSafeInteger(input.maxId) || input.maxId < 1) {
    return { conversationFound: false, messageMatched: false, updated: 0 };
  }

  const { data: conversations, error: conversationError } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", input.organizationId)
    .eq("channel_session_id", input.channelSessionId)
    .eq("channel", "telegram")
    .like("provider_conversation_id", `tgu:${input.peerId}:%`);

  if (conversationError) throw new Error("telegram_read_receipt_conversation_query_failed");
  const conversationIds = (conversations ?? []).map((conversation) => conversation.id);
  if (conversationIds.length === 0) {
    return { conversationFound: false, messageMatched: false, updated: 0 };
  }

  const { data: messages, error: messageError } = await admin
    .from("messages")
    .select("id, external_id, status")
    .eq("organization_id", input.organizationId)
    .eq("channel_session_id", input.channelSessionId)
    .in("conversation_id", conversationIds)
    .eq("direction", "outbound")
    .in("status", ["sent", "delivered", "read"])
    .not("external_id", "is", null);

  if (messageError) throw new Error("telegram_read_receipt_message_query_failed");
  const matches = mensagensTelegramLidasAte(
    (messages ?? []) as TelegramReadReceiptMessage[],
    input.maxId,
  );
  if (matches.length === 0) {
    return { conversationFound: true, messageMatched: false, updated: 0 };
  }

  const pendingIds = matches
    .filter((message) => message.status === "sent" || message.status === "delivered")
    .map((message) => message.id);
  if (pendingIds.length === 0) {
    return { conversationFound: true, messageMatched: true, updated: 0 };
  }

  const readAt = input.readAt ?? new Date().toISOString();
  const { data: updatedMessages, error: updateError } = await admin
    .from("messages")
    .update({ status: "read", delivered_at: readAt, read_at: readAt })
    .eq("organization_id", input.organizationId)
    .eq("channel_session_id", input.channelSessionId)
    .in("id", pendingIds)
    // Um recibo atrasado nunca pode fazer uma mensagem regredir de estado.
    .in("status", ["sent", "delivered"])
    .select("id");

  if (updateError) throw new Error("telegram_read_receipt_update_failed");
  return {
    conversationFound: true,
    messageMatched: true,
    updated: updatedMessages?.length ?? 0,
  };
}
