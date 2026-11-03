-- 9062 — first-run initialization and global platform ownership.
-- Existing installations are sealed as initialized without promoting a user.
BEGIN;

ALTER TABLE public.platform_admins
  ADD COLUMN IF NOT EXISTS platform_role text NOT NULL DEFAULT 'admin';

DO $baseline_guard$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.platform_admins'::regclass AND conname = 'platform_admins_platform_role_check') THEN
    ALTER TABLE public.platform_admins ADD CONSTRAINT platform_admins_platform_role_check CHECK (platform_role IN ('owner', 'admin'));
  END IF;
END $baseline_guard$;

-- A session may read its own admin row through the existing RLS policy, but
-- only SECURITY DEFINER RPCs and service_role may mutate global grants.
ALTER TABLE public.platform_admins ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.platform_admins FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.platform_admins TO authenticated;
GRANT ALL ON TABLE public.platform_admins TO service_role;

ALTER TABLE public.platform_settings
  ADD COLUMN IF NOT EXISTS initialized_at timestamptz,
  ADD COLUMN IF NOT EXISTS initialized_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS setup_claim_id uuid,
  ADD COLUMN IF NOT EXISTS setup_claimed_at timestamptz;

DO $baseline_guard$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'public.platform_settings'::regclass AND conname = 'platform_settings_setup_claim_pair') THEN
    ALTER TABLE public.platform_settings ADD CONSTRAINT platform_settings_setup_claim_pair CHECK ((setup_claim_id IS NULL) = (setup_claimed_at IS NULL));
  END IF;
END $baseline_guard$;

INSERT INTO public.platform_settings (id)
VALUES (1)
ON CONFLICT (id) DO NOTHING;

-- Existing plan slugs remain the stable identifiers used by tenant settings.
-- The catalog becomes the editable source of quotas and entitlements; no second
-- quota calculator is introduced.
CREATE TABLE IF NOT EXISTS public.platform_plan_catalog (
  slug text PRIMARY KEY CHECK (slug IN ('standard', 'pro', 'enterprise')),
  name text NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 80),
  active boolean NOT NULL DEFAULT true,
  max_users integer CHECK (max_users IS NULL OR max_users > 0),
  max_channels integer CHECK (max_channels IS NULL OR max_channels > 0),
  allowed_channels text[],
  features jsonb NOT NULL CHECK (jsonb_typeof(features) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  CONSTRAINT platform_plan_catalog_features_shape CHECK (
    (features ? 'campaigns' AND jsonb_typeof(features->'campaigns') = 'boolean')
    AND (features ? 'ai_agent' AND jsonb_typeof(features->'ai_agent') = 'boolean')
    AND (features ? 'voice_calls' AND jsonb_typeof(features->'voice_calls') = 'boolean')
    AND (features ? 'comment_to_dm' AND jsonb_typeof(features->'comment_to_dm') = 'boolean')
  )
);

ALTER TABLE public.platform_plan_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_plan_catalog FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, UPDATE ON public.platform_plan_catalog TO service_role;

INSERT INTO public.platform_plan_catalog
  (slug, name, active, max_users, max_channels, allowed_channels, features)
VALUES
  ('standard', 'Essencial', true, 3, 1, ARRAY['whatsapp', 'email'],
   '{"campaigns":false,"ai_agent":true,"voice_calls":false,"comment_to_dm":false}'::jsonb),
  ('pro', 'Profissional', true, 10, 5,
   ARRAY['whatsapp', 'telegram', 'telegram_user', 'email', 'instagram', 'tiktok'],
   '{"campaigns":true,"ai_agent":true,"voice_calls":true,"comment_to_dm":true}'::jsonb),
  ('enterprise', 'Escala', true, NULL, NULL, NULL,
   '{"campaigns":true,"ai_agent":true,"voice_calls":true,"comment_to_dm":true}'::jsonb)
ON CONFLICT (slug) DO NOTHING;

-- Upgrade safety: operational instances are already initialized. Keep every
-- existing platform administrator as platform_admin; never infer an owner.
UPDATE public.platform_settings AS settings
   SET initialized_at = COALESCE(settings.initialized_at, clock_timestamp())
 WHERE settings.id = 1
   AND settings.initialized_at IS NULL
   AND (
     EXISTS (
       SELECT 1 FROM public.platform_admins
        WHERE revoked_at IS NULL
     )
     OR EXISTS (SELECT 1 FROM public.organizations)
     OR EXISTS (SELECT 1 FROM auth.users)
   );

COMMENT ON COLUMN public.platform_admins.platform_role IS
  'Papel global separado do papel de tenant: owner protege a propriedade da instalação; admin é autoridade global delegada. Migração 9062 não promove administradores antigos.';
