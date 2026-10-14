import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { CHANNEL_PROVIDER_WEBCHAT } from "@/lib/channels/capabilities";
import { createWebchatSession } from "@/lib/channels/webchat-session";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkChannelQuota } from "@/lib/tenant/plan-limits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const configSchema = z.object({ enabled: z.boolean() }).strict();

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_webchat" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("channel_sessions")
    .select("id, webchat_public_id, status")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", CHANNEL_PROVIDER_WEBCHAT)
    .is("archived_at", null)
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível carregar a configuração do WebChat.", 500, { requestId });

  const session = data as unknown as { id: string; webchat_public_id: string; status: string } | null;
  return ok(
    session
      ? {
          connected: true,
          enabled: session.status === "WORKING",
          widget_public_id: session.webchat_public_id,
        }
      : { connected: false, enabled: false, widget_public_id: null },
    { requestId },
  );
}

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "channels_webchat" });
  if (!authz.ok) return authz.response;

  let body: unknown;
  try {
    const raw = await req.text();
    if (Buffer.byteLength(raw, "utf8") > 4096) {
      return fail("payload_too_large", "payload exceeds limit", 413, { requestId });
    }
    body = JSON.parse(raw);
  } catch {
    return fail("invalid_request", "invalid_json", 400, { requestId });
  }
  const parsed = configSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "Configuração inválida para o WebChat.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const { data: existingData, error: lookupError } = await admin
    .from("channel_sessions")
    .select("id, webchat_public_id, status")
    .eq("organization_id", authz.org.orgId)
    .eq("provider", CHANNEL_PROVIDER_WEBCHAT)
    .is("archived_at", null)
    .maybeSingle();
  if (lookupError) return fail("internal_error", "Não foi possível carregar a configuração do WebChat.", 500, { requestId });

  const existing = existingData as unknown as { id: string; webchat_public_id: string; status: string } | null;
  if (!existing && !parsed.data.enabled) {
    return ok({ connected: false, enabled: false, widget_public_id: null }, { requestId });
  }

  if (existing) {
    const nextStatus = parsed.data.enabled ? "WORKING" : "STOPPED";
    if (existing.status !== nextStatus) {
      const { error } = await admin
        .from("channel_sessions")
        .update({ status: nextStatus, last_status_change_at: new Date().toISOString() })
        .eq("id", existing.id)
        .eq("organization_id", authz.org.orgId);
      if (error) return fail("internal_error", "Não foi possível atualizar o WebChat.", 500, { requestId });

      await audit({
        organizationId: authz.org.orgId,
        actorUserId: authz.user.id,
        action: "channel.connected",
        resourceType: "channel_session",
        resourceId: existing.id,
        requestId,
        metadata: { provider: CHANNEL_PROVIDER_WEBCHAT, enabled: parsed.data.enabled },
      });
    }
    return ok(
      {
        connected: true,
        enabled: parsed.data.enabled,
        widget_public_id: existing.webchat_public_id,
      },
      { requestId },
    );
  }

  const quota = await checkChannelQuota(admin, authz.org.orgId, "webchat");
  if (!quota.allowed) {
    return fail("quota_exceeded", quota.reason ?? "Limite de conexões do plano atingido.", 403, {
      requestId,
      details: { current: quota.current, max: quota.max },
    });
  }

  const { data: createdData, error: insertError } = await createWebchatSession(admin, {
    organizationId: authz.org.orgId,
    createdBy: authz.user.id,
  });

  if (insertError || !createdData) {
    if (insertError?.code === "23505") {
      return fail("conflict", "Uma configuração WebChat já existe para esta organização.", 409, { requestId });
    }
    return fail("internal_error", "Não foi possível ativar o WebChat.", 500, { requestId });
  }
  const created = createdData;
  if (!created) return fail("internal_error", "Não foi possível ativar o WebChat.", 500, { requestId });

  await audit({
    organizationId: authz.org.orgId,
    actorUserId: authz.user.id,
    action: "channel.connected",
    resourceType: "channel_session",
    resourceId: created.id,
    requestId,
    metadata: { provider: CHANNEL_PROVIDER_WEBCHAT, enabled: true },
  });

  return ok(
    { connected: true, enabled: true, widget_public_id: created.webchat_public_id },
    { requestId },
  );
}
