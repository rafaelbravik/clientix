import { createHash, randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { resolveClientIp } from "@/lib/channels/webhook-ip";
import { validarTokenDeAcessoWidget } from "@/lib/chat-widget/token";
import { readLimitedBody } from "@/lib/nuvemshop/safe-payload";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const sendMessageSchema = z.object({
  token: z.string().min(10).optional(),
  body: z.string().trim().min(1).max(4000),
});

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // 1. Limite estrito real de leitura do stream (64KB) independentemente de Content-Length
  const MAX_MESSAGE_PAYLOAD_BYTES = 64 * 1024;
  const bodyRead = await readLimitedBody(req, MAX_MESSAGE_PAYLOAD_BYTES);
  if (!bodyRead.ok) {
    return fail("payload_too_large", "payload exceeds limit", 413, { requestId });
  }

  // 2. Extração de credencial com precedência estrita:
  // Precedência: Authorization Bearer (primária) > Cookie HttpOnly > Body param (legado)
  const authHeader = req.headers.get("authorization");
  const bearerToken = authHeader?.startsWith("Bearer ") ? authHeader.slice(7).trim() : null;
  const cookieToken = req.cookies.get("__clientix_widget")?.value?.trim() || null;

  let json: unknown;
  try {
    json = JSON.parse(bodyRead.body);
  } catch {
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }

  const parsed = sendMessageSchema.safeParse(json);
  if (!parsed.success) {
    return fail("validation_failed", "Texto da mensagem ou token inválido.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  let token: string | null = null;
  if (bearerToken) {
    token = bearerToken;
  } else if (cookieToken) {
    token = cookieToken;
  } else {
    token = parsed.data.token?.trim() ?? null;
  }

  if (!token) {
    return fail("unauthorized", "Token de acesso não fornecido.", 401, { requestId });
  }

  const validacao = validarTokenDeAcessoWidget(token);
  if (!validacao.valido || !validacao.payload) {
    return fail("unauthorized", "Token de acesso inválido ou expirado.", 401, {
      requestId,
      details: { motivo: validacao.motivo },
    });
  }

  const { conversationId, organizationId } = validacao.payload;

  // 3. Rate limiting compartilhado (Redis/Upstash com fallback em memória)
  // A. Rate limit por sessão/conversa: 20 msgs/minuto (anti-flood/automação abusiva)
  const sessionHash = createHash("sha256").update(`${organizationId}:${conversationId}`).digest("hex").slice(0, 16);
  const sessionRl = await checkRateLimit(`widget_session:${sessionHash}`, 20, 60);
  if (!sessionRl.allowed) {
    return fail("rate_limited", "Muitas mensagens enviadas. Aguarde um momento.", 429, {
      requestId,
      headers: { "Retry-After": "60" },
    });
  }

  // B. Rate limit por IP confiável do cliente (Caddy/Traefik via resolveClientIp): 60 msgs/minuto
  const clientIp = resolveClientIp(req.headers);
  if (clientIp) {
    const ipHash = createHash("sha256").update(clientIp).digest("hex").slice(0, 16);
    const ipRl = await checkRateLimit(`widget_ip:${ipHash}`, 60, 60);
    if (!ipRl.allowed) {
      return fail("rate_limited", "Limite de requisições excedido para este IP.", 429, {
        requestId,
        headers: { "Retry-After": "60" },
      });
    }
  }

  const { body } = parsed.data;
  const db = createAdminClient();

  // 1. Carrega dados essenciais da conversa
  const { data: conv, error: convErr } = await db
    .from("conversations")
    .select("id, organization_id, contact_id, channel_session_id, status")
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (convErr || !conv) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  const agora = new Date().toISOString();
  const messageId = randomUUID();

  // 2. Insere a mensagem como inbound vinda do web widget
  const { data: novaMsg, error: insertErr } = await db
    .from("messages")
    .insert({
      id: messageId,
      organization_id: organizationId,
      conversation_id: conversationId,
      contact_id: conv.contact_id,
      channel_session_id: conv.channel_session_id,
      direction: "inbound",
      kind: "text",
      body,
      status: "delivered",
      sent_at: agora,
      metadata: { source: "web_widget" },
    })
    .select("id, direction, body, kind, sent_at, status")
    .single();

  if (insertErr || !novaMsg) {
    return fail("internal_error", "Erro ao gravar mensagem.", 500, { requestId });
  }

  // 3. Atualiza estado da conversa (última mensagem e contadores)
  await db
    .from("conversations")
    .update({
      last_inbound_at: agora,
      last_message_at: agora,
      last_message_preview: body.slice(0, 200),
      updated_at: agora,
      status: conv.status === "closed" ? "open" : conv.status,
    })
    .eq("id", conversationId)
    .eq("organization_id", organizationId);

  // 4. Aciona fn_service_inbound para atualizar a Demanda/Protocolo e orquestração do atendimento
  try {
    await db.rpc("fn_service_inbound", { p_message: messageId });
  } catch {
    // Não interrompe o retorno ao usuário se a trigger auxiliar já tiver rodado
  }

  return ok(novaMsg, { requestId });
}
