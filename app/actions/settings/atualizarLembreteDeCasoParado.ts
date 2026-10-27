"use server";

import { headers } from "next/headers";
import { revalidatePath } from "next/cache";

import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { ROLE_RANK, escreveComoPlatformAdmin } from "@/lib/auth/types";
import { supportWriteError } from "@/lib/impersonate/support";
import {
  caseWaitReminderConfigSchema,
  type CaseWaitReminderConfig,
} from "@/lib/cases/case-wait-reminders";
import { createAdminClient } from "@/lib/supabase/admin";

export type ResultadoLembreteDeCasoParado =
  | { ok: true }
  | {
      ok: false;
      error: "validation_failed" | "unauthenticated" | "forbidden_tenant" | "forbidden_role" | "mfa_required" | "db_error";
    };

export async function atualizarLembreteDeCasoParado(
  input: CaseWaitReminderConfig,
): Promise<ResultadoLembreteDeCasoParado> {
  const parsed = caseWaitReminderConfigSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "validation_failed" };

  const user = await loadAuthUser();
  if (!user) return { ok: false, error: "unauthenticated" };
  if (supportWriteError(user.support)) return { ok: false, error: "forbidden_role" };
  const org = await resolveActiveOrg(user);
  if (!org) return { ok: false, error: "forbidden_tenant" };
  if (!(escreveComoPlatformAdmin(user) && !user.support) && ROLE_RANK[org.role] < ROLE_RANK.admin) {
    return { ok: false, error: "forbidden_role" };
  }
  if (await mfaEmDivida()) return { ok: false, error: "mfa_required" };

  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_definir_case_wait_reminder_config", {
    p_org: org.orgId,
    p_actor: user.id,
    p_enabled: parsed.data.enabled,
    p_interval_hours: parsed.data.interval_hours,
    p_reminder_limit: parsed.data.limit,
  });
  if (error || data !== 1) return { ok: false, error: "db_error" };

  const requestId = (await headers()).get("x-request-id");
  await audit({
    action: "ai.case_wait_reminder_config_updated",
    actorUserId: user.id,
    organizationId: org.orgId,
    resourceType: "organization",
    resourceId: org.orgId,
    requestId,
    metadata: {
      enabled: parsed.data.enabled,
      interval_hours: parsed.data.interval_hours,
      limit: parsed.data.limit,
    },
  });

  revalidatePath("/app/ai/inbox");
  return { ok: true };
}
