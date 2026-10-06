import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { invalidateWebhookCacheBySessionId } from "@/lib/channels/webhook-session-cache";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const deleteSessionSchema = z.object({
  channel_session_id: z.string().uuid().optional(),
  telegram_user_id: z.string().trim().optional(),
});

export async function GET(req: NextRequest): Promise<NextResponse> {
  const requestId = randomUUID();
  const authz = await requireRole("viewer", { requestId, resource: "channels_telegram_user" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data: sessoes, error } = await admin
    .from("channel_sessions")
    .select("id, telegram_user_id, telegram_phone, telegram_api_id, display_name, status, created_at")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", "telegram_user")
    .is("archived_at", null)
    .order("created_at", { ascending: false });

  if (error) {
    return fail("internal_error", "Falha ao buscar contas Telegram do atendente.", 500, {
      requestId,
    });
  }

  return ok(
    {
      sessions: (sessoes ?? []).map((s) => ({
        id: s.id,
        telegram_user_id: s.telegram_user_id,
        telegram_phone: s.telegram_phone,
        telegram_api_id: s.telegram_api_id,
        display_name: s.display_name,
        status: s.status,
        created_at: s.created_at,
      })),
    },
    { requestId },
  );
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_telegram_user" });
  if (!authz.ok) return authz.response;

  const json = await req.json().catch(() => ({}));
  const parsed = deleteSessionSchema.safeParse(json);
  if (!parsed.success) {
    return fail("validation_failed", "Identificador de sessão ou usuário inválido.", 422, {
      requestId,
    });
  }

  const { channel_session_id, telegram_user_id } = parsed.data;
  if (!channel_session_id && !telegram_user_id) {
    return fail("bad_request", "Informe channel_session_id ou telegram_user_id.", 400, {
      requestId,
    });
  }

  const admin = createAdminClient();
  let query = admin
    .from("channel_sessions")
    .select("id, telegram_user_id")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", "telegram_user")
    .is("archived_at", null);

  if (channel_session_id) {
    query = query.eq("id", channel_session_id);
  } else if (telegram_user_id) {
    query = query.eq("telegram_user_id", telegram_user_id);
  }

  const { data: sessao } = await query.maybeSingle();

  if (!sessao) {
    return fail("not_found", "Sessão Telegram Usuário não encontrada.", 404, { requestId });
  }

  await admin
    .from("channel_sessions")
    .update({ archived_at: new Date().toISOString(), status: "disconnected" })
    .eq("id", sessao.id);

  invalidateWebhookCacheBySessionId(sessao.id);

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "channel.archived",
    resourceType: "channel_session",
    resourceId: sessao.id,
    metadata: {
      provider: "telegram_user",
      telegram_user_id: sessao.telegram_user_id,
    },
  });

  return ok({ disconnected: true }, { requestId });
}
