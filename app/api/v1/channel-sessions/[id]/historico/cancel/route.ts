import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { audit } from "@/lib/audit";
import { fail, ok } from "@/lib/api/wrappers";
import { mfaEmDivida } from "@/lib/auth/server";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { z } from "zod";

export const dynamic = "force-dynamic";
const paramsSchema = z.object({ id: z.string().uuid() });

export async function POST(_req: NextRequest, context: { params: Promise<{ id: string }> }): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const params = paramsSchema.safeParse(await context.params);
  if (!params.success) return fail("validation_failed", "Identificador de conexão inválido.", 422, { requestId });
  const authz = await requireRole("manager", { requestId, resource: "channel_sessions" });
  if (!authz.ok) return authz.response;
  if (await mfaEmDivida()) return fail("mfa_required", "Confirme a verificação em duas etapas.", 403, { requestId });
  const admin = createAdminClient();
  const { data: session } = await admin.from("channel_sessions")
    .select("id").eq("id", params.data.id).eq("organization_id", authz.org.orgId).maybeSingle();
  if (!session) return fail("not_found", "Conexão não encontrada.", 404, { requestId });

  const jobs = admin.from("whatsapp_history_imports" as never);
  const { data: cancelled, error } = await jobs.update({
    status: "cancelled",
    last_error_code: "manual_cancel",
    finished_at: new Date().toISOString(),
    lease_token: null,
    lease_expires_at: null,
    next_attempt_at: null,
    updated_at: new Date().toISOString(),
  } as never)
    .eq("organization_id" as never, authz.org.orgId)
    .eq("channel_session_id" as never, session.id)
    .in("status" as never, ["pending", "running"])
    .select("id,status,imported_count,skipped_count,failed_count")
    .maybeSingle();
  if (error) return fail("internal_error", "Não foi possível cancelar a importação.", 500, { requestId });
  if (cancelled) {
    void audit({
      action: "channel.history_import_cancelled",
      actorUserId: authz.user.id,
      organizationId: authz.org.orgId,
      resourceType: "whatsapp_history_import",
      resourceId: (cancelled as { id: string }).id,
      requestId,
      metadata: {
        channel_session_id: session.id,
        reason_code: "manual_cancel",
        imported_count: (cancelled as { imported_count: number }).imported_count,
        skipped_count: (cancelled as { skipped_count: number }).skipped_count,
        failed_count: (cancelled as { failed_count: number }).failed_count,
      },
    });
    return ok({ status: "cancelled" }, { requestId });
  }
  const { data: latest } = await jobs.select("status" as never)
    .eq("organization_id" as never, authz.org.orgId)
    .eq("channel_session_id" as never, session.id)
    .order("updated_at" as never, { ascending: false })
    .limit(1 as never).maybeSingle();
  if ((latest as { status?: string } | null)?.status === "cancelled") return ok({ status: "cancelled" }, { requestId });
  return fail("conflict", "Não há importação ativa para cancelar.", 409, { requestId });
}
