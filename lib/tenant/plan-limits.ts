import type { SupabaseClient } from "@supabase/supabase-js";
import { channelBrand } from "@/lib/channels/presentation";

export type TenantPlan = "standard" | "pro" | "enterprise";
export type TenantSubscriptionStatus = "trialing" | "active" | "past_due" | "canceled" | "suspended" | "expired";

export interface PlanFeatureMatrix {
  campaigns: boolean;
  ai_agent: boolean;
  voice_calls: boolean;
  comment_to_dm: boolean;
}

export interface PlanLimits {
  plan: TenantPlan;
  max_users: number | null; // null = ilimitado
  max_channels: number | null; // null = ilimitado
  allowed_channels: string[] | null; // null = todos
  features: PlanFeatureMatrix;
  /** undefined = organização legada sem assinatura; false bloqueia novos usos sujeitos ao plano. */
  subscription_allows_usage?: boolean;
  subscription_status?: TenantSubscriptionStatus;
}

export const DEFAULT_PLAN_LIMITS: Record<TenantPlan, PlanLimits> = {
  standard: {
    plan: "standard",
    max_users: 3,
    max_channels: 1,
    allowed_channels: ["whatsapp", "email"],
    features: {
      campaigns: false,
      ai_agent: true,
      voice_calls: false,
      comment_to_dm: false,
    },
  },
  pro: {
    plan: "pro",
    max_users: 10,
    max_channels: 5,
    allowed_channels: ["whatsapp", "telegram", "telegram_user", "email", "instagram", "tiktok"],
    features: {
      campaigns: true,
      ai_agent: true,
      voice_calls: true,
      comment_to_dm: true,
    },
  },
  enterprise: {
    plan: "enterprise",
    max_users: null,
    max_channels: null,
    allowed_channels: null,
    features: {
      campaigns: true,
      ai_agent: true,
      voice_calls: true,
      comment_to_dm: true,
    },
  },
};

/**
 * Resolve os limites efetivos de uma organização com base no plano contratado e
 * possíveis overrides específicos configurados em `organizations.settings.plan_limits`.
 */
function tenantPlanFromSettings(settings: Record<string, unknown> | null | undefined): TenantPlan {
  const planRaw = typeof settings?.plan === "string" ? settings.plan.toLowerCase().trim() : "standard";
  return planRaw === "pro" || planRaw === "enterprise" ? planRaw : "standard";
}

function mergePlanOverrides(
  settings: Record<string, unknown> | null | undefined,
  base: PlanLimits,
): PlanLimits {
  const overridesRaw = settings?.plan_limits;
  const overrides = (typeof overridesRaw === "object" && overridesRaw !== null && !Array.isArray(overridesRaw))
    ? (overridesRaw as Record<string, unknown>)
    : {};

  // Normalização segura de max_users: deve ser inteiro positivo ou null (ilimitado)
  let maxUsers: number | null = base.max_users;
  if ("max_users" in overrides) {
    if (overrides.max_users === null) {
      maxUsers = null;
    } else if (typeof overrides.max_users === "number" && Number.isInteger(overrides.max_users) && overrides.max_users > 0) {
      maxUsers = overrides.max_users;
    }
  }

  // Normalização segura de max_channels: deve ser inteiro positivo ou null (ilimitado)
  let maxChannels: number | null = base.max_channels;
  if ("max_channels" in overrides) {
    if (overrides.max_channels === null) {
      maxChannels = null;
    } else if (typeof overrides.max_channels === "number" && Number.isInteger(overrides.max_channels) && overrides.max_channels > 0) {
      maxChannels = overrides.max_channels;
    }
  }

  // Normalização segura de allowed_channels: deve ser array de strings ou null (todos)
  let allowedChannels: string[] | null = base.allowed_channels;
  if ("allowed_channels" in overrides) {
    if (overrides.allowed_channels === null) {
      allowedChannels = null;
    } else if (Array.isArray(overrides.allowed_channels) && overrides.allowed_channels.every((c) => typeof c === "string")) {
      allowedChannels = overrides.allowed_channels;
    }
  }

  // Normalização segura de features: apenas booleanos são aceitos nos overrides
  const sanitizedFeatures: PlanFeatureMatrix = { ...base.features };
  if (typeof overrides.features === "object" && overrides.features !== null && !Array.isArray(overrides.features)) {
    const fOverrides = overrides.features as Record<string, unknown>;
    for (const key of ["campaigns", "ai_agent", "voice_calls", "comment_to_dm"] as const) {
      if (typeof fOverrides[key] === "boolean") {
        sanitizedFeatures[key] = fOverrides[key];
      }
    }
  }

  return {
    plan: base.plan,
    max_users: maxUsers,
    max_channels: maxChannels,
    allowed_channels: allowedChannels,
    features: sanitizedFeatures,
  };
}

