-- 9065 — customer-side subscriptions per organization.
-- Installation activation remains in the separate license system; this table
-- binds one organization's subscription to the existing plan/entitlement catalog.

CREATE TABLE IF NOT EXISTS public.tenant_plan_subscriptions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  plan_slug text NOT NULL REFERENCES public.platform_plan_catalog(slug) ON DELETE RESTRICT,
  status text NOT NULL CHECK (status IN ('trialing', 'active', 'past_due', 'canceled', 'suspended', 'expired')),
  billing_interval text NOT NULL CHECK (billing_interval IN ('monthly', 'annual', 'custom')),
  price_cents bigint CHECK (price_cents IS NULL OR price_cents BETWEEN 0 AND 999999999900),
  currency text NOT NULL DEFAULT 'BRL' CHECK (currency ~ '^[A-Z]{3}$'),
  current_period_starts_at timestamptz NOT NULL,
  current_period_ends_at timestamptz NOT NULL,
  trial_ends_at timestamptz,
  cancel_at_period_end boolean NOT NULL DEFAULT false,
  canceled_at timestamptz,
  ended_at timestamptz,
  created_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT tenant_plan_subscriptions_period_order
    CHECK (current_period_ends_at > current_period_starts_at),
  CONSTRAINT tenant_plan_subscriptions_trial_end_required
    CHECK (status <> 'trialing' OR trial_ends_at IS NOT NULL),
  CONSTRAINT tenant_plan_subscriptions_cancel_status
    CHECK (NOT cancel_at_period_end OR status IN ('active', 'past_due'))
);

CREATE UNIQUE INDEX IF NOT EXISTS tenant_plan_subscriptions_one_current_per_org
  ON public.tenant_plan_subscriptions (organization_id)
  WHERE status IN ('trialing', 'active', 'past_due', 'suspended');