COMMENT ON COLUMN public.platform_settings.initialized_at IS
  'NULL apenas no first-run de uma instalação sem usuários, organizações ou platform admins. Instalações existentes são marcadas como inicializadas sem promoção automática.';
COMMENT ON COLUMN public.platform_settings.initialized_by IS
  'Usuário que concluiu o first-run. NULL em instalações antigas seladas pela migração 9062 sem owner identificado.';

CREATE TABLE IF NOT EXISTS public.platform_setup_rate_limits (
  bucket_hash text PRIMARY KEY CHECK (bucket_hash ~ '^[a-f0-9]{64}$'),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  window_started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS idx_platform_setup_rate_limits_updated_at
  ON public.platform_setup_rate_limits (updated_at);

ALTER TABLE public.platform_setup_rate_limits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.platform_setup_rate_limits FROM PUBLIC, anon, authenticated, service_role;

-- A navegação inicial precisa saber somente o booleano de inicialização. Não
-- conceda acesso direto ao timestamp nem às demais colunas do singleton.
ALTER TABLE public.platform_settings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS platform_settings_setup_status_anon ON public.platform_settings;
REVOKE ALL ON TABLE public.platform_settings FROM PUBLIC, anon;

-- SECURITY DEFINER stays outside PostgREST's exposed schemas. Use a dedicated
-- schema so granting the narrow helper cannot expose unrelated private objects.
CREATE SCHEMA IF NOT EXISTS platform_internal;
REVOKE ALL ON SCHEMA platform_internal FROM PUBLIC;
GRANT USAGE ON SCHEMA platform_internal TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION platform_internal.fn_platform_initialized()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT COALESCE(
    (SELECT initialized_at IS NOT NULL
       FROM public.platform_settings
      WHERE id = 1),
    false
  );
$$;

REVOKE ALL ON FUNCTION platform_internal.fn_platform_initialized() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_internal.fn_platform_initialized() TO anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.fn_platform_initialized()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = ''
AS $$
  SELECT platform_internal.fn_platform_initialized();
$$;

REVOKE ALL ON FUNCTION public.fn_platform_initialized() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.fn_platform_initialized() TO anon, authenticated, service_role;
COMMENT ON FUNCTION public.fn_platform_initialized() IS
  'Public setup-status RPC returns one boolean only; SECURITY INVOKER delegates to a narrow SECURITY DEFINER helper in non-exposed platform_internal.';

CREATE OR REPLACE FUNCTION public.fn_is_platform_owner()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
  SELECT EXISTS (
    SELECT 1
      FROM public.platform_admins
     WHERE user_id = auth.uid()
       AND platform_role = 'owner'
       AND revoked_at IS NULL
  );
$$;

REVOKE ALL ON FUNCTION public.fn_is_platform_owner() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fn_is_platform_owner() TO authenticated, service_role;

-- The persistent counter makes setup throttling fail closed across app replicas.
-- It stores only SHA-256 bucket identifiers, never raw IPs or the bootstrap token.
CREATE OR REPLACE FUNCTION public.fn_consume_platform_setup_rate_limit(p_source_hash text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, extensions
AS $$
DECLARE
  v_global_hash text := encode(digest('clientix:platform-setup:global', 'sha256'), 'hex');
  v_source_attempts integer;
  v_global_attempts integer;
BEGIN
  IF p_source_hash IS NULL OR p_source_hash !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'invalid setup rate-limit subject' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('clientix:platform-setup-rate-limit'));
  DELETE FROM public.platform_setup_rate_limits
   WHERE updated_at < clock_timestamp() - interval '1 day';

  INSERT INTO public.platform_setup_rate_limits AS bucket
    (bucket_hash, attempts, window_started_at, updated_at)
  VALUES (v_global_hash, 1, clock_timestamp(), clock_timestamp())
  ON CONFLICT (bucket_hash) DO UPDATE
    SET attempts = CASE
          WHEN bucket.window_started_at <= clock_timestamp() - interval '1 hour' THEN 1
          ELSE bucket.attempts + 1
        END,
        window_started_at = CASE
          WHEN bucket.window_started_at <= clock_timestamp() - interval '1 hour' THEN clock_timestamp()
          ELSE bucket.window_started_at
        END,
        updated_at = clock_timestamp()
  RETURNING attempts INTO v_global_attempts;

  INSERT INTO public.platform_setup_rate_limits AS bucket
    (bucket_hash, attempts, window_started_at, updated_at)
  VALUES (p_source_hash, 1, clock_timestamp(), clock_timestamp())
  ON CONFLICT (bucket_hash) DO UPDATE
    SET attempts = CASE
          WHEN bucket.window_started_at <= clock_timestamp() - interval '15 minutes' THEN 1
          ELSE bucket.attempts + 1
        END,
        window_started_at = CASE
          WHEN bucket.window_started_at <= clock_timestamp() - interval '15 minutes' THEN clock_timestamp()
          ELSE bucket.window_started_at
        END,
        updated_at = clock_timestamp()
  RETURNING attempts INTO v_source_attempts;

  RETURN v_global_attempts <= 60 AND v_source_attempts <= 5;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_consume_platform_setup_rate_limit(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_consume_platform_setup_rate_limit(text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_reserve_platform_setup(p_claim_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_initialized_at timestamptz;
  v_claim_id uuid;
  v_claimed_at timestamptz;
BEGIN
  IF p_claim_id IS NULL THEN
    RAISE EXCEPTION 'setup claim is required' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('clientix:platform-initialization'));
  INSERT INTO public.platform_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  SELECT initialized_at, setup_claim_id, setup_claimed_at
    INTO v_initialized_at, v_claim_id, v_claimed_at
    FROM public.platform_settings WHERE id = 1 FOR UPDATE;

  IF v_initialized_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.platform_admins WHERE revoked_at IS NULL) THEN
    RETURN false;
  END IF;

  IF v_claim_id IS NOT NULL AND v_claimed_at > clock_timestamp() - interval '10 minutes' THEN
    RETURN false;
  END IF;

  UPDATE public.platform_settings
     SET setup_claim_id = p_claim_id,
         setup_claimed_at = clock_timestamp()
   WHERE id = 1;
  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_reserve_platform_setup(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_reserve_platform_setup(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_release_platform_setup(p_claim_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('clientix:platform-initialization'));
  UPDATE public.platform_settings
     SET setup_claim_id = NULL,
         setup_claimed_at = NULL
   WHERE id = 1
     AND initialized_at IS NULL
     AND setup_claim_id = p_claim_id;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_release_platform_setup(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_release_platform_setup(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_finalize_platform_setup(
  p_claim_id uuid,
  p_user_id uuid,
  p_platform_name text,
  p_request_id text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_initialized_at timestamptz;
  v_current_claim uuid;
  v_claimed_at timestamptz;
  v_name text := btrim(COALESCE(p_platform_name, ''));
BEGIN
  IF p_claim_id IS NULL OR p_user_id IS NULL THEN
    RAISE EXCEPTION 'setup claim and owner are required' USING ERRCODE = '22023';
  END IF;
  IF length(v_name) < 1 OR length(v_name) > 80 THEN
    RAISE EXCEPTION 'platform name is invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('clientix:platform-initialization'));
  SELECT initialized_at, setup_claim_id, setup_claimed_at
    INTO v_initialized_at, v_current_claim, v_claimed_at
    FROM public.platform_settings WHERE id = 1 FOR UPDATE;

  IF v_initialized_at IS NOT NULL
     OR EXISTS (SELECT 1 FROM public.platform_admins WHERE revoked_at IS NULL) THEN
    UPDATE public.platform_settings
       SET initialized_at = COALESCE(initialized_at, clock_timestamp()),
           setup_claim_id = NULL,
           setup_claimed_at = NULL
     WHERE id = 1;
    RETURN false;
  END IF;

  IF v_current_claim IS DISTINCT FROM p_claim_id
     OR v_claimed_at IS NULL
     OR v_claimed_at <= clock_timestamp() - interval '10 minutes' THEN
    RAISE EXCEPTION 'setup claim is no longer valid' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_user_id) THEN
    RAISE EXCEPTION 'setup owner does not exist in auth' USING ERRCODE = '23503';
  END IF;

  INSERT INTO public.platform_admins
    (user_id, granted_by, scope, mfa_required, reason, platform_role)
  VALUES
    (p_user_id, p_user_id, 'full', false, 'Proprietário inicial da plataforma', 'owner');

  UPDATE public.platform_settings
     SET initialized_at = clock_timestamp(),
         initialized_by = p_user_id,
         setup_claim_id = NULL,
         setup_claimed_at = NULL
   WHERE id = 1;

  INSERT INTO public.platform_branding (id, app_name, seeded_from_env, updated_by)
  VALUES (1, v_name, false, p_user_id)
  ON CONFLICT (id) DO UPDATE
    SET app_name = EXCLUDED.app_name,
        seeded_from_env = false,
        updated_by = EXCLUDED.updated_by;

  INSERT INTO public.api_audit_log (
    actor_user_id,
    acting_as_platform_admin,
    action,
    resource_type,
    resource_id,
    request_id,
    bypassed_rls,
    metadata
  ) VALUES (
    p_user_id,
    true,
    'platform_initialized',
    'platform_owner',
    p_user_id,
    p_request_id,
    true,
    jsonb_build_object('origin', 'first_run_setup')
  );

  RETURN true;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_finalize_platform_setup(uuid, uuid, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_finalize_platform_setup(uuid, uuid, text, text) TO service_role;

CREATE OR REPLACE FUNCTION public.fn_protect_last_platform_owner()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_other_active_owners integer;
  v_has_auth_status boolean;
BEGIN
  IF OLD.platform_role <> 'owner' OR OLD.revoked_at IS NOT NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.platform_role = 'owner' AND NEW.revoked_at IS NULL THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('clientix:platform-owner-protection'));
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'banned_until'
  ) AND EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'deleted_at'
  ) INTO v_has_auth_status;

  IF v_has_auth_status THEN
    EXECUTE $query$
      SELECT count(*)
        FROM public.platform_admins AS pa
        JOIN auth.users AS u ON u.id = pa.user_id
       WHERE pa.platform_role = 'owner'
         AND pa.revoked_at IS NULL
         AND pa.user_id <> $1
         AND u.deleted_at IS NULL
         AND (u.banned_until IS NULL OR u.banned_until <= clock_timestamp())
    $query$ INTO v_other_active_owners USING OLD.user_id;
  ELSE
    SELECT count(*) INTO v_other_active_owners
      FROM public.platform_admins
     WHERE platform_role = 'owner'
       AND revoked_at IS NULL
       AND user_id <> OLD.user_id;
  END IF;

  IF v_other_active_owners = 0 THEN
    RAISE EXCEPTION 'cannot remove or deactivate the last active platform owner'
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_protect_last_platform_owner() FROM PUBLIC, anon, authenticated, service_role;
DROP TRIGGER IF EXISTS trg_protect_last_platform_owner ON public.platform_admins;
CREATE TRIGGER trg_protect_last_platform_owner
  BEFORE UPDATE OR DELETE ON public.platform_admins
  FOR EACH ROW EXECUTE FUNCTION public.fn_protect_last_platform_owner();

-- GoTrue stores account bans/deletions in auth.users. Guard those transitions
-- too, so the final owner cannot be disabled through the Auth Admin API.
CREATE OR REPLACE FUNCTION public.fn_protect_last_platform_owner_auth()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, auth
AS $$
DECLARE
  v_is_active_owner boolean;
  v_other_active_owners integer;
  v_old_deleted boolean;
  v_new_deleted boolean;
  v_old_banned_at timestamptz;
  v_new_banned_at timestamptz;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM public.platform_admins
     WHERE user_id = OLD.id
       AND platform_role = 'owner'
       AND revoked_at IS NULL
  ) INTO v_is_active_owner;
  IF NOT v_is_active_owner THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;

  IF TG_OP = 'DELETE' THEN
    PERFORM pg_advisory_xact_lock(hashtext('clientix:platform-owner-protection'));
    SELECT count(*) INTO v_other_active_owners
      FROM public.platform_admins AS pa
      JOIN auth.users AS u ON u.id = pa.user_id
     WHERE pa.platform_role = 'owner'
       AND pa.revoked_at IS NULL
       AND pa.user_id <> OLD.id
       AND to_jsonb(u)->>'deleted_at' IS NULL
       AND (to_jsonb(u)->>'banned_until' IS NULL
            OR (to_jsonb(u)->>'banned_until')::timestamptz <= clock_timestamp());
    IF v_other_active_owners = 0 THEN
      RAISE EXCEPTION 'cannot deactivate the last active platform owner'
        USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;

  v_old_deleted := to_jsonb(OLD)->>'deleted_at' IS NOT NULL;
  v_new_deleted := to_jsonb(NEW)->>'deleted_at' IS NOT NULL;
  v_old_banned_at := NULLIF(to_jsonb(OLD)->>'banned_until', '')::timestamptz;
  v_new_banned_at := NULLIF(to_jsonb(NEW)->>'banned_until', '')::timestamptz;
  IF (NOT v_old_deleted AND v_new_deleted)
     OR ((v_old_banned_at IS NULL OR v_old_banned_at <= clock_timestamp())
         AND v_new_banned_at IS NOT NULL
         AND v_new_banned_at > clock_timestamp()) THEN
    PERFORM pg_advisory_xact_lock(hashtext('clientix:platform-owner-protection'));
    SELECT count(*) INTO v_other_active_owners
      FROM public.platform_admins AS pa
      JOIN auth.users AS u ON u.id = pa.user_id
     WHERE pa.platform_role = 'owner'
       AND pa.revoked_at IS NULL
       AND pa.user_id <> OLD.id
       AND to_jsonb(u)->>'deleted_at' IS NULL
       AND (to_jsonb(u)->>'banned_until' IS NULL
            OR (to_jsonb(u)->>'banned_until')::timestamptz <= clock_timestamp());
    IF v_other_active_owners = 0 THEN
      RAISE EXCEPTION 'cannot deactivate the last active platform owner'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.fn_protect_last_platform_owner_auth() FROM PUBLIC, anon, authenticated, service_role;
DO $trigger$
BEGIN
  DROP TRIGGER IF EXISTS trg_protect_last_platform_owner_auth ON auth.users;
  DROP TRIGGER IF EXISTS trg_protect_last_platform_owner_auth_banned_until ON auth.users;
  DROP TRIGGER IF EXISTS trg_protect_last_platform_owner_auth_deleted_at ON auth.users;
  DROP TRIGGER IF EXISTS trg_protect_last_platform_owner_auth_delete ON auth.users;
  CREATE TRIGGER trg_protect_last_platform_owner_auth_delete
    BEFORE DELETE ON auth.users
    FOR EACH ROW EXECUTE FUNCTION public.fn_protect_last_platform_owner_auth();
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'banned_until'
  ) THEN
    CREATE TRIGGER trg_protect_last_platform_owner_auth_banned_until
      BEFORE UPDATE OF banned_until ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.fn_protect_last_platform_owner_auth();
  END IF;
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'auth' AND table_name = 'users' AND column_name = 'deleted_at'
  ) THEN
    CREATE TRIGGER trg_protect_last_platform_owner_auth_deleted_at
      BEFORE UPDATE OF deleted_at ON auth.users
      FOR EACH ROW EXECUTE FUNCTION public.fn_protect_last_platform_owner_auth();
  END IF;
END
$trigger$;

-- Administração global de membros sempre identifica a empresa e o ator no
-- servidor; mantém a proteção do último admin de tenant também sob concorrência.
CREATE OR REPLACE FUNCTION public.fn_platform_manage_org_member(
  p_actor uuid,
  p_organization_id uuid,
  p_target_user_id uuid,
  p_action text,
  p_role text DEFAULT NULL,
  p_request_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_membership public.user_organizations%ROWTYPE;
  v_admin_count integer;
BEGIN
  IF p_actor IS NULL OR p_organization_id IS NULL OR p_target_user_id IS NULL OR p_request_id IS NULL THEN
    RAISE EXCEPTION 'actor, organization, target and request are required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admins
     WHERE user_id = p_actor AND revoked_at IS NULL AND scope = 'full'
  ) THEN
    RAISE EXCEPTION 'full platform admin required' USING ERRCODE = '42501';
  END IF;
  IF p_action NOT IN ('change_role', 'revoke', 'reactivate') THEN
    RAISE EXCEPTION 'unsupported membership action' USING ERRCODE = '22023';
  END IF;
  IF p_action = 'change_role' AND p_role NOT IN ('viewer', 'agent', 'manager', 'admin') THEN
    RAISE EXCEPTION 'unsupported organization role' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('clientix:platform-member:' || p_organization_id::text, 0));
  SELECT * INTO v_membership
    FROM public.user_organizations
   WHERE organization_id = p_organization_id AND user_id = p_target_user_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'organization membership not found' USING ERRCODE = 'P0002';
  END IF;

  IF p_action = 'change_role' THEN
    IF v_membership.revoked_at IS NOT NULL THEN
      RAISE EXCEPTION 'revoked membership cannot change role' USING ERRCODE = '23514';
    END IF;
    IF v_membership.role = 'admin' AND p_role <> 'admin' THEN
      SELECT count(*) INTO v_admin_count
        FROM public.user_organizations
       WHERE organization_id = p_organization_id AND role = 'admin' AND revoked_at IS NULL;
      IF v_admin_count <= 1 THEN
        RAISE EXCEPTION 'cannot demote the last organization admin' USING ERRCODE = '23514';
      END IF;
    END IF;
    UPDATE public.user_organizations
       SET role = p_role, updated_at = clock_timestamp()
     WHERE id = v_membership.id
     RETURNING * INTO v_membership;
  ELSIF p_action = 'revoke' THEN
    IF v_membership.revoked_at IS NULL THEN
      IF v_membership.role = 'admin' THEN
        SELECT count(*) INTO v_admin_count
          FROM public.user_organizations
         WHERE organization_id = p_organization_id AND role = 'admin' AND revoked_at IS NULL;
        IF v_admin_count <= 1 THEN
          RAISE EXCEPTION 'cannot revoke the last organization admin' USING ERRCODE = '23514';
        END IF;
      END IF;
      UPDATE public.user_organizations
         SET revoked_at = clock_timestamp(), updated_at = clock_timestamp()
       WHERE id = v_membership.id
       RETURNING * INTO v_membership;
    END IF;
  ELSIF v_membership.revoked_at IS NOT NULL THEN
    UPDATE public.user_organizations
       SET revoked_at = NULL, updated_at = clock_timestamp()
     WHERE id = v_membership.id
     RETURNING * INTO v_membership;
  END IF;

  INSERT INTO public.api_audit_log (
    organization_id, actor_user_id, acting_as_platform_admin, action,
    resource_type, resource_id, request_id, bypassed_rls, metadata
  ) VALUES (
    p_organization_id,
    p_actor,
    true,
    CASE p_action
      WHEN 'change_role' THEN 'platform_admin.member_role_changed'
      WHEN 'revoke' THEN 'platform_admin.member_revoked'
      ELSE 'platform_admin.member_reactivated'
    END,
    'membership',
    v_membership.id,
    p_request_id,
    true,
    jsonb_build_object(
      'target_user_id', p_target_user_id,
      'action', p_action,
      'role', v_membership.role,
      'revoked', v_membership.revoked_at IS NOT NULL
    )
  );

  RETURN jsonb_build_object(
    'id', v_membership.id,
    'organization_id', v_membership.organization_id,
    'user_id', v_membership.user_id,
    'role', v_membership.role,
    'accepted_at', v_membership.accepted_at,
    'revoked_at', v_membership.revoked_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_platform_manage_org_member(uuid, uuid, uuid, text, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_platform_manage_org_member(uuid, uuid, uuid, text, text, text) TO service_role;

-- A dashboard global conta dados derivados em uma única leitura do banco;
-- usuários são contas com vínculo aceito e ativo em pelo menos uma organização.
CREATE OR REPLACE FUNCTION public.fn_platform_dashboard_metrics()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  WITH plan_distribution AS (
    SELECT catalog.slug,
           count(organizations.id)::integer AS organizations
      FROM public.platform_plan_catalog AS catalog
      LEFT JOIN public.organizations
        ON COALESCE(public.organizations.settings->>'plan', 'standard') = catalog.slug
     GROUP BY catalog.slug
  )
  SELECT jsonb_build_object(
    'organizations_total', (SELECT count(*) FROM public.organizations),
    'organizations_active', (SELECT count(*) FROM public.organizations WHERE status = 'active'),
    'organizations_suspended', (SELECT count(*) FROM public.organizations WHERE status = 'suspended'),
    'users_total', (
      SELECT count(DISTINCT user_id)
        FROM public.user_organizations
       WHERE accepted_at IS NOT NULL AND revoked_at IS NULL
    ),
    'plans_total', (SELECT count(*) FROM public.platform_plan_catalog WHERE active),
    'plan_distribution', COALESCE(
      (SELECT jsonb_object_agg(slug, organizations) FROM plan_distribution),
      '{}'::jsonb
    )
  );
$$;

REVOKE ALL ON FUNCTION public.fn_platform_dashboard_metrics() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_platform_dashboard_metrics() TO service_role;

-- Delegação de administradores globais é exclusiva do owner. A tabela continua
-- sem escrita direta pelos papéis de aplicação; o RPC audita cada alteração.
CREATE OR REPLACE FUNCTION public.fn_platform_manage_global_admin(
  p_actor uuid,
  p_target_user_id uuid,
  p_action text,
  p_scope text DEFAULT NULL,
  p_mfa_required boolean DEFAULT true,
  p_reason text DEFAULT NULL,
  p_request_id text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_admin public.platform_admins%ROWTYPE;
  v_reason text := btrim(COALESCE(p_reason, ''));
BEGIN
  IF p_actor IS NULL OR p_target_user_id IS NULL OR p_request_id IS NULL OR length(p_request_id) NOT BETWEEN 1 AND 100 THEN
    RAISE EXCEPTION 'actor, target and request are required' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admins
     WHERE user_id = p_actor AND platform_role = 'owner'
       AND revoked_at IS NULL AND scope = 'full'
  ) THEN
    RAISE EXCEPTION 'active platform owner required' USING ERRCODE = '42501';
  END IF;
  IF p_action IS NULL OR p_action NOT IN ('grant', 'revoke') THEN
    RAISE EXCEPTION 'unsupported global admin action' USING ERRCODE = '22023';
  END IF;

  PERFORM pg_advisory_xact_lock(hashtextextended('clientix:global-admin:' || p_target_user_id::text, 0));
  IF p_action = 'grant' THEN
    IF p_scope IS NULL OR p_scope NOT IN ('full', 'support_readonly')
       OR p_mfa_required IS NULL OR length(v_reason) < 3 OR length(v_reason) > 300 THEN
      RAISE EXCEPTION 'scope or reason is invalid' USING ERRCODE = '22023';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM auth.users WHERE id = p_target_user_id) THEN
      RAISE EXCEPTION 'target user does not exist' USING ERRCODE = 'P0002';
    END IF;

    INSERT INTO public.platform_admins
      (user_id, granted_by, granted_at, scope, mfa_required, reason,
       revoked_at, revoked_by, revoke_reason, platform_role)
    VALUES
      (p_target_user_id, p_actor, clock_timestamp(), p_scope, p_mfa_required, v_reason,
       NULL, NULL, NULL, 'admin')
    ON CONFLICT (user_id) DO UPDATE SET
      granted_by = EXCLUDED.granted_by,
      granted_at = EXCLUDED.granted_at,
      scope = EXCLUDED.scope,
      mfa_required = EXCLUDED.mfa_required,
      reason = EXCLUDED.reason,
      revoked_at = NULL,
      revoked_by = NULL,
      revoke_reason = NULL
    WHERE public.platform_admins.platform_role = 'admin'
    RETURNING * INTO v_admin;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'owner grants are managed only through recovery procedure' USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.api_audit_log (
      actor_user_id, acting_as_platform_admin, action, resource_type,
      resource_id, request_id, bypassed_rls, metadata
    ) VALUES (
      p_actor, true, 'platform_admin.global_admin_granted', 'platform_admin',
      p_target_user_id, p_request_id, true,
      jsonb_build_object('scope', p_scope, 'mfa_required', p_mfa_required, 'reason', v_reason)
    );
  ELSE
    SELECT * INTO v_admin FROM public.platform_admins
     WHERE user_id = p_target_user_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'global admin not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_admin.platform_role <> 'admin' THEN
      RAISE EXCEPTION 'owner grants are managed only through recovery procedure' USING ERRCODE = '23514';
    END IF;
    IF v_admin.revoked_at IS NULL THEN
      UPDATE public.platform_admins
         SET revoked_at = clock_timestamp(), revoked_by = p_actor,
             revoke_reason = COALESCE(NULLIF(v_reason, ''), 'Revogado pelo proprietário global')
       WHERE user_id = p_target_user_id
       RETURNING * INTO v_admin;
      INSERT INTO public.api_audit_log (
        actor_user_id, acting_as_platform_admin, action, resource_type,
        resource_id, request_id, bypassed_rls, metadata
      ) VALUES (
        p_actor, true, 'platform_admin.global_admin_revoked', 'platform_admin',
        p_target_user_id, p_request_id, true,
        jsonb_build_object('reason', v_admin.revoke_reason)
      );
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'user_id', v_admin.user_id,
    'platform_role', v_admin.platform_role,
    'scope', v_admin.scope,
    'mfa_required', v_admin.mfa_required,
    'revoked_at', v_admin.revoked_at
  );
