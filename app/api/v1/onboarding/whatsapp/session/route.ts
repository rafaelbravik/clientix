import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import { loadAuthUser, mfaEmDivida } from "@/lib/auth/server";
import { orgAtivaDaApi, requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWahaClient } from "@/lib/waha/client";
import { connectWahaChannel, ChannelConnectionError } from "@/lib/channels/connect-waha";
import { loadOnboardingChannel } from "@/lib/channels/onboarding-session";
import { checkChannelQuota } from "@/lib/tenant/plan-limits";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const user = await loadAuthUser(); if (!user) return fail("unauthenticated", "Sessão expirada", 401, { requestId });
  const ativa = await orgAtivaDaApi(user, requestId);
  if (!ativa.ok) return ativa.response;
  const org = ativa.org; if (!org) return fail("tenant_not_found", "Sem organização ativa", 404, { requestId });
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  const waha = getWahaClient(); if (!waha) return ok({ status: "WAHA_NOT_CONFIGURED", session: null }, { requestId });
  try {
    const db = await createClient(); const channel = await loadOnboardingChannel(db, org.orgId);
    if (!channel || channel.archived_at) return ok({ status: "NOT_STARTED", session: null }, { requestId });
    const remote = await waha.getVerifiedSession(channel.waha_session_name);
    const status = remote?.status ?? "STOPPED";
    const { error, data } = await db.from("channel_sessions").update({ status, last_health_check_at: new Date().toISOString() })
      .eq("organization_id", org.orgId).eq("id", channel.id).is("archived_at", null).select("id").maybeSingle();
    if (error || !data) throw new Error("connection_sync_failed");
    return ok({ status, session: channel.waha_session_name, channel_session_id: channel.id }, { requestId });
  } catch { return fail("connection_status_failed", "Não foi possível conferir a conexão. Tente novamente.", 502, { requestId }); }
}

export async function POST(req: Request): Promise<Response> {
  const denied = await requireSupportWrite(); if (denied) return denied;
  const requestId = randomUUID();
  const auth = await requireRole("admin", { requestId, resource: "channel_sessions", allowPlatformAdmin: true });
  if (!auth.ok) return auth.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  const waha = getWahaClient(); if (!waha) return fail("waha_not_configured", "O serviço de conexão está indisponível. Tente novamente.", 503, { requestId });
  const admin = createAdminClient();
  const idempotencyKey = req.headers.get("Idempotency-Key") ?? "";
  let existingSessionId: string | undefined = undefined;
  if (idempotencyKey) {
    const { data: existingReq } = await admin
      .from("channel_connection_requests")
      .select("channel_session_id")
      .eq("organization_id", auth.org.orgId)
      .eq("idempotency_key", idempotencyKey)
      .maybeSingle();
    if (existingReq?.channel_session_id) {
      existingSessionId = existingReq.channel_session_id;
    }
  }
  if (!existingSessionId) {
    const { data: onboardingChannel } = await admin
      .from("channel_sessions")
      .select("id")
      .eq("organization_id", auth.org.orgId)
      .eq("provider", "waha")
      .is("archived_at", null)
      .limit(1)
      .maybeSingle();
    if (onboardingChannel?.id) {
      existingSessionId = onboardingChannel.id;
    }
  }

  const quota = await checkChannelQuota(admin, auth.org.orgId, "whatsapp", {
    excludeChannelSessionId: existingSessionId,
  });
  if (!quota.allowed) {
    return fail("quota_exceeded", quota.reason ?? "Limite de conexões de canais atingido para o plano.", 403, {
      requestId,
      details: { current: quota.current, max: quota.max },
    });
  }
  try {
    const result = await connectWahaChannel(await createClient(), admin, waha, {
      organizationId: auth.org.orgId, idempotencyKey: req.headers.get("Idempotency-Key") ?? "",
      userId: auth.user.id, requestId, onboarding: true, restart: new URL(req.url).searchParams.get("restart") === "1",
    });
    return ok({ status: result.channel.status, session: result.channel.waha_session_name, channel_session_id: result.channel.id }, { requestId });
  } catch (error) {
    if (error instanceof ChannelConnectionError) return fail(error.code,
      error.code === "quota_exceeded" ? ((error.technical?.reason as string) ?? "Limite de conexões do plano atingido.")
        : error.code === "connection_in_progress" ? "A conexão ainda está sendo preparada. Aguarde e tente novamente."
        : error.code === "connection_session_name_too_long" ? "O identificador desta conexão passou do limite que o WhatsApp aceita. Nada foi criado no WhatsApp — atualize o sistema e tente novamente."
        : "Não foi possível concluir a conexão. Tente novamente ou repare o número em Conexões.",
      error.status, { requestId, details: error.technical });
    return fail("internal_error", "Não foi possível concluir a conexão. Tente novamente.", 500, { requestId });
  }
}
