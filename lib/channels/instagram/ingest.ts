import type { SupabaseClient } from "@supabase/supabase-js";
import type { InstagramWebhookPayload } from "./types";
import { resolveInstagramCreds } from "./credentials";
import { processCommentToDm } from "./comment-to-dm";
import { marcarConversaComMensagem } from "../marcar-conversa";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";
import { logger } from "@/lib/logger";

export async function ingestInstagramWebhook(
  admin: SupabaseClient,
  payload: InstagramWebhookPayload,
  organizationId: string,
): Promise<{ processed: number; errors: number }> {
  let processed = 0;
  let errors = 0;

  for (const entry of payload.entry || []) {
    const accountId = entry.id;

    // Localiza a sessão associada a esta conta do Instagram
    const { data: session } = await admin
      .from("channel_sessions")
      .select("id, organization_id, default_agent_id, instagram_account_id")
      .eq("organization_id", organizationId)
      .eq("instagram_account_id", accountId)
      .eq("provider", "instagram")
      .is("archived_at", null)
      .maybeSingle();

    if (!session) {
      continue;
    }

    const orgId = session.organization_id;

    // 1. Mensagens de Direct
    for (const event of entry.messaging || []) {
      try {
        const senderId = event.sender?.id;
        const msg = event.message;

        // Se for eco enviado por nós mesmos, pula
        if (msg?.is_echo) {
          continue;
        }

        if (!senderId || !msg) {
          continue;
        }

        const externalId = msg.mid;
        const text = msg.text || (msg.attachments && msg.attachments[0]?.payload?.url ? "[Mídia]" : "");

        const socialIdentity = {
          network: "instagram",
          account: accountId,
          id: senderId,
        };

        // Localiza ou cria o contato
        const { data: contact } = await admin
          .from("contacts")
          .select("id, name")
          .eq("organization_id", orgId)
          .contains("social_identity", socialIdentity)
          .maybeSingle();

        let contactId = contact?.id;

        if (!contactId) {
          const { data: newContact, error: errC } = await admin
            .from("contacts")
            .insert({
              organization_id: orgId,
              name: `Instagram @${senderId}`,
              social_identity: socialIdentity,
              kind: "social_user",
            })
            .select("id")
            .single();

          if (errC || !newContact) {
            errors++;
            continue;
          }
          contactId = newContact.id;
        }

        // Localiza ou abre conversa
        const { data: conv } = await admin
          .from("conversations")
          .select("id, status")
          .eq("organization_id", orgId)
          .eq("contact_id", contactId)
          .is("archived_at", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        let conversationId = conv?.id;

        if (!conv || conv.status === "archived") {
          const { data: newConv, error: errCv } = await admin
            .from("conversations")
            .insert({
              organization_id: orgId,
              contact_id: contactId,
              channel: "instagram",
              channel_session_id: session.id,
              assigned_agent_id: session.default_agent_id || null,
              status: "open",
            })
            .select("id")
            .single();

          if (errCv || !newConv) {
            errors++;
            continue;
          }
          conversationId = newConv.id;
        }

        if (!conversationId) continue;

        // Insere a mensagem
        const { data: insertedMsg, error: errM } = await admin
          .from("messages")
          .insert({
            organization_id: orgId,
            conversation_id: conversationId,
            sender_type: "contact",
            body: text,
            channel: "instagram",
            external_id: externalId,
            status: "delivered",
          })
          .select("id")
          .single();

        if (errM || !insertedMsg) {
          // Idempotência no external_id
          continue;
        }

        // Marca conversa e dispara CRM/IA
        await marcarConversaComMensagem(admin, {
          organizationId: orgId,
          conversationId,
          direction: "inbound",
          preview: text.slice(0, 120),
          at: new Date(event.timestamp || Date.now()).toISOString(),
          canal: "instagram",
        });

        await aplicarEfeitosPosEntrada(admin, {
          organizationId: orgId,
          contactId,
          conversationId,
          messageId: insertedMsg.id,
          channelSessionId: session.id,
          texto: text,
          nomeDoContato: `Instagram @${senderId}`,
          origem: "instagram_webhook",
        });

        processed++;
      } catch (err) {
        logger.error("Erro na ingestão de mensagem do Instagram", {
          error: String(err),
          accountId,
        });
        errors++;
      }
    }

    // 2. Mudanças de Comentários (Comment-to-DM)
    for (const change of entry.changes || []) {
      if (change.field === "comments" && change.value) {
        try {
          const creds = await resolveInstagramCreds(admin, {
            organizationId: orgId,
            accountId,
          });

          if (!creds) continue;

          await processCommentToDm(admin, {
            organizationId: orgId,
            channelSessionId: session.id,
            instagramAccountId: accountId,
            token: creds.token,
            commentId: change.value.id,
            postId: change.value.post?.id || "",
            commentText: change.value.text || "",
            fromUser: change.value.from || { id: "", username: "" },
          });

          processed++;
        } catch (err) {
          logger.error("Erro ao processar evento de comentário para Comment-to-DM", {
            error: String(err),
            accountId,
          });
          errors++;
        }
      }
    }
  }

  return { processed, errors };
}