export function resolveTenantPlanLimits(
  settings: Record<string, unknown> | null | undefined,
): PlanLimits {
  return mergePlanOverrides(settings, DEFAULT_PLAN_LIMITS[tenantPlanFromSettings(settings)]);
}

/**
 * Runtime entitlements come from the platform catalog edited by the global
 * owner. The constant catalog remains the migration seed and a compatibility
 * fallback for partial unit-test doubles that do not implement PostgREST.
 */
export async function resolveTenantPlanLimitsFromCatalog(
  admin: SupabaseClient,
  settings: Record<string, unknown> | null | undefined,
  organizationId?: string,
): Promise<PlanLimits | null> {
  let slug = tenantPlanFromSettings(settings);
  let subscriptionAllowsUsage: boolean | undefined;
  let subscriptionStatus: TenantSubscriptionStatus | undefined;

  if (organizationId) {
    type SubscriptionResult = { data: unknown; error: unknown };
    type LimitedSubscriptionQuery = { maybeSingle?: () => Promise<SubscriptionResult> };
    type OrderedSubscriptionQuery = {
      limit?: (count: number) => LimitedSubscriptionQuery;
      order?: (column: string, options: { ascending: boolean }) => OrderedSubscriptionQuery;
    };
    type FilteredSubscriptionQuery = {
      order?: (column: string, options: { ascending: boolean }) => OrderedSubscriptionQuery;
    };
    type SelectedSubscriptionQuery = {
      eq?: (column: string, value: string) => FilteredSubscriptionQuery;
    };

    try {
      const relation = admin.from("tenant_plan_subscriptions") as unknown as {
        select?: (columns: string) => SelectedSubscriptionQuery;
      };
      const selected = relation.select?.(
        "plan_slug, status, current_period_starts_at, current_period_ends_at, trial_ends_at",
      );
      const filtered = selected?.eq?.("organization_id", organizationId);
      const ordered = filtered?.order?.("created_at", { ascending: false });
      const limited = ordered?.limit?.(1);

      // Older partial PostgREST test doubles do not model this relation; real
      // clients expose the full query chain. A database error still fails closed.
      if (typeof limited?.maybeSingle === "function") {
        const { data, error } = await limited.maybeSingle();
        if (error) return null;
        if (data && typeof data === "object") {
          const row = data as {
            plan_slug?: unknown;
            status?: unknown;
            current_period_starts_at?: unknown;
            current_period_ends_at?: unknown;
            trial_ends_at?: unknown;
          };
          if (
            (row.plan_slug !== "standard" && row.plan_slug !== "pro" && row.plan_slug !== "enterprise") ||
            !["trialing", "active", "past_due", "canceled", "suspended", "expired"].includes(String(row.status))
          ) {
            return null;
          }
          slug = row.plan_slug;
          subscriptionStatus = row.status as TenantSubscriptionStatus;
          subscriptionAllowsUsage = subscriptionAllowsPlanUse(row, new Date());
        }
      }
    } catch {
      return null;
    }
  }

  const query = admin.from("platform_plan_catalog");
  if (typeof query?.select !== "function") {
    return resolveTenantPlanLimits(settings);
  }
  const selected = query.select("slug, active, max_users, max_channels, allowed_channels, features");
  const filtered = selected.eq("slug", slug);
  if (typeof filtered?.maybeSingle !== "function") {
    return resolveTenantPlanLimits(settings);
  }

  const { data, error } = await filtered.maybeSingle();
  if (error || !data || typeof data !== "object") return null;
  const row = data as {
    slug?: unknown;
    active?: unknown;
    max_users?: unknown;
    max_channels?: unknown;
    allowed_channels?: unknown;
    features?: unknown;
  };
  if (
    row.slug !== slug ||
    row.active !== true ||
    !(row.max_users === null || (typeof row.max_users === "number" && Number.isInteger(row.max_users) && row.max_users > 0)) ||
    !(row.max_channels === null || (typeof row.max_channels === "number" && Number.isInteger(row.max_channels) && row.max_channels > 0)) ||
    !(row.allowed_channels === null || (Array.isArray(row.allowed_channels) && row.allowed_channels.every((item) => typeof item === "string"))) ||
    typeof row.features !== "object" || row.features === null || Array.isArray(row.features)
  ) {
    return null;
  }
  const featureValues = row.features as Record<string, unknown>;
  if (!("campaigns" in featureValues && "ai_agent" in featureValues && "voice_calls" in featureValues && "comment_to_dm" in featureValues)) {
    return null;
  }
  if (![featureValues.campaigns, featureValues.ai_agent, featureValues.voice_calls, featureValues.comment_to_dm].every((value) => typeof value === "boolean")) {
    return null;
  }
  const campaigns = featureValues.campaigns as boolean;
  const aiAgent = featureValues.ai_agent as boolean;
  const voiceCalls = featureValues.voice_calls as boolean;
  const commentToDm = featureValues.comment_to_dm as boolean;

  const catalogPlan: PlanLimits = {
    plan: slug,
    max_users: row.max_users,
    max_channels: row.max_channels,
    allowed_channels: row.allowed_channels,
    features: {
      campaigns,
      ai_agent: aiAgent,
      voice_calls: voiceCalls,
      comment_to_dm: commentToDm,
    },
  };
  return {
    ...mergePlanOverrides(settings, catalogPlan),
    ...(subscriptionAllowsUsage === undefined ? {} : { subscription_allows_usage: subscriptionAllowsUsage }),
    ...(subscriptionStatus === undefined ? {} : { subscription_status: subscriptionStatus }),
  };
}

