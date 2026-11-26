import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";
import { logger } from "@/lib/logger";
import { marcarConversaComMensagem } from "../marcar-conversa";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";

export interface TelegramUserIngestPayload {
  message_id: string | number;
  date: number;
  is_private: true;
  access_hash?: string | null;
  from: {
    id: string | number;
    first_name: string;
    last_name?: string | null;
    username?: string | null;
    phone?: string | null;
  };
  peer_id: string | number;
  text?: string | null;
  media_type?: "image" | "audio" | "document" | "video" | null;
  media_url?: string | null;
  media_mime?: string | null;
  caption?: string | null;
}

const TelegramIdSchema = z.union([z.string().trim().min(1), z.number().int()]);
const TelegramUserIngestSchema = z.object({
  message_id: TelegramIdSchema,
  date: z.number().int().nonnegative(),
  is_private: z.literal(true),
  access_hash: z.string().trim().min(1).optional().nullable(),
  from: z.object({
    id: TelegramIdSchema,
    first_name: z.string().trim().max(256).optional().default(""),
    last_name: z.string().trim().max(256).optional().nullable(),
    username: z.string().trim().max(256).optional().nullable(),
    phone: z.string().trim().max(64).optional().nullable(),
  }),
  peer_id: TelegramIdSchema,
  text: z.string().max(35_000).optional().nullable(),
  media_type: z.enum(["image", "audio", "document", "video"]).optional().nullable(),
  media_url: z.string().max(256).optional().nullable(),
  media_mime: z.string().max(256).optional().nullable(),
  caption: z.string().max(35_000).optional().nullable(),
});

export interface TelegramUserIngestResult {
  status: "ingested" | "duplicate" | "ignored" | "failed";
  conversationId?: string;
  messageId?: string;
  reason?: string;
}

export async function ingestTelegramUserInbound(
  admin: SupabaseClient,
  opts: {
    organizationId: string;
    channelSessionId: string;
    payload: TelegramUserIngestPayload;
  },
): Promise<TelegramUserIngestResult> {
  const parsed = TelegramUserIngestSchema.safeParse(opts.payload);
  if (!parsed.success) {
    return { status: "ignored", reason: "payload_invalido" };
  }
  const p = parsed.data;

  const orgId = opts.organizationId;
  const fromUser = p.from;
  const senderId = String(fromUser.id);
  const socialIdentity = `telegram:user:${senderId}`;
  const providerConversationId = p.access_hash ? `tgu:${String(p.peer_id)}:${p.access_hash}` : null;

  const displayName =
    [fromUser.first_name, fromUser.last_name].filter(Boolean).join(" ").trim() ||
    fromUser.username ||
    `Telegram ${senderId}`;

  // 1. Contato
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
        phone: fromUser.phone ?? null,
        source: "telegram",
        source_metadata: {
          telegram_user_id: senderId,
          username: fromUser.username ?? null,
          is_mtproto_user: true,
        },
      })
      .select("id")
      .single();

    if (erroContato || !novoContato) {
      logger.error("telegram_user: falha ao criar contato", { error: erroContato });
      return { status: "failed", reason: `contato: ${erroContato?.message ?? "sem id"}` };
    }
    contactId = novoContato.id;
  }

  // 2. Conversa
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
    if (providerConversationId) {
      await admin
        .from("conversations")
        .update({ provider_conversation_id: providerConversationId })
        .eq("id", convExistente.id)
        .eq("organization_id", orgId)
        .eq("channel_session_id", opts.channelSessionId);
    }
  } else {
    const { data: novaConv, error: erroConv } = await admin
      .from("conversations")
      .insert({
        organization_id: orgId,
        contact_id: contactId,
        channel_session_id: opts.channelSessionId,
        channel: "telegram",
        provider_conversation_id: providerConversationId,
        status: "open",
      })
      .select("id")
      .single();

    if (erroConv || !novaConv) {
      logger.error("telegram_user: falha ao criar conversa", { error: erroConv });
      return { status: "failed", reason: `conversa: ${erroConv?.message ?? "sem id"}` };
    }
    conversationId = novaConv.id;
  }

  if (!contactId || !conversationId) {
    return { status: "failed", reason: "contato_ou_conversa_nao_resolvida" };
  }

  const resolvedContactId = contactId;
  const resolvedConversationId = conversationId;

  // 3. Extração
  const type = p.media_type ?? (p.text ? "text" : "text");
  const body = p.caption || p.text || (p.media_url ? `[${type}]` : "[mensagem]");
  const preview = body.slice(0, 120);
  const externalId = `${providerConversationId ?? `tgu:${p.peer_id || senderId}`}:${p.message_id}`;
  const sentAt = p.date ? new Date(p.date * 1000).toISOString() : new Date().toISOString();

  // 4. Mensagem
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
      media_url: p.media_url ?? null,
      media_mime: p.media_mime ?? null,
      external_id: externalId,
      sent_at: sentAt,
      metadata: {
        telegram_user_sender_id: senderId,
        telegram_message_id: p.message_id,
        telegram_peer_id: p.peer_id,
        is_userbot: true,
      },
    })
    .select("id")
    .maybeSingle();

  if (erroMsg) {
    if (erroMsg.code === "23505") {
      return { status: "duplicate", conversationId: resolvedConversationId };
    }
    logger.error("telegram_user: falha ao inserir mensagem", { error: erroMsg });
    return { status: "failed", reason: `mensagem: ${erroMsg.message}` };
  }

  const messageId = inserida?.id ?? "";

  if (p.media_url && messageId) {
    const { error: mediaEventError } = await admin.rpc(
      "emit_event" as never,
      {
        p_event_type: "media.persist_requested",
        p_entity_kind: "message",
        p_entity_id: messageId,
        p_payload: { message_id: messageId, conversation_id: resolvedConversationId },
        p_metadata: { source: "telegram_user_mtproto" },
        p_organization_id: orgId,
      } as never,
    );
    if (mediaEventError) {
      logger.warn("telegram_user: não foi possível solicitar persistência da mídia", {
        message_id: messageId,
      });
    }
  }

  // 5. Marca conversa e pós-entrada
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
    origem: "telegram_user_mtproto",
  });

  return {
    status: "ingested",
    conversationId: resolvedConversationId,
    messageId,
  };
}
