import type { SupabaseClient } from "@supabase/supabase-js";
import { instagramReplyComment, instagramSendMessage } from "./client";
import { logger } from "@/lib/logger";

export interface CommentRule {
  id: string;
  name: string;
  active: boolean;
  post_id: string | null;
  keyword_mode: "any" | "contains" | "exact";
  keywords: string[];
  reply_comment: string | null;
  dm_message: string;
  agent_id: string | null;
}

export function matchCommentRule(
  rule: CommentRule,
  commentPostId: string,
  commentText: string,
): boolean {
  if (!rule.active) return false;

  // Filtro de post específico (se nulo, vale para todos os posts)
  if (rule.post_id && rule.post_id !== commentPostId) {
    return false;
  }

  const cleanText = commentText.trim().toLowerCase();

  switch (rule.keyword_mode) {
    case "any":
      return true;
    case "contains": {
      if (!rule.keywords || rule.keywords.length === 0) return true;
      return rule.keywords.some((kw) => cleanText.includes(kw.trim().toLowerCase()));
    }
    case "exact": {
      if (!rule.keywords || rule.keywords.length === 0) return true;
      return rule.keywords.some((kw) => cleanText === kw.trim().toLowerCase());
    }
    default:
      return false;
  }
}

export async function processCommentToDm(
  admin: SupabaseClient,
  opts: {
    organizationId: string;
    channelSessionId: string;
    instagramAccountId: string;
    token: string;
    commentId: string;
    postId: string;
    commentText: string;
    fromUser: { id: string; username: string };
  },
): Promise<{ triggeredRules: string[]; dmSent: boolean }> {
  const { data: rules, error } = await admin
    .from("instagram_comment_rules")
    .select("id, name, active, post_id, keyword_mode, keywords, reply_comment, dm_message, agent_id")
    .eq("organization_id", opts.organizationId)
    .eq("channel_session_id", opts.channelSessionId)
    .eq("active", true);

  if (error || !rules || rules.length === 0) {
    return { triggeredRules: [], dmSent: false };
  }

  const matchedRules = (rules as CommentRule[]).filter((r) =>
    matchCommentRule(r, opts.postId, opts.commentText),
  );

  if (matchedRules.length === 0) {
    return { triggeredRules: [], dmSent: false };
  }

  const triggeredRules: string[] = [];
  let dmSent = false;

  // Processa a primeira regra compatível (para evitar múltiplos disparos duplicados de DM para o mesmo comentário)
  const rule = matchedRules[0];
  if (!rule) {
    return { triggeredRules: [], dmSent: false };
  }

  triggeredRules.push(rule.id);

  // 1. Resposta pública ao comentário (se configurada)
  if (rule.reply_comment && rule.reply_comment.trim() !== "") {
    try {
      await instagramReplyComment(opts.token, opts.commentId, rule.reply_comment.trim());
    } catch (err) {
      logger.warn("Falha ao enviar resposta pública ao comentário de Instagram", {
        error: String(err),
        commentId: opts.commentId,
      });
    }
  }

  // 2. Envio da DM para o usuário
  if (rule.dm_message && rule.dm_message.trim() !== "") {
    try {
      const dmResult = await instagramSendMessage(
        opts.token,
        opts.instagramAccountId,
        opts.fromUser.id,
        rule.dm_message.trim(),
      );
      dmSent = true;

      // 3. Registra ou atualiza contato e conversa no CRM
      const socialIdentity = {
        network: "instagram",
        account: opts.instagramAccountId,
        id: opts.fromUser.id,
      };

      const { data: contact } = await admin
        .from("contacts")
        .select("id")
        .eq("organization_id", opts.organizationId)
        .contains("social_identity", socialIdentity)
        .maybeSingle();

      let contactId = contact?.id;

      if (!contactId) {
        const { data: newContact } = await admin
          .from("contacts")
          .insert({
            organization_id: opts.organizationId,
            name: opts.fromUser.username ? `@${opts.fromUser.username}` : "Usuário Instagram",
            social_identity: socialIdentity,
            kind: "social_user",
          })
          .select("id")
          .single();
        contactId = newContact?.id;
      }

      if (contactId) {
        // Encontra ou abre conversa
        const { data: conv } = await admin
          .from("conversations")
          .select("id")
          .eq("organization_id", opts.organizationId)
          .eq("contact_id", contactId)
          .is("archived_at", null)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();

        let conversationId = conv?.id;

        if (!conversationId) {
          const { data: newConv } = await admin
            .from("conversations")
            .insert({
              organization_id: opts.organizationId,
              contact_id: contactId,
              channel: "instagram",
              channel_session_id: opts.channelSessionId,
              assigned_agent_id: rule.agent_id || null,
              status: "open",
            })
            .select("id")
            .single();
          conversationId = newConv?.id;
        }

        if (conversationId) {
          // Grava a mensagem enviada
          await admin.from("messages").insert({
            organization_id: opts.organizationId,
            conversation_id: conversationId,
            sender_type: "agent",
            body: rule.dm_message.trim(),
            channel: "instagram",
            external_id: dmResult.messageId,
            status: "delivered",
          });
        }
      }
    } catch (err) {
      logger.error("Falha ao enviar DM da automação Comment-to-DM", {
        error: String(err),
        recipientId: opts.fromUser.id,
      });
    }
  }

  return { triggeredRules, dmSent };
}