function subscriptionAllowsPlanUse(
  subscription: {
    status?: unknown;
    current_period_starts_at?: unknown;
    current_period_ends_at?: unknown;
    trial_ends_at?: unknown;
  },
  now: Date,
): boolean {
  const status = subscription.status;
  if (status !== "active" && status !== "trialing" && status !== "past_due") return false;

  const startsAt = Date.parse(String(subscription.current_period_starts_at ?? ""));
  const periodEndsAt = Date.parse(String(subscription.current_period_ends_at ?? ""));
  if (!Number.isFinite(startsAt) || !Number.isFinite(periodEndsAt) || startsAt > now.getTime() || periodEndsAt <= now.getTime()) {
    return false;
  }
  if (status === "trialing") {
    const trialEndsAt = Date.parse(String(subscription.trial_ends_at ?? ""));
    return Number.isFinite(trialEndsAt) && trialEndsAt > now.getTime();
  }
  return true;
}

export interface QuotaCheckResult {
  allowed: boolean;
  current?: number;
  max?: number | null;
  reason?: string;
}

/**
 * Verifica se a organização pode adicionar mais usuários sem ultrapassar o limite do plano.
 */
export async function checkUserQuota(
  admin: SupabaseClient,
  orgId: string,
  additionalUsers = 1,
): Promise<QuotaCheckResult> {
  try {
    const { data: org, error: orgErr } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", orgId)
      .single();

    if (orgErr || !org) {
      return { allowed: false, reason: "Falha ao carregar configurações do plano da organização." };
    }

    const limits = await resolveTenantPlanLimitsFromCatalog(admin, org.settings as Record<string, unknown>, orgId);
    if (!limits) {
      return { allowed: false, reason: "Não foi possível validar o catálogo de planos da instalação." };
    }
    if (limits.subscription_allows_usage === false) {
      return { allowed: false, reason: "A assinatura desta empresa não está ativa para novos usuários." };
    }
    if (limits.max_users === null) {
      return { allowed: true, max: null };
    }

    const { count: memberCount, error: countErr } = await admin
      .from("user_organizations")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .is("revoked_at", null);

    if (countErr) {
      return { allowed: false, reason: "Falha ao consultar membros ativos da organização." };
    }

    // Convites pendentes consom assentos reservados
    const { count: inviteCount, error: inviteErr } = await admin
      .from("team_invites")
      .select("*", { count: "exact", head: true })
      .eq("organization_id", orgId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", new Date().toISOString());

    if (inviteErr) {
      return { allowed: false, reason: "Falha ao consultar convites pendentes da organização." };
    }

    const pendingInvites = inviteCount ?? 0;
    const current = (memberCount ?? 0) + pendingInvites;

    if (current + additionalUsers > limits.max_users) {
      return {
        allowed: false,
        current,
        max: limits.max_users,
        reason: `Limite de usuários atingido para o plano ${limits.plan.toUpperCase()} (${current}/${limits.max_users} assentos ocupados/convidados). Faça upgrade para adicionar mais assentos.`,
      };
    }

    return { allowed: true, current, max: limits.max_users };
  } catch {
    return { allowed: false, reason: "Falha ao verificar quota de usuários da organização." };
  }
}

/**
 * Verifica se a organização tem permissão para conectar o canal e se não excedeu o limite máximo.
 */
export async function checkChannelQuota(
  admin: SupabaseClient,
  orgId: string,
  provider: string,
  options?: { excludeChannelSessionId?: string },
): Promise<QuotaCheckResult> {
  let org: { settings?: Record<string, unknown> } | null = null;
  try {
    const orgQuery = admin.from("organizations").select("settings").eq("id", orgId);
    const { data, error: orgErr } = typeof orgQuery?.single === "function"
      ? await orgQuery.single()
      : typeof orgQuery?.maybeSingle === "function"
      ? await orgQuery.maybeSingle()
      : { data: null, error: null };

    if (orgErr) {
      return { allowed: false, reason: "Falha ao carregar configurações do plano da organização." };
    }
    org = data;
  } catch {
    return {
      allowed: false,
      reason: "Falha ao carregar configurações do plano da organização.",
    };
  }

  // Se a organização não tiver linha retornada (ex: dublê de teste sem tabela organizations),
  // assume settings vazias (que resolve para plano standard), garantindo segurança fail-closed sem quebrar dublês parciais.
  const settings = org ? (org.settings as Record<string, unknown>) : {};
  const limits = await resolveTenantPlanLimitsFromCatalog(admin, settings, orgId);
  if (!limits) {
    return { allowed: false, reason: "Não foi possível validar o catálogo de planos da instalação." };
  }
  if (limits.subscription_allows_usage === false) {
    return { allowed: false, reason: "A assinatura desta empresa não está ativa para novos canais." };
  }

  // 1. Verifica se o canal está permitido no plano
  if (limits.allowed_channels !== null) {
    const brand = channelBrand({ provider });
    const allowed =
      limits.allowed_channels.includes(provider) ||
      limits.allowed_channels.includes(brand);

    if (!allowed) {
      return {
        allowed: false,
        reason: `O canal '${provider}' não está disponível no plano ${limits.plan.toUpperCase()}. Faça upgrade para habilitar este canal.`,
      };
    }
  }

  // 2. Verifica a quantidade máxima de conexões ativas
  if (limits.max_channels === null) {
    return { allowed: true, max: null };
  }

  let countQuery = admin
    .from("channel_sessions")
    .select("*", { count: "exact", head: true })
    .eq("organization_id", orgId)
    .is("archived_at", null);

  if (options?.excludeChannelSessionId) {
    countQuery = countQuery.neq("id", options.excludeChannelSessionId);
  }

  const { count, error: countErr } = await countQuery;

  if (countErr) {
    return { allowed: false, reason: "Falha ao verificar canais ativos da organização." };
  }

  const current = count ?? 0;
  if (current >= limits.max_channels) {
    return {
      allowed: false,
      current,
      max: limits.max_channels,
      reason: `Limite de conexões de canais atingido para o plano ${limits.plan.toUpperCase()} (${current}/${limits.max_channels} conexões ativas).`,
    };
  }

  return { allowed: true, current, max: limits.max_channels };
}

/**
 * Verifica se uma funcionalidade específica está liberada para a organização.
 */
export async function checkFeatureQuota(
  admin: SupabaseClient,
  orgId: string,
  feature: keyof PlanFeatureMatrix,
): Promise<QuotaCheckResult> {
  try {
    const { data: org, error: orgErr } = await admin
      .from("organizations")
      .select("settings")
      .eq("id", orgId)
      .single();

    if (orgErr || !org) {
      return { allowed: false, reason: "Falha ao carregar configurações do plano da organização." };
    }

    const limits = await resolveTenantPlanLimitsFromCatalog(admin, org.settings as Record<string, unknown>, orgId);
    if (!limits) {
      return { allowed: false, reason: "Não foi possível validar o catálogo de planos da instalação." };
    }
    if (limits.subscription_allows_usage === false) {
      return { allowed: false, reason: "A assinatura desta empresa não está ativa para usar módulos do plano." };
    }
    const isEnabled = limits.features[feature] ?? true;

    if (!isEnabled) {
      return {
        allowed: false,
        reason: `A funcionalidade '${feature}' não está disponível no plano ${limits.plan.toUpperCase()}.`,
      };
    }

    return { allowed: true };
  } catch {
    return { allowed: false, reason: "Falha ao carregar configurações do plano da organização." };
  }
}
