import type { SupabaseClient } from "@supabase/supabase-js";
import type { TikTokWebhookPayload } from "./types";
import { marcarConversaComMensagem } from "../marcar-conversa";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";
import { findActiveConversationForChannel } from "../conversation-isolation";
import { logger } from "@/lib/logger";

export async function ingestTikTokWebhook(
  admin: SupabaseClient,
  payload: TikTokWebhookPayload,
  organizationId: string,
): Promise<{ success: boolean; messageId?: string }> {
  const event = payload.data;
  if (!event || !event.business_id || !event.from_user_id) {
    return { success: false };
  }

  const { data: session } = await admin
    .from("channel_sessions")
    .select("id, organization_id, default_agent_id, tiktok_business_id")
    .eq("organization_id", organizationId)
    .eq("tiktok_business_id", event.business_id)
    .eq("provider", "tiktok")
    .is("archived_at", null)
    .maybeSingle();

  if (!session) {
    return { success: false };
  }

  const orgId = session.organization_id;
  const senderId = event.from_user_id;
  const externalId = event.message_id || `tiktok_${Date.now()}`;
  const text = event.content?.text || "[Mensagem TikTok]";

  const socialIdentity = {
    network: "tiktok",
    account: event.business_id,
    id: senderId,
  };

  try {
    // 1. Contato
    const { data: contact } = await admin
      .from("contacts")
      .select("id")
      .eq("organization_id", orgId)
      .contains("social_identity", socialIdentity)
      .maybeSingle();

    let contactId = contact?.id;

    if (!contactId) {
      const { data: newContact, error: errC } = await admin
        .from("contacts")
        .insert({
          organization_id: orgId,
          name: `TikTok @${senderId}`,
          social_identity: socialIdentity,
          kind: "social_user",
        })
        .select("id")
        .single();

      if (errC || !newContact) {
        return { success: false };
      }
      contactId = newContact.id;
    }

    // 2. Conversa
    const conv = await findActiveConversationForChannel(admin, {
      organizationId: orgId,
      contactId,
      channel: "tiktok",
      channelSessionId: session.id,
    });

    let conversationId = conv?.id;

    if (!conv || conv.status === "archived") {
      const { data: newConv, error: errCv } = await admin
        .from("conversations")
        .insert({
          organization_id: orgId,
          contact_id: contactId,
          channel: "tiktok",
          channel_session_id: session.id,
          assigned_agent_id: session.default_agent_id || null,
          status: "open",
        })
        .select("id")
        .single();

      if (errCv || !newConv) {
        return { success: false };
      }
      conversationId = newConv.id;
    }

    if (!conversationId) {
      return { success: false };
    }

    // 3. Mensagem
    const { data: insertedMsg, error: errM } = await admin
      .from("messages")
      .insert({
        organization_id: orgId,
        conversation_id: conversationId,
        sender_type: "contact",
        body: text,
        channel: "tiktok",
        external_id: externalId,
        status: "delivered",
      })
      .select("id")
      .single();

    if (errM || !insertedMsg) {
      return { success: false };
    }

    // 4. Marca conversa e dispara CRM/IA
    await marcarConversaComMensagem(admin, {
      organizationId: orgId,
      conversationId,
      direction: "inbound",
      preview: text.slice(0, 120),
      at: new Date(event.create_time || Date.now()).toISOString(),
      canal: "tiktok",
    });

    await aplicarEfeitosPosEntrada(admin, {
      organizationId: orgId,
      contactId,
      conversationId,
      messageId: insertedMsg.id,
      channelSessionId: session.id,
      texto: text,
      nomeDoContato: `TikTok @${senderId}`,
      origem: "tiktok_webhook",
    });

    return { success: true, messageId: insertedMsg.id };
  } catch (err) {
    logger.error("Erro ao processar webhook do TikTok", {
      error: String(err),
      businessId: event.business_id,
    });
    return { success: false };
  }
}
