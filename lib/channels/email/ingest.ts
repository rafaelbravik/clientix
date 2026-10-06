import type { SupabaseClient } from "@supabase/supabase-js";
import { logger } from "@/lib/logger";
import { marcarConversaComMensagem } from "../marcar-conversa";
import { aplicarEfeitosPosEntrada } from "../pos-entrada";

export interface EmailInboundPayload {
  from: string;
  to: string;
  subject?: string | null;
  text?: string | null;
  html?: string | null;
  messageId?: string | null;
  inReplyTo?: string | null;
}

export interface EmailIngestResult {
  status: "ingested" | "duplicate" | "ignored" | "failed";
  conversationId?: string;
  messageId?: string;
  reason?: string;
}

export function parseEmailAddress(raw: string): { email: string; name: string } {
  const match = raw.match(/^(?:"?([^"]*)"?\s)?<?([a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,})>?$/);
  if (match && match[2]) {
    return {
      name: (match[1] || "").trim() || match[2],
      email: match[2].trim().toLowerCase(),
    };
  }

  const clean = raw.trim().toLowerCase();
  return { name: clean, email: clean };
}

export async function ingestEmailInbound(
  admin: SupabaseClient,
  opts: {
    organizationId: string;
    channelSessionId: string;
    payload: EmailInboundPayload;
  },
): Promise<EmailIngestResult> {
  const { from, subject, text, html, messageId, inReplyTo } = opts.payload;
  if (!from || !from.includes("@")) {
    return { status: "ignored", reason: "email_remetente_invalido" };
  }

  const { email: fromEmail, name: fromName } = parseEmailAddress(from);
  const orgId = opts.organizationId;
  const bodyContent = (text || html || "").trim() || "[e-mail sem texto]";
  const assunto = subject?.trim() || "(Sem assunto)";

  // 1. Busca ou cria o contato pelo e-mail
  let contactId: string | null = null;
  const { data: contatoExistente } = await admin
    .from("contacts")
    .select("id")
    .eq("organization_id", orgId)
    .eq("email_normalized", fromEmail)
    .is("is_merged_into", null)
    .maybeSingle();

  if (contatoExistente) {
    contactId = contatoExistente.id;
  } else {
    const { data: novoContato, error: erroContato } = await admin
      .from("contacts")
      .insert({
        organization_id: orgId,
        display_name: fromName,
        name: fromName,
        email: fromEmail,
        kind: "email",
        source: "email",
        source_metadata: { original_from: from },
      })
      .select("id")
      .single();

    if (erroContato || !novoContato) {
      logger.error("email: falha ao criar contato", { error: erroContato });
      return { status: "failed", reason: `contato: ${erroContato?.message ?? "sem id"}` };
    }
    contactId = novoContato.id;
  }

  // 2. Busca ou cria conversa (suporte a threading por protocolo no assunto)
  let conversationId: string | null = null;
  const protocoloMatch = assunto.match(/PROT-\d{8}-\d{4}/);

  if (protocoloMatch) {
    const protBuscado = protocoloMatch[0];
    const { data: convPorProtocolo } = await admin
      .from("conversations")
      .select("id")
      .eq("organization_id", orgId)
      .eq("protocolo", protBuscado)
      .maybeSingle();

    if (convPorProtocolo) {
      conversationId = convPorProtocolo.id;
    }
  }

  if (!conversationId) {
    // Busca conversa aberta do contato no canal email
    const { data: convAberta } = await admin
      .from("conversations")
      .select("id")
      .eq("organization_id", orgId)
      .eq("contact_id", contactId)
      .eq("channel_session_id", opts.channelSessionId)
      .is("service_closed_at", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (convAberta) {
      conversationId = convAberta.id;
    } else {
      const { data: novaConv, error: erroConv } = await admin
        .from("conversations")
        .insert({
          organization_id: orgId,
          contact_id: contactId,
          channel_session_id: opts.channelSessionId,
          channel: "email",
          status: "open",
        })
        .select("id")
        .single();

      if (erroConv || !novaConv) {
        logger.error("email: falha ao criar conversa", { error: erroConv });
        return { status: "failed", reason: `conversa: ${erroConv?.message ?? "sem id"}` };
      }
      conversationId = novaConv.id;
    }
  }

  if (!contactId || !conversationId) {
    return { status: "failed", reason: "contato_ou_conversa_nao_resolvida" };
  }

  const resolvedContactId = contactId;
  const resolvedConversationId = conversationId;

  // 3. Insere a mensagem
  const externalId = messageId ? `email:${messageId}` : `email_gen_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const sentAt = new Date().toISOString();

  const { data: inserida, error: erroMsg } = await admin
    .from("messages")
    .insert({
      organization_id: orgId,
      conversation_id: resolvedConversationId,
      channel_session_id: opts.channelSessionId,
      contact_id: resolvedContactId,
      direction: "inbound",
      status: "delivered",
      type: "text",
      body: `Assunto: ${assunto}\n\n${bodyContent}`,
      external_id: externalId,
      sent_at: sentAt,
      metadata: {
        email_from: from,
        email_subject: assunto,
        email_message_id: messageId ?? null,
        email_in_reply_to: inReplyTo ?? null,
      },
    })
    .select("id")
    .maybeSingle();

  if (erroMsg) {
    if (erroMsg.code === "23505") {
      return { status: "duplicate", conversationId: resolvedConversationId };
    }
    logger.error("email: falha ao inserir mensagem", { error: erroMsg });
    return { status: "failed", reason: `mensagem: ${erroMsg.message}` };
  }

  const msgId = inserida?.id ?? "";

  // 4. Marca conversa e aciona IA / CRM
  await marcarConversaComMensagem(admin, {
    organizationId: orgId,
    conversationId: resolvedConversationId,
    direction: "inbound",
    preview: `${assunto}: ${bodyContent}`.slice(0, 120),
    at: sentAt,
    canal: "email",
  });

  await aplicarEfeitosPosEntrada(admin, {
    organizationId: orgId,
    contactId: resolvedContactId,
    conversationId: resolvedConversationId,
    messageId: msgId || null,
    channelSessionId: opts.channelSessionId,
    texto: bodyContent,
    nomeDoContato: fromName,
    origem: "email_webhook",
  });

  return {
    status: "ingested",
    conversationId: resolvedConversationId,
    messageId: msgId,
  };
}