END;
$$;

REVOKE ALL ON FUNCTION public.fn_platform_manage_global_admin(uuid, uuid, text, text, boolean, text, text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_platform_manage_global_admin(uuid, uuid, text, text, boolean, text, text) TO service_role;
COMMENT ON TABLE public.platform_admins IS
  'Grants globais: sem DML direto por papéis da aplicação; delegação/revogação pelo RPC owner-only fn_platform_manage_global_admin, com auditoria transacional. Recuperação de owner segue procedimento DBA.';

-- The installer-selected provider is server configuration. Apply it within
-- the tenant creation transaction so first-run does not silently revert to
-- the trigger's Anthropic default after owner setup moved to /setup.
CREATE OR REPLACE FUNCTION public.fn_create_tenant_with_owner_limited(
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
  prior public.idempotency_keys%ROWTYPE;
  org public.organizations%ROWTYPE;
  result jsonb;
  dono_e_outra_pessoa boolean;
  v_default_llm_provider text := NULLIF(p_request->>'default_llm_provider', '');
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.platform_admins
     WHERE user_id = p_actor AND revoked_at IS NULL AND scope = 'full'
  ) THEN
    RAISE EXCEPTION 'platform_admin_required' USING ERRCODE = '42501';
  END IF;
  IF v_default_llm_provider IS NOT NULL
     AND v_default_llm_provider NOT IN ('anthropic', 'openai', 'openrouter') THEN
    RAISE EXCEPTION 'default_llm_provider_invalid' USING ERRCODE = '22023';
  END IF;

  PERFORM public.fn_lock_installation_tenant_creation(p_installation_id);
  PERFORM pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_actor::text || ':' || p_key::text, 0)
  );
  SELECT * INTO prior FROM public.idempotency_keys
   WHERE key = p_key::text
     AND endpoint = '/api/v1/admin/tenants:' || p_actor::text
     AND expires_at > pg_catalog.now()
     AND tenant_creation_trusted
   FOR UPDATE;

  IF FOUND THEN
    IF prior.request_hash <> pg_catalog.decode(p_hash, 'hex') THEN
      RAISE EXCEPTION 'idempotency_conflict' USING ERRCODE = '22023';
    END IF;
    IF prior.response_body->>'id' IS DISTINCT FROM prior.organization_id::text
       OR NOT EXISTS (
         SELECT 1 FROM public.organizations
          WHERE id = prior.organization_id AND created_by = p_actor
       ) THEN
      RAISE EXCEPTION 'idempotency_provenance_invalid' USING ERRCODE = '22023';
    END IF;
    RETURN prior.response_body || pg_catalog.jsonb_build_object('created', false);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.platform_plan_catalog
     WHERE slug = p_request->>'plan'
       AND active
  ) THEN
    RAISE EXCEPTION 'plan_unavailable' USING ERRCODE = '22023';
  END IF;

  PERFORM public.fn_assert_installation_tenant_capacity(p_max_tenants);
  dono_e_outra_pessoa := pg_catalog.lower(p_request->>'owner_email') IS DISTINCT FROM (
    SELECT pg_catalog.lower(email) FROM auth.users WHERE id = p_actor
  );

  INSERT INTO public.organizations(display_name, slug, legal_name, cnpj, status, settings, created_by)
  VALUES (
    p_request->>'display_name',
    p_request->>'slug',
    COALESCE(NULLIF(p_request->>'legal_name', ''), p_request->>'display_name'),
    p_request->>'cnpj',
    'active',
    pg_catalog.jsonb_build_object('plan', p_request->>'plan'),
    p_actor
  )
  RETURNING * INTO org;

  IF v_default_llm_provider IS NOT NULL AND v_default_llm_provider <> 'anthropic' THEN
    UPDATE public.organizations
       SET settings = pg_catalog.jsonb_set(
         COALESCE(settings, '{}'::jsonb), '{llm,provider}',
         pg_catalog.to_jsonb(v_default_llm_provider), true
       )
     WHERE id = org.id;
    UPDATE public.organizations AS target
       SET settings = pg_catalog.jsonb_set(
         target.settings, '{llm,default_model}', pg_catalog.to_jsonb(catalog.model_id), true
       )
      FROM (
        SELECT model_id FROM public.ai_models
         WHERE provider = v_default_llm_provider
           AND is_default_for_provider
           AND supports_tools
           AND deprecated_at IS NULL
         LIMIT 1
      ) AS catalog
     WHERE target.id = org.id
       AND NOT EXISTS (
         SELECT 1 FROM public.ai_models AS current_model
          WHERE current_model.provider = v_default_llm_provider
            AND current_model.model_id = target.settings->'llm'->>'default_model'
       );
  END IF;

  INSERT INTO public.user_organizations(
    organization_id, user_id, role, accepted_at, interface_settings, provisional_until_handover
  ) VALUES (
    org.id,
    p_actor,
    'admin',
    pg_catalog.now(),
    CASE WHEN dono_e_outra_pessoa
      THEN '{"preset":"completa"}'::jsonb
      ELSE COALESCE(p_request->'owner_interface_settings', '{"preset":"completa"}'::jsonb)
    END,
    dono_e_outra_pessoa
  );

  result := pg_catalog.jsonb_build_object(
    'id', org.id,
    'slug', org.slug,
    'display_name', org.display_name,
    'invite_id', pg_catalog.gen_random_uuid(),
    'issued_at', pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.now()))::bigint
  );
  INSERT INTO public.idempotency_keys(
    organization_id, key, endpoint, request_hash, status_code, response_body, tenant_creation_trusted
  ) VALUES (
    org.id,
    p_key::text,
    '/api/v1/admin/tenants:' || p_actor::text,
    pg_catalog.decode(p_hash, 'hex'),
    201,
    result,
    true
  );
  RETURN result || pg_catalog.jsonb_build_object('created', true);
END;
$$;

REVOKE ALL ON FUNCTION public.fn_create_tenant_with_owner_limited(uuid, uuid, jsonb, text, text, bigint)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.fn_create_tenant_with_owner_limited(uuid, uuid, jsonb, text, text, bigint)
  TO service_role;

NOTIFY pgrst, 'reload schema';
COMMIT;
