import { randomUUID } from "node:crypto";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import { resolveTenantPlanLimitsFromCatalog } from "@/lib/tenant/plan-limits";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const patchLimitsSchema = z.object({
  plan: z.enum(["standard", "pro", "enterprise"]).optional(),
  plan_limits: z
    .object({
      max_users: z.number().int().positive().nullable().optional(),
      max_channels: z.number().int().positive().nullable().optional(),
      allowed_channels: z.array(z.string()).nullable().optional(),
      features: z
        .object({
          campaigns: z.boolean().optional(),
          ai_agent: z.boolean().optional(),
          voice_calls: z.boolean().optional(),
          comment_to_dm: z.boolean().optional(),
        })
        .optional(),
    })
    .optional(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const requestId = randomUUID();
  const { id } = await params;

  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Requer administrador da plataforma.", 403, { requestId });
  }

  const admin = createAdminClient();
  const { data: org, error } = await admin
    .from("organizations")
    .select("id, slug, display_name, settings")
    .eq("id", id)
    .single();

  if (error || !org) {
    return fail("not_found", "Organização não encontrada.", 404, { requestId });
  }

  const settings = (org.settings as Record<string, unknown>) || {};
  const limits = await resolveTenantPlanLimitsFromCatalog(admin as unknown as SupabaseClient, settings, id);
  if (!limits) {
    return fail("upstream_unavailable", "Não foi possível validar o catálogo de planos da instalação.", 503, { requestId });
  }

  const [usersRes, channelsRes] = await Promise.all([
    admin
      .from("user_organizations")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id)
      .is("revoked_at", null),
    admin
      .from("channel_sessions")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", id)
      .is("archived_at", null),
  ]);

  return ok(
    {
      organization_id: org.id,
      slug: org.slug,
      display_name: org.display_name,
      plan: limits.plan,
      limits,
      current_usage: {
        active_users: usersRes.count ?? 0,
        active_channels: channelsRes.count ?? 0,
      },
    },
    { requestId },
  );
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const { id } = await params;

  let adminCtx;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const json = await req.json().catch(() => ({}));
  const parsed = patchLimitsSchema.safeParse(json);
  if (!parsed.success) {
    return fail("validation_failed", "Payload de limites inválido.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const { plan, plan_limits } = parsed.data;
  const admin = createAdminClient();
  const planClient = admin as unknown as SupabaseClient;

  if (plan) {
    const { data: subscription, error: subscriptionError } = await planClient
      .from("tenant_plan_subscriptions" as never)
      .select("plan_slug, status")
      .eq("organization_id", id)
      .in("status", ["trialing", "active", "past_due", "suspended"])
      .maybeSingle();
    if (subscriptionError) {
      return fail("upstream_unavailable", "Não foi possível conferir a assinatura atual da empresa.", 503, { requestId });
    }
    const subscriptionRow = subscription as { plan_slug?: string } | null;
    if (subscriptionRow && subscriptionRow.plan_slug !== plan) {
      return fail("conflict", "Esta empresa possui uma assinatura. Altere o plano na gestão de assinatura.", 409, { requestId });
    }

    const { data: planRow, error: planError } = await planClient
      .from("platform_plan_catalog")
      .select("slug, active")
      .eq("slug", plan)
      .maybeSingle();
    if (planError || !planRow) {
      return fail("upstream_unavailable", "Não foi possível validar o plano selecionado.", 503, { requestId });
    }
    if (planRow.active !== true) {
      return fail("validation_error", "Este plano não está disponível para atribuição.", 422, { requestId });
    }
  }

  const { data: org, error: fetchErr } = await admin
    .from("organizations")
    .select("id, slug, display_name, settings")
    .eq("id", id)
    .single();

  if (fetchErr || !org) {
    return fail("not_found", "Organização não encontrada.", 404, { requestId });
  }

  const existingSettings = (org.settings as Record<string, unknown>) || {};
  const newSettings = {
    ...existingSettings,
    ...(plan ? { plan } : {}),
    ...(plan_limits
      ? {
          plan_limits: {
            ...((existingSettings.plan_limits as Record<string, unknown>) || {}),
            ...plan_limits,
          },
        }
      : {}),
  };

  const resolvedLimits = await resolveTenantPlanLimitsFromCatalog(planClient, newSettings, id);
  if (!resolvedLimits) {
    return fail("upstream_unavailable", "Não foi possível validar os limites finais do plano.", 503, { requestId });
  }

  const { error: updateErr } = await admin
    .from("organizations")
    .update({
      settings: newSettings,
      updated_at: new Date().toISOString(),
    })
    .eq("id", id);

  if (updateErr) {
    return fail("internal_error", "Falha ao atualizar limites da organização.", 500, {
      requestId,
    });
  }

  await audit({
    action: "platform_admin.tenant_limits_updated",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: id,
    resourceType: "organization",
    resourceId: id,
    requestId,
    metadata: {
      tenant_slug: org.slug,
      plan: resolvedLimits.plan,
      max_users: resolvedLimits.max_users,
      max_channels: resolvedLimits.max_channels,
    },
  });

  return ok(
    {
      updated: true,
      plan: resolvedLimits.plan,
      limits: resolvedLimits,
    },
    { requestId },
  );
}
