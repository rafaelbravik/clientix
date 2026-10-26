import { requireSupportWrite } from "@/lib/impersonate/support";
/**
 * POST /api/v1/ai/followups/enrollments/:id/cancel (manager+) — encerra um
 *   enrollment ainda cancelável manualmente pela
 *   fila. 409 `already_terminal` se já tiver encerrado (completed/cancelled/
 *   dead) — cancelar 2x não é erro operacional, mas também não deve reescrever
 *   o desfecho de um enrollment que já fechou por conta própria.
 *
 * Promessas (`cron_jobs`) NÃO são canceláveis por aqui — fora de escopo desta
 *   task; só enrollments do motor.
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { logger } from "@/lib/logger";
import { createClient } from "@/lib/supabase/server";
import { traduzir } from "@/lib/i18n/dicionario";

export const dynamic = "force-dynamic";

const UUID_RX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Esta classificação é específica do cancelamento. `dormente` (0308) não é
// ativo para reatividade nem ocupa vaga no índice anti-empilhamento, mas segue
// logicamente em curso e pode ser encerrado sem ser acordado. Não ampliar a
// lista LIVE da reatividade: cada consumidor tem uma semântica própria.
// `paused_manual` (0145) pode sair sem ser retomado, e `coletando` (0394) pode
// ser encerrado pela fila.
const CANCELABLE_STATUSES = [
  "active",
  "waiting_reply",
  "dormente",
  "paused_handoff",
  "paused_manual",
  "coletando",
];

type RouteCtx = { params: Promise<{ id: string }> };

export async function POST(_req: NextRequest, ctx: RouteCtx): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await ctx.params;
  if (!UUID_RX.test(id)) {
    return fail("invalid_request", "id inválido.", 400, { requestId });
  }

  const authz = await requireRole("manager", { requestId, resource: "followup_enrollments" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { user, org: activeOrg } = authz;

  const supabase = await createClient();
  const { data: existing, error: fetchErr } = await supabase
    .from("followup_enrollments")
    .select("id, status, current_node_id, claimed_until")
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    .maybeSingle();
  if (fetchErr) return fail("internal_error", fetchErr.message, 500, { requestId });
  if (!existing) return fail("not_found", t("Enrollment não encontrado."), 404, { requestId });

  if (!(CANCELABLE_STATUSES as readonly string[]).includes(existing.status)) {
    return fail("already_terminal", t("Enrollment já está encerrado."), 409, { requestId });
  }

  const agora = new Date();
  const agoraIso = agora.toISOString();
  if (existing.claimed_until && Date.parse(existing.claimed_until) > agora.getTime()) {
    return fail(
      "state_conflict",
      t("O automático está executando este follow-up agora. Nada foi alterado — tente de novo em alguns instantes."),
      409,
      { requestId },
    );
  }

  const { data: updated, error: updErr } = await supabase
    .from("followup_enrollments")
    .update({
      status: "cancelled",
      cancel_reason: "manual",
      next_eval_at: null,
      claimed_until: null,
      outcome: null,
      completed_at: agoraIso,
      updated_at: agoraIso,
    })
    .eq("id", id)
    .eq("organization_id", activeOrg.orgId)
    // A leitura não reserva a linha. CAS de status fecha a corrida com outro
    // operador/reactivity; a condição do lease impede sobrescrever um tick que
    // já foi reclamado entre a leitura e este UPDATE.
    .eq("status", existing.status)
    .or(`claimed_until.is.null,claimed_until.lt.${agoraIso}`)
    .select("id, status, cancel_reason, updated_at")
    .maybeSingle();
  if (updErr) {
    return fail("internal_error", updErr.message, 500, { requestId });
  }
  if (!updated) {
    return fail(
      "state_conflict",
      t("Este follow-up mudou de estado ou está sendo executado. Nada foi alterado — recarregue e confira."),
      409,
      { requestId },
    );
  }

  const { error: eventErr } = await supabase.from("followup_enrollment_events").insert({
    organization_id: activeOrg.orgId,
    enrollment_id: id,
    node_id: existing.current_node_id,
    event_type: "cancelled_manual",
    payload: { actor_user_id: user.id },
  });
  if (eventErr) {
    logger.error("[followup.enrollment.cancel] event insert failed", { error: eventErr.message, requestId });
  }

  void audit({
    action: "followup_enrollment.cancelled",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "followup_enrollment",
    resourceId: id,
    requestId,
    metadata: { previous_status: existing.status },
  });

  return ok(updated, { requestId });
}
