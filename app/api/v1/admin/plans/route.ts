import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  requirePlatformAdmin,
  requirePlatformOwnerEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSupportWrite } from "@/lib/impersonate/support";

export const dynamic = "force-dynamic";

const updateSchema = z.object({
  slug: z.enum(["standard", "pro", "enterprise"]),
  name: z.string().trim().min(1).max(80),
  active: z.boolean(),
  max_users: z.number().int().positive().nullable(),
  max_channels: z.number().int().positive().nullable(),
  allowed_channels: z.array(z.string().trim().min(1).max(40)).max(32).nullable(),
  features: z.object({
    campaigns: z.boolean(),
    ai_agent: z.boolean(),
    voice_calls: z.boolean(),
    comment_to_dm: z.boolean(),
  }).strict(),
}).strict();

function adminClient(): SupabaseClient {
  return createAdminClient() as unknown as SupabaseClient;
}

export async function GET() {
  const requestId = randomUUID();
  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdmin>>;
  try {
    adminCtx = await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Requer administrador da plataforma.", 403, { requestId });
  }

  const { data, error } = await adminClient()
    .from("platform_plan_catalog")
    .select("slug, name, active, max_users, max_channels, allowed_channels, features, updated_at")
    .order("slug", { ascending: true });
  if (error || !data) {
    return fail("upstream_unavailable", "Não foi possível carregar os planos da instalação.", 503, { requestId });
  }
  void audit({
    action: "platform_admin.plans_listed",
    actorUserId: adminCtx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    requestId,
    metadata: { result_count: data.length },
  });
  return ok(data, { requestId, headers: { "Cache-Control": "no-store" } });
}

export async function PATCH(request: NextRequest) {
  const requestId = randomUUID();
  let owner: Awaited<ReturnType<typeof requirePlatformOwnerEscrita>>;
  try {
    owner = await requirePlatformOwnerEscrita();
  } catch {
    return fail("forbidden", "Somente o proprietário global pode alterar os planos.", 403, { requestId });
  }
  const supportFailure = await requireSupportWrite();
  if (supportFailure) return supportFailure;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("validation_error", "Payload inválido.", 400, { requestId });
  }
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Revise os campos do plano.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const input = parsed.data;
  const admin = adminClient();
  if (!input.active) {
    const { data: organizations, error: organizationsError } = await admin
      .from("organizations")
      .select("id, settings");
    if (organizationsError || !organizations) {
      return fail("upstream_unavailable", "Não foi possível conferir o uso atual deste plano.", 503, { requestId });
    }
    const assigned = organizations.filter((organization) => {
      const settings = organization.settings as Record<string, unknown> | null;
      const currentPlan = typeof settings?.plan === "string" ? settings.plan : "standard";
      return currentPlan === input.slug;
    }).length;
    if (assigned > 0) {
      return fail("conflict", "O plano não pode ser desativado enquanto estiver atribuído a empresas.", 409, {
        requestId,
        details: { assigned_organizations: assigned },
      });
    }
  }

  const { data, error } = await admin
    .from("platform_plan_catalog")
    .update({
      name: input.name,
      active: input.active,
      max_users: input.max_users,
      max_channels: input.max_channels,
      allowed_channels: input.allowed_channels,
      features: input.features,
      updated_by: owner.user.id,
      updated_at: new Date().toISOString(),
    })
    .eq("slug", input.slug)
    .select("slug, name, active, max_users, max_channels, allowed_channels, features, updated_at")
    .maybeSingle();
  if (error || !data) {
    return fail("upstream_unavailable", "Não foi possível salvar o plano.", 503, { requestId });
  }

  await audit({
    action: "platform_plan.updated",
    actorUserId: owner.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    resourceType: "platform_plan",
    resourceId: null,
    requestId,
    metadata: {
      active: input.active,
      slug: input.slug,
      max_users: input.max_users,
      max_channels: input.max_channels,
      feature_keys: Object.keys(input.features),
    },
  });
  return ok(data, { requestId });
}
