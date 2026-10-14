import { createHash, randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { checkRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { CHANNEL_PROVIDER_WEBCHAT } from "@/lib/channels/capabilities";
import { resolveClientIp } from "@/lib/channels/webhook-ip";
import { validarTokenDeAcessoWidget } from "@/lib/chat-widget/token";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const url = new URL(req.url);

  // 1. Extração e precedência estrita de credenciais:
  // Precedência: Authorization Bearer (fonte primária moderna) > Cookie HttpOnly > Query param (legado)
  // Se uma fonte explícita mais prioritária for fornecida (ex: Bearer), ela DEVE ser válida e não faz fallback silencioso.
  let token: string | null = null;
  let tokenSource: "bearer" | "cookie" | "query" | null = null;
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
    tokenSource = "bearer";
  } else {
    const cookieToken = req.cookies.get("__clientix_widget")?.value;
    if (cookieToken) {
      token = cookieToken.trim();
      tokenSource = "cookie";
    } else {
      token = url.searchParams.get("token")?.trim() ?? null;
      if (token) tokenSource = "query";
    }
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
  if (tokenSource === "query" && validacao.payload.widgetPublicId) {
    return fail("unauthorized", "Sessões WebChat devem usar Authorization: Bearer.", 401, {
      requestId,
    });
  }

  const { conversationId, organizationId } = validacao.payload;
  const tokenHash = createHash("sha256").update(token).digest("hex").slice(0, 24);
  const sessionLimit = await checkRateLimit(`widget_read_session:${tokenHash}`, 120, 60);
  if (!sessionLimit.allowed) {
    return fail("rate_limited", "Muitas consultas ao atendimento. Aguarde um momento.", 429, {
      requestId,
      headers: { "Retry-After": "60" },
    });
  }
  const clientIp = resolveClientIp(req.headers);
  if (clientIp) {
    const ipHash = createHash("sha256").update(clientIp).digest("hex").slice(0, 24);
    const ipLimit = await checkRateLimit(`widget_read_ip:${ipHash}`, 300, 60);
    if (!ipLimit.allowed) {
      return fail("rate_limited", "Limite de consultas excedido para este IP.", 429, {
        requestId,
        headers: { "Retry-After": "60" },
      });
    }
  }
  const db = createAdminClient();

  // 1. Busca conversa com contato e protocolo
  const { data: conversation, error: convErr } = await db
    .from("conversations")
    .select(`
      id,
      organization_id,
      protocolo,
      status,
      created_at,
      contacts:contact_id (id, display_name, name),
      channel_sessions:channel_session_id (display_name, provider, status, webchat_public_id, archived_at)
    `)
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (convErr || !conversation) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
  }

  const session = conversation.channel_sessions as {
    provider?: string;
    status?: string;
    webchat_public_id?: string | null;
    archived_at?: string | null;
  } | null;
  if (
    validacao.payload.widgetPublicId !== undefined ||
    session?.provider === CHANNEL_PROVIDER_WEBCHAT
  ) {
    if (
      !validacao.payload.widgetPublicId ||
      session?.provider !== CHANNEL_PROVIDER_WEBCHAT ||
      session.webchat_public_id !== validacao.payload.widgetPublicId ||
      session.status !== "WORKING" ||
      session.archived_at
    ) {
      return fail("not_found", "Conversa não encontrada.", 404, { requestId });
    }
  }

  // 2. Busca dados de identidade visual da organização
  const { data: org } = await db
    .from("organizations")
    .select("name, settings")
    .eq("id", organizationId)
    .maybeSingle();

  const settings = (org?.settings as Record<string, unknown>) ?? {};
  const branding = (settings.branding as Record<string, unknown>) ?? {};

  const orgInfo = {
    name: org?.name ?? "Atendimento",
    app_name: (branding.app_name as string) || org?.name || "Atendimento",
    logo_url: (branding.logo_url as string) || null,
    accent_color: (branding.accent_color as string) || "#0284c7",
  };

  // 3. Busca últimas 50 mensagens da conversa
  const { data: msgsData, error: msgErr } = await db
    .from("messages")
    .select(`
      id,
      direction,
      body,
      kind:type,
      media_url,
      media_mime,
      sent_at,
      status
    `)
    .eq("conversation_id", conversationId)
    .eq("organization_id", organizationId)
    .order("sent_at", { ascending: true })
    .limit(50);

  if (msgErr) {
    return fail("internal_error", "Erro ao carregar mensagens.", 500, { requestId });
  }

  const response = ok(
    {
      conversation: {
        id: conversation.id,
        protocolo: conversation.protocolo ?? null,
        status: conversation.status,
        contact: conversation.contacts,
      },
      organization: orgInfo,
      messages: msgsData ?? [],
    },
    { requestId },
  );

  // Define cookie HttpOnly com SameSite=Lax e escopo restrito para navegação subsequente
  response.headers.set("Cache-Control", "no-store");
  if (!validacao.payload.widgetPublicId) {
    response.cookies.set("__clientix_widget", token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      path: "/api/v1/widget",
      maxAge: 30 * 24 * 60 * 60,
    });
  }

  return response;
}
