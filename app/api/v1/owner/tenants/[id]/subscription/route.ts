import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformOwner,
  requirePlatformOwnerEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const idSchema = z.string().uuid();

function uuidOuNull(value: unknown): string | null {
  const parsed = idSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const updateSchema = z
  .object({
    plan_slug: z.enum(["standard", "pro", "enterprise"]),
    status: z.enum(["trialing", "active", "past_due", "canceled", "suspended", "expired"]),
    billing_interval: z.enum(["monthly", "annual", "custom"]),
    price_cents: z.number().int().nonnegative().max(999_999_999_900).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/),
    current_period_starts_at: z.string().datetime({ offset: true }),
    current_period_ends_at: z.string().datetime({ offset: true }),
    trial_ends_at: z.string().datetime({ offset: true }).nullable(),
    cancel_at_period_end: z.boolean(),
  })
  .strict()
  .superRefine((value, context) => {
    if (Date.parse(value.current_period_ends_at) <= Date.parse(value.current_period_starts_at)) {
      context.addIssue({ code: "custom", message: "O fim do período deve ser posterior ao início.", path: ["current_period_ends_at"] });
    }
    if (["active", "trialing", "past_due"].includes(value.status) && Date.parse(value.current_period_ends_at) <= Date.now()) {
      context.addIssue({ code: "custom", message: "A assinatura válida precisa terminar no futuro.", path: ["current_period_ends_at"] });
    }
    if (value.status === "trialing" && !value.trial_ends_at) {
      context.addIssue({ code: "custom", message: "Informe o fim do período de teste.", path: ["trial_ends_at"] });
    }
    if (value.status === "trialing" && value.trial_ends_at && Date.parse(value.trial_ends_at) <= Date.now()) {
      context.addIssue({ code: "custom", message: "O período de teste precisa terminar no futuro.", path: ["trial_ends_at"] });
    }
    if (value.cancel_at_period_end && value.status !== "active" && value.status !== "past_due") {
      context.addIssue({ code: "custom", message: "Cancelamento no fim do período requer assinatura ativa ou em atraso.", path: ["cancel_at_period_end"] });
    }
  });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = randomUUID();
  const { id: rawId } = await params;
  const parsedId = idSchema.safeParse(rawId);
  if (!parsedId.success) {
    return fail("validation_error", "Identificador da empresa inválido.", 400, { requestId });
  }

  let owner: Awaited<ReturnType<typeof requirePlatformOwner>>;
  try {
    owner = await requirePlatformOwner();
  } catch {
    return fail("forbidden", "Requer proprietário da instalação.", 403, { requestId });
  }

  const organizationId = parsedId.data;
  const admin = createAdminClient();

  const [organizationResult, subscriptionResult, plansResult] = await Promise.all([
    admin
      .from("organizations")
      .select("id, slug, display_name, settings")
      .eq("id", organizationId)
      .maybeSingle(),
    admin
      .from("tenant_plan_subscriptions" as never)
      .select("id, organization_id, plan_slug, status, billing_interval, price_cents, currency, current_period_starts_at, current_period_ends_at, trial_ends_at, cancel_at_period_end, canceled_at, ended_at, created_at, updated_at")
      .eq("organization_id", organizationId)
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .limit(1)
      .maybeSingle(),
    admin
      .from("platform_plan_catalog" as never)
      .select("slug, name, max_users, max_channels, allowed_channels, features")
      .eq("active", true)
      .order("slug", { ascending: true }),
  ]);

  if (organizationResult.error) {
    return fail("upstream_unavailable", "Não foi possível carregar a empresa.", 503, { requestId });
  }
  if (!organizationResult.data) {
    return fail("not_found", "Empresa não encontrada.", 404, { requestId });
  }
  if (subscriptionResult.error || plansResult.error || !plansResult.data) {
    return fail("upstream_unavailable", "Não foi possível carregar o plano e a assinatura.", 503, { requestId });
  }

  const settings = (organizationResult.data.settings as Record<string, unknown> | null) ?? {};
  const subscription = subscriptionResult.data as unknown as Record<string, unknown> | null;
  const subscriptionId = uuidOuNull(subscription?.id);
  const configuredPlan = typeof settings.plan === "string" ? settings.plan : "standard";
  const plan = subscription?.plan_slug ?? configuredPlan;

  void audit({
    action: "platform_owner.tenant_subscription_viewed",
    actorUserId: owner.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId,
    resourceType: "tenant_plan_subscription",
    resourceId: subscriptionId,
    requestId,
    metadata: { has_subscription: subscription !== null },
  });

  return ok(
    {
      organization: {
        id: organizationResult.data.id,
        slug: organizationResult.data.slug,
        display_name: organizationResult.data.display_name,
      },
      plan,
      subscription,
      plans: plansResult.data,
    },
    { requestId, headers: { "Cache-Control": "no-store" } },
  );
}

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const requestId = randomUUID();
  const { id: rawId } = await params;
  const parsedId = idSchema.safeParse(rawId);
  if (!parsedId.success) {
    return fail("validation_error", "Identificador da empresa inválido.", 400, { requestId });
  }

  const body = await request.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Revise os campos da assinatura.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const supportDenied = await requireSupportWrite(parsedId.data);
  if (supportDenied) return supportDenied;

  let owner: Awaited<ReturnType<typeof requirePlatformOwnerEscrita>>;
  try {
    owner = await requirePlatformOwnerEscrita();
  } catch (error) {
    return falhaDaEscritaDePlatformAdmin(error, requestId, "Requer proprietário da instalação.");
  }

  const input = parsed.data;
  const admin = createAdminClient();
  const { data, error } = await admin.rpc("fn_platform_set_tenant_plan_subscription" as never, {
    p_actor: owner.user.id,
    p_organization_id: parsedId.data,
    p_plan_slug: input.plan_slug,
    p_status: input.status,
    p_billing_interval: input.billing_interval,
    p_price_cents: input.price_cents,
    p_currency: input.currency,
    p_current_period_starts_at: input.current_period_starts_at,
    p_current_period_ends_at: input.current_period_ends_at,
    p_trial_ends_at: input.trial_ends_at,
    p_cancel_at_period_end: input.cancel_at_period_end,
  } as never);

  if (error) {
    if (error.code === "22023" && error.message === "plan_unavailable") {
      return fail("validation_error", "Este plano está desativado e não pode ser contratado.", 422, { requestId });
    }
    if (error.code === "P0002") return fail("not_found", "Empresa não encontrada.", 404, { requestId });
    if (error.code === "23505") return fail("conflict", "A empresa já tem uma alteração concorrente de assinatura. Atualize a tela.", 409, { requestId });
    if (error.code === "42501") return fail("forbidden", "Somente o proprietário pode alterar a assinatura.", 403, { requestId });
    if (error.code === "22023" || error.code === "23514") {
      return fail("validation_error", "Os dados da assinatura não são válidos.", 422, { requestId });
    }
    return fail("internal_error", "Não foi possível salvar a assinatura da empresa.", 500, { requestId });
  }

  const subscription = data as unknown as Record<string, unknown>;
  const subscriptionId = uuidOuNull(subscription?.id);
  await audit({
    action: "platform_owner.tenant_subscription_updated",
    actorUserId: owner.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: parsedId.data,
    resourceType: "tenant_plan_subscription",
    resourceId: subscriptionId,
    requestId,
    metadata: {
      plan_slug: input.plan_slug,
      status: input.status,
      billing_interval: input.billing_interval,
      price_cents: input.price_cents,
      currency: input.currency,
      cancel_at_period_end: input.cancel_at_period_end,
    },
  });

  return ok({ subscription }, { requestId });
}
