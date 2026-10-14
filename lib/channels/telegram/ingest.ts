import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { marcarConversaComMensagem } from "../marcar-conversa";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";
import type { TelegramMessage, TelegramUpdate } from "./types";

export interface TelegramIngestResult {
  status: "ingested" | "duplicate" | "ignored" | "failed";
  conversationId?: string;
  messageId?: string;
  reason?: string;
}

export async function ingestTelegramInbound(
  admin: SupabaseClient,
  opts: {
    organizationId: string;
    channelSessionId: string;
    payload: unknown;
  },
): Promise<TelegramIngestResult> {
  const update = opts.payload as TelegramUpdate;
  if (!update || typeof update !== "object") {
    return { status: "ignored", reason: "payload_invalido" };
  }

  const msg = update.message || update.edited_message;
  if (!msg || !msg.from || !msg.chat) {
    return { status: "ignored", reason: "update_sem_mensagem_suportada" };
  }
  if (msg.chat.type !== "private") {
    return { status: "ignored", reason: "telegram_bot_api_somente_chat_privado" };
  }

  const orgId = opts.organizationId;
  const fromUser = msg.from;
  const chatId = String(msg.chat.id);
  const socialIdentity = `telegram:${fromUser.id}`;

  const displayName =
    [fromUser.first_name, fromUser.last_name].filter(Boolean).join(" ").trim() ||
    fromUser.username ||
    `Telegram ${fromUser.id}`;

  // 1. Busca ou cria o contato com social_identity
  let contactId: string | null = null;
  const { data: contatoExistente } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("social_identity", socialIdentity)
    .is("is_merged_into", null)
    .maybeSingle();

  if (contatoExistente) {
    contactId = contatoExistente.id;
  } else {
    const { data: novoContato, error: erroContato } = await admin
      .from("contacts")
      .insert({
        organization_id: orgId,
        display_name: displayName,
        name: displayName,
        kind: "social",
        social_identity: socialIdentity,
        source: "telegram",
        source_metadata: {
          telegram_user_id: fromUser.id,
          username: fromUser.username ?? null,
          language_code: fromUser.language_code ?? null,
        },
      })
      .select("id")
      .single();

    if (erroContato || !novoContato) {
      logger.error("telegram: falha ao criar contato", { error: erroContato });
      return { status: "failed", reason: `contato: ${erroContato?.message ?? "sem id"}` };
    }
    contactId = novoContato.id;
  }

  // 2. Busca ou cria a conversa
  let conversationId: string | null = null;
  const { data: convExistente } = await admin
    .from("conversations")
    .select("id")
    .eq("organization_id", orgId)
    .eq("contact_id", contactId)
    .eq("channel_session_id", opts.channelSessionId)
    .is("service_closed_at", null)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (convExistente) {
    conversationId = convExistente.id;
  } else {
    const { data: novaConv, error: erroConv } = await admin
      .from("conversations")
      .insert({
        organization_id: orgId,
        contact_id: contactId,
        channel_session_id: opts.channelSessionId,
        channel: "telegram",
        status: "open",
      })
      .select("id")
      .single();

    if (erroConv || !novaConv) {
      logger.error("telegram: falha ao criar conversa", { error: erroConv });
      return { status: "failed", reason: `conversa: ${erroConv?.message ?? "sem id"}` };
    }
    conversationId = novaConv.id;
  }

  if (!contactId || !conversationId) {
    return { status: "failed", reason: "contato_ou_conversa_nao_resolvida" };
  }

  const resolvedContactId = contactId;
  const resolvedConversationId = conversationId;

  // 3. Extrai tipo de mensagem e conteúdo
  const { type, body, preview } = extrairConteudoTelegram(msg);
  const externalId = `tg:${chatId}:${msg.message_id}`;
  const sentAt = new Date(msg.date * 1000).toISOString();

  // 4. Insere a mensagem
  const { data: inserida, error: erroMsg } = await admin
    .from("messages")
    .insert({
      organization_id: orgId,
      conversation_id: resolvedConversationId,
      channel_session_id: opts.channelSessionId,
      contact_id: resolvedContactId,
      direction: "inbound",
      status: "delivered",
      type,
      body,
      external_id: externalId,
      sent_at: sentAt,
      metadata: {
        telegram_chat_id: chatId,
        telegram_message_id: msg.message_id,
        telegram_username: fromUser.username ?? null,
      },
    })
    .select("id")
    .maybeSingle();

  if (erroMsg) {
    if (erroMsg.code === "23505") {
      return { status: "duplicate", conversationId: resolvedConversationId };
    }
    logger.error("telegram: falha ao inserir mensagem", { error: erroMsg });
    return { status: "failed", reason: `mensagem: ${erroMsg.message}` };
  }

  const messageId = inserida?.id ?? "";

  // 5. Atualiza conversa e aciona efeitos pós-entrada (IA, funil, etc.)
  await marcarConversaComMensagem(admin, {
    organizationId: orgId,
    conversationId: resolvedConversationId,
    direction: "inbound",
    preview,
    at: sentAt,
    canal: "telegram",
  });

  await aplicarEfeitosPosEntrada(admin, {
    organizationId: orgId,
    contactId: resolvedContactId,
    conversationId: resolvedConversationId,
    messageId: messageId || null,
    channelSessionId: opts.channelSessionId,
    texto: body,
    nomeDoContato: displayName,
    origem: "telegram_webhook",
  });

  return {
    status: "ingested",
    conversationId: resolvedConversationId,
    messageId,
  };
}

function extrairConteudoTelegram(msg: TelegramMessage): {
  type: string;
  body: string | null;
  preview: string;
} {
  if (msg.text) {
    return {
      type: "text",
      body: msg.text,
      preview: msg.text.slice(0, 120),
    };
  }

  if (msg.photo && msg.photo.length > 0) {
    const caption = msg.caption ?? null;
    return {
      type: "image",
      body: caption,
      preview: caption ? `📷 ${caption.slice(0, 100)}` : "📷 Foto",
    };
  }

  if (msg.voice) {
    return {
      type: "audio",
      body: msg.caption ?? null,
      preview: "🎤 Mensagem de voz",
    };
  }

  if (msg.audio) {
    return {
      type: "audio",
      body: msg.caption ?? null,
      preview: "🎵 Áudio",
    };
  }

  if (msg.document) {
    const name = msg.document.file_name || "Documento";
    return {
      type: "document",
      body: msg.caption ?? name,
      preview: `📎 ${name}`,
    };
  }

  return {
    type: "text",
    body: "[mensagem não suportada]",
    preview: "[mensagem]",
  };
}