CREATE INDEX IF NOT EXISTS tenant_plan_subscriptions_org_history_idx
  ON public.tenant_plan_subscriptions (organization_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS tenant_plan_subscriptions_expiry_idx
  ON public.tenant_plan_subscriptions (current_period_ends_at)
  WHERE status IN ('trialing', 'active', 'past_due');

ALTER TABLE public.tenant_plan_subscriptions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.tenant_plan_subscriptions FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.tenant_plan_subscriptions TO service_role;

COMMENT ON TABLE public.tenant_plan_subscriptions IS
  'Assinatura comercial por organização no banco Customer. Não substitui a licença ACT, que continua limitando a instalação inteira. Cobrança automática e faturas não fazem parte deste registro.';
COMMENT ON COLUMN public.tenant_plan_subscriptions.plan_slug IS
  'Plano contratado; as cotas e funcionalidades vêm de platform_plan_catalog e dos overrides autorizados em organizations.settings.plan_limits.';
COMMENT ON COLUMN public.tenant_plan_subscriptions.price_cents IS
  'Preço manualmente registrado em centavos; NULL significa que o preço ainda não foi informado. Nenhum gateway é chamado.';

CREATE OR REPLACE FUNCTION public.fn_create_tenant_with_owner_subscription_limited(
  p_actor uuid,
  p_key uuid,
  p_request jsonb,
  p_hash text,
  p_installation_id text,
  p_max_tenants bigint
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_result jsonb;
  v_subscription jsonb := p_request->'subscription';
  v_organization_id uuid;
BEGIN
  IF jsonb_typeof(v_subscription) IS DISTINCT FROM 'object'
     OR v_subscription->>'status' NOT IN ('active', 'trialing') THEN
    RAISE EXCEPTION 'tenant_subscription_input_invalid' USING ERRCODE = '22023';
  END IF;
  IF (v_subscription->>'current_period_ends_at')::timestamptz <= clock_timestamp()
     OR (
       v_subscription->>'status' = 'trialing'
       AND (v_subscription->>'trial_ends_at')::timestamptz <= clock_timestamp()
     ) THEN
    RAISE EXCEPTION 'tenant_subscription_period_expired' USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.platform_admins
     WHERE user_id = p_actor
       AND revoked_at IS NULL
       AND scope = 'full'
       AND platform_role = 'owner'
  ) THEN
    RAISE EXCEPTION 'platform_owner_required' USING ERRCODE = '42501';
  END IF;

  v_result := public.fn_create_tenant_with_owner_limited(
    p_actor, p_key, p_request, p_hash, p_installation_id, p_max_tenants
  );

  IF COALESCE((v_result->>'created')::boolean, false) THEN
    v_organization_id := (v_result->>'id')::uuid;
    INSERT INTO public.tenant_plan_subscriptions (
      organization_id,
      plan_slug,
      status,
      billing_interval,
      price_cents,
      currency,
      current_period_starts_at,
      current_period_ends_at,
      trial_ends_at,
      cancel_at_period_end,
      created_by,
      updated_by
    ) VALUES (
      v_organization_id,
      p_request->>'plan',
      v_subscription->>'status',
      v_subscription->>'billing_interval',
      NULLIF(v_subscription->>'price_cents', '')::bigint,
      COALESCE(v_subscription->>'currency', 'BRL'),
      (v_subscription->>'current_period_starts_at')::timestamptz,
      (v_subscription->>'current_period_ends_at')::timestamptz,
      NULLIF(v_subscription->>'trial_ends_at', '')::timestamptz,
      COALESCE((v_subscription->>'cancel_at_period_end')::boolean, false),
      p_actor,
      p_actor
    );
  END IF;

  RETURN v_result;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_create_tenant_with_owner_subscription_limited(uuid, uuid, jsonb, text, text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_create_tenant_with_owner_subscription_limited(uuid, uuid, jsonb, text, text, bigint)
  TO service_role;

CREATE OR REPLACE FUNCTION public.fn_platform_set_tenant_plan_subscription(
  p_actor uuid,
  p_organization_id uuid,
  p_plan_slug text,
  p_status text,
  p_billing_interval text,
  p_price_cents bigint,
  p_currency text,
  p_current_period_starts_at timestamptz,
  p_current_period_ends_at timestamptz,
  p_trial_ends_at timestamptz,
  p_cancel_at_period_end boolean
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_subscription public.tenant_plan_subscriptions%ROWTYPE;
BEGIN
  IF p_actor IS NULL OR p_organization_id IS NULL THEN
    RAISE EXCEPTION 'actor_and_organization_required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.platform_admins
     WHERE user_id = p_actor
       AND revoked_at IS NULL
       AND scope = 'full'
       AND platform_role = 'owner'
  ) THEN
    RAISE EXCEPTION 'platform_owner_required' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.organizations WHERE id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'organization_not_found' USING ERRCODE = 'P0002';
  END IF;
  IF NOT EXISTS (
    SELECT 1
      FROM public.platform_plan_catalog
     WHERE slug = p_plan_slug
       AND active
  ) THEN
    RAISE EXCEPTION 'plan_unavailable' USING ERRCODE = '22023';
  END IF;
  IF p_status IN ('active', 'trialing', 'past_due')
     AND p_current_period_ends_at <= clock_timestamp() THEN
    RAISE EXCEPTION 'tenant_subscription_period_expired' USING ERRCODE = '22023';
  END IF;
  IF p_status = 'trialing' AND (p_trial_ends_at IS NULL OR p_trial_ends_at <= clock_timestamp()) THEN
    RAISE EXCEPTION 'tenant_subscription_trial_expired' USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_subscription
    FROM public.tenant_plan_subscriptions
   WHERE organization_id = p_organization_id
     AND status IN ('trialing', 'active', 'past_due', 'suspended')
   ORDER BY created_at DESC, id DESC
   LIMIT 1
   FOR UPDATE;

  IF FOUND THEN
    UPDATE public.tenant_plan_subscriptions
       SET plan_slug = p_plan_slug,
           status = p_status,
           billing_interval = p_billing_interval,
           price_cents = p_price_cents,
           currency = p_currency,
           current_period_starts_at = p_current_period_starts_at,
           current_period_ends_at = p_current_period_ends_at,
           trial_ends_at = p_trial_ends_at,
           cancel_at_period_end = p_cancel_at_period_end,
           canceled_at = CASE WHEN p_status = 'canceled' THEN COALESCE(canceled_at, clock_timestamp()) ELSE NULL END,
           ended_at = CASE WHEN p_status IN ('canceled', 'suspended', 'expired') THEN COALESCE(ended_at, clock_timestamp()) ELSE NULL END,
           updated_by = p_actor,
           updated_at = clock_timestamp()
     WHERE id = v_subscription.id
     RETURNING * INTO v_subscription;
  ELSE
    INSERT INTO public.tenant_plan_subscriptions (
      organization_id,
      plan_slug,
      status,
      billing_interval,
      price_cents,
      currency,
      current_period_starts_at,
      current_period_ends_at,
      trial_ends_at,
      cancel_at_period_end,
      canceled_at,
      ended_at,
      created_by,
      updated_by
    ) VALUES (
      p_organization_id,
      p_plan_slug,
      p_status,
      p_billing_interval,
      p_price_cents,
      p_currency,
      p_current_period_starts_at,
      p_current_period_ends_at,
      p_trial_ends_at,
      p_cancel_at_period_end,
      CASE WHEN p_status = 'canceled' THEN clock_timestamp() END,
      CASE WHEN p_status IN ('canceled', 'suspended', 'expired') THEN clock_timestamp() END,
      p_actor,
      p_actor
    )
    RETURNING * INTO v_subscription;
  END IF;

  UPDATE public.organizations
     SET settings = pg_catalog.jsonb_set(
           COALESCE(settings, '{}'::jsonb),
           '{plan}',
           pg_catalog.to_jsonb(p_plan_slug),
           true
         ),
         updated_at = clock_timestamp()
   WHERE id = p_organization_id;

  RETURN pg_catalog.to_jsonb(v_subscription);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_platform_set_tenant_plan_subscription(uuid, uuid, text, text, text, bigint, text, timestamptz, timestamptz, timestamptz, boolean)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_platform_set_tenant_plan_subscription(uuid, uuid, text, text, text, bigint, text, timestamptz, timestamptz, timestamptz, boolean)
  TO service_role;

NOTIFY pgrst, 'reload schema';
