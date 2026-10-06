import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
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
  const authHeader = req.headers.get("authorization");
  if (authHeader?.startsWith("Bearer ")) {
    token = authHeader.slice(7).trim();
  } else {
    const cookieToken = req.cookies.get("__clientix_widget")?.value;
    if (cookieToken) {
      token = cookieToken.trim();
    } else {
      token = url.searchParams.get("token")?.trim() ?? null;
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

  const { conversationId, organizationId } = validacao.payload;
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
      channel_sessions:channel_session_id (display_name, provider)
    `)
    .eq("id", conversationId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (convErr || !conversation) {
    return fail("not_found", "Conversa não encontrada.", 404, { requestId });
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
      kind,
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
  response.cookies.set("__clientix_widget", token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 30 * 24 * 60 * 60, // 30 dias
  });

  return response;
}
