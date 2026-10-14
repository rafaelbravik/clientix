import { createHash, randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { CHANNEL_PROVIDER_WEBCHAT } from "@/lib/channels/capabilities";
import { resolveClientIp } from "@/lib/channels/webhook-ip";
import {
  gerarTokenDeAcessoWidget,
  validarTokenDeAcessoWidget,
  WEBCHAT_TOKEN_TTL_MS,
} from "@/lib/chat-widget/token";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const bootstrapSchema = z.object({
  widget_public_id: z.string().uuid(),
  existing_token: z.string().min(10).max(4096).optional(),
}).strict();

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const reader = req.body?.getReader();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8 * 1024) {
        await reader.cancel();
        return fail("payload_too_large", "payload exceeds limit", 413, { requestId });
      }
      chunks.push(value);
    }
  }

  let input: unknown;
  try {
    input = JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }
  const parsed = bootstrapSchema.safeParse(input);
  if (!parsed.success) {
    return fail("validation_failed", "Identificador do widget inválido.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  // A política de origem não existe no produto. Não tratamos Origin/Referer
  // como autenticação; o identificador é público e o token abaixo é restrito.
  const ip = resolveClientIp(req.headers);
  if (ip) {
    const ipHash = createHash("sha256").update(ip).digest("hex").slice(0, 24);
    const ipLimit = await checkRateLimit(`webchat_bootstrap_ip:${ipHash}`, 30, 60);
    if (!ipLimit.allowed) {
      return fail("rate_limited", "Muitos inícios de atendimento. Aguarde um momento.", 429, {
        requestId,
        headers: { "Retry-After": "60" },
      });
    }
  }

  const db = createAdminClient();
  const { data: session, error: sessionError } = await db
    .from("channel_sessions")
    .select("id, organization_id, webchat_public_id, status")
    .eq("provider", CHANNEL_PROVIDER_WEBCHAT)
    .eq("webchat_public_id", parsed.data.widget_public_id)
    .is("archived_at", null)
    .maybeSingle();

  if (sessionError || !session || session.status !== "WORKING") {
    return fail("not_found", "Widget indisponível.", 404, { requestId });
  }

  const widgetHash = createHash("sha256")
    .update(parsed.data.widget_public_id)
    .digest("hex")
    .slice(0, 24);
  const widgetLimit = await checkRateLimit(`webchat_bootstrap_widget:${widgetHash}`, 120, 60);
  if (!widgetLimit.allowed) {
    return fail("rate_limited", "Muitos inícios de atendimento para este widget.", 429, {
      requestId,
      headers: { "Retry-After": "60" },
    });
  }

  if (parsed.data.existing_token) {
    const existing = validarTokenDeAcessoWidget(parsed.data.existing_token);
    if (
      !existing.valido ||
      !existing.payload ||
      existing.payload.widgetPublicId !== parsed.data.widget_public_id ||
      existing.payload.organizationId !== session.organization_id
    ) {
      return fail("unauthorized", "Sessão WebChat inválida ou expirada.", 401, { requestId });
    }

    const { data: conversation } = await db
      .from("conversations")
      .select("id, channel_session_id, channel, provider_conversation_id")
      .eq("id", existing.payload.conversationId)
      .eq("organization_id", session.organization_id)
      .maybeSingle();
    if (
      conversation?.channel === "webchat" &&
      conversation.channel_session_id === session.id &&
      conversation.provider_conversation_id === conversation.id
    ) {
      return ok(
        {
          token: parsed.data.existing_token,
          expires_at: new Date(existing.payload.expiresAt ?? Date.now()).toISOString(),
        },
        { requestId },
      );
    }
    return fail("unauthorized", "Sessão WebChat inválida ou expirada.", 401, { requestId });
  }

  const contactId = randomUUID();
  const { error: contactError } = await db.from("contacts").insert({
    id: contactId,
    organization_id: session.organization_id,
    name: "Visitante",
    display_name: "Visitante",
    source: "webchat",
    source_metadata: { widget_public_id: parsed.data.widget_public_id },
  });
  if (contactError) {
    return fail("internal_error", "Não foi possível iniciar o atendimento.", 500, { requestId });
  }

  const conversationId = randomUUID();
  const { data: conversation, error: conversationError } = await db
    .from("conversations")
    .insert({
      id: conversationId,
      organization_id: session.organization_id,
      contact_id: contactId,
      channel_session_id: session.id,
      channel: "webchat",
      status: "open",
      provider_conversation_id: conversationId,
      metadata: { source: "webchat" },
    })
    .select("id")
    .single();

  if (conversationError || !conversation) {
    await db.from("contacts").delete().eq("id", contactId).eq("organization_id", session.organization_id);
    return fail("internal_error", "Não foi possível iniciar o atendimento.", 500, { requestId });
  }

  const token = gerarTokenDeAcessoWidget(conversation.id, session.organization_id, {
    widgetPublicId: session.webchat_public_id,
  });
  await audit({
    organizationId: session.organization_id,
    action: "conversation.created",
    resourceType: "conversation",
    resourceId: conversation.id,
    requestId,
    metadata: { source: "webchat", channel_session_id: session.id },
  });

  return ok(
    {
      token,
      expires_at: new Date(Date.now() + WEBCHAT_TOKEN_TTL_MS).toISOString(),
    },
    { requestId },
  );
}
