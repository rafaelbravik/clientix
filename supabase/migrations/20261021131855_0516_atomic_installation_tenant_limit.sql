-- Serializes every supported tenant-creation path for this installation and
-- checks the signed-license limit in the same PostgreSQL transaction as insert.

create or replace function public.fn_lock_installation_tenant_creation(
  p_installation_id text
) returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_installation_id is null or p_installation_id !~* '^inst_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$' then
    raise exception 'INSTALLATION_ID_INVALID' using errcode = '22023';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(
      'clientix:installation:max-tenants:' || pg_catalog.lower(p_installation_id),
      0
    )
  );
end;
$$;

revoke all on function public.fn_lock_installation_tenant_creation(text)
  from public, anon, authenticated, service_role;

create or replace function public.fn_assert_installation_tenant_capacity(
  p_max_tenants bigint
) returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_current bigint;
begin
  if p_max_tenants is null then
    return;
  end if;
  if p_max_tenants < 1 then
    raise exception 'INSTALLATION_TENANT_LIMIT_INVALID' using errcode = '22023';
  end if;

  -- The existing installation contract counts every organization row. A
  -- suspension, archive, redaction, or soft-delete marker does not free a slot.
  select pg_catalog.count(*) into v_current from public.organizations;
  if v_current >= p_max_tenants then
    raise exception using
      errcode = 'P0001',
      message = 'GLOBAL_TENANT_LIMIT_REACHED',
      detail = pg_catalog.jsonb_build_object(
        'current', v_current,
        'max', p_max_tenants
      )::text;
  end if;
end;
$$;

revoke all on function public.fn_assert_installation_tenant_capacity(bigint)
  from public, anon, authenticated, service_role;

-- The historical RPC remains for owner-level migration/invariant checks only.
-- Runtime PostgREST roles must use the limited entry point below.
revoke all on function public.fn_create_tenant_with_owner(uuid, uuid, jsonb, text)
  from public, anon, authenticated, service_role;

create or replace function public.fn_create_tenant_with_owner_limited(
  p_actor uuid,
  p_key uuid,
  p_request jsonb,
  p_hash text,
  p_installation_id text,
  p_max_tenants bigint
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  prior public.idempotency_keys%rowtype;
  org public.organizations%rowtype;
  result jsonb;
  dono_e_outra_pessoa boolean;
begin
  if not exists (
    select 1 from public.platform_admins
    where user_id = p_actor and revoked_at is null and scope = 'full'
  ) then
    raise exception 'platform_admin_required' using errcode = '42501';
  end if;

  perform public.fn_lock_installation_tenant_creation(p_installation_id);
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_actor::text || ':' || p_key::text, 0)
  );
  select * into prior from public.idempotency_keys
  where key = p_key::text
    and endpoint = '/api/v1/admin/tenants:' || p_actor::text
    and expires_at > pg_catalog.now()
    and tenant_creation_trusted
  for update;

  if found then
    if prior.request_hash <> pg_catalog.decode(p_hash, 'hex') then
      raise exception 'idempotency_conflict' using errcode = '22023';
    end if;
    if prior.response_body->>'id' is distinct from prior.organization_id::text
      or not exists (
        select 1 from public.organizations
        where id = prior.organization_id and created_by = p_actor
      ) then
      raise exception 'idempotency_provenance_invalid' using errcode = '22023';
    end if;
    return prior.response_body || pg_catalog.jsonb_build_object('created', false);
  end if;

  perform public.fn_assert_installation_tenant_capacity(p_max_tenants);

  dono_e_outra_pessoa := pg_catalog.lower(p_request->>'owner_email') is distinct from (
    select pg_catalog.lower(email) from auth.users where id = p_actor
  );

  insert into public.organizations(display_name, slug, legal_name, cnpj, status, settings, created_by)
  values (
    p_request->>'display_name',
    p_request->>'slug',
    coalesce(nullif(p_request->>'legal_name', ''), p_request->>'display_name'),
    p_request->>'cnpj',
    'active',
    pg_catalog.jsonb_build_object('plan', p_request->>'plan'),
    p_actor
  )
  returning * into org;

  insert into public.user_organizations(
    organization_id, user_id, role, accepted_at, interface_settings, provisional_until_handover
  ) values (
    org.id,
    p_actor,
    'admin',
    pg_catalog.now(),
    case when dono_e_outra_pessoa
      then '{"preset":"completa"}'::jsonb
      else coalesce(p_request->'owner_interface_settings', '{"preset":"completa"}'::jsonb)
    end,
    dono_e_outra_pessoa
  );

  result := pg_catalog.jsonb_build_object(
    'id', org.id,
    'slug', org.slug,
    'display_name', org.display_name,
    'invite_id', pg_catalog.gen_random_uuid(),
    'issued_at', pg_catalog.floor(pg_catalog.date_part('epoch', pg_catalog.now()))::bigint
  );
  insert into public.idempotency_keys(
    organization_id, key, endpoint, request_hash, status_code, response_body, tenant_creation_trusted
  ) values (
    org.id,
    p_key::text,
    '/api/v1/admin/tenants:' || p_actor::text,
    pg_catalog.decode(p_hash, 'hex'),
    201,
    result,
    true
  );
  return result || pg_catalog.jsonb_build_object('created', true);
end;
$$;

revoke all on function public.fn_create_tenant_with_owner_limited(uuid, uuid, jsonb, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.fn_create_tenant_with_owner_limited(uuid, uuid, jsonb, text, text, bigint)
  to service_role;

create or replace function public.fn_provision_signup_tenant_limited(
  p_user uuid,
  p_slug text,
  p_organization_name text,
  p_installation_id text,
  p_max_tenants bigint
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org_id uuid;
  v_org public.organizations%rowtype;
begin
  if p_user is null or nullif(pg_catalog.btrim(p_slug), '') is null
    or nullif(pg_catalog.btrim(p_organization_name), '') is null then
    raise exception 'TENANT_CREATION_INPUT_INVALID' using errcode = '22023';
  end if;

  perform public.fn_lock_installation_tenant_creation(p_installation_id);

  select organization_id into v_org_id
  from public.user_organizations
  where user_id = p_user and revoked_at is null
  order by accepted_at nulls last, id
  limit 1;
  if found then
    return pg_catalog.jsonb_build_object(
      'provisioned', false,
      'organization_id', v_org_id
    );
  end if;

  perform public.fn_assert_installation_tenant_capacity(p_max_tenants);
  insert into public.organizations(slug, display_name, legal_name, status, created_by)
  values (p_slug, p_organization_name, p_organization_name, 'active', p_user)
  returning * into v_org;
  insert into public.user_organizations(organization_id, user_id, role, accepted_at)
  values (v_org.id, p_user, 'admin', pg_catalog.now());

  return pg_catalog.jsonb_build_object(
    'provisioned', true,
    'organization_id', v_org.id,
    'slug', v_org.slug
  );
end;
$$;

revoke all on function public.fn_provision_signup_tenant_limited(uuid, text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.fn_provision_signup_tenant_limited(uuid, text, text, text, bigint)
  to service_role;

create or replace function public.fn_provision_external_tenant_limited(
  p_owner uuid,
  p_slug text,
  p_organization_name text,
  p_integration text,
  p_external_id text,
  p_installation_id text,
  p_max_tenants bigint
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org public.organizations%rowtype;
  v_marker jsonb;
begin
  if p_owner is null or nullif(pg_catalog.btrim(p_slug), '') is null
    or nullif(pg_catalog.btrim(p_organization_name), '') is null
    or nullif(pg_catalog.btrim(p_integration), '') is null
    or nullif(pg_catalog.btrim(p_external_id), '') is null then
    raise exception 'TENANT_CREATION_INPUT_INVALID' using errcode = '22023';
  end if;

  perform public.fn_lock_installation_tenant_creation(p_installation_id);
  select * into v_org from public.organizations where slug = p_slug for update;
  v_marker := pg_catalog.jsonb_build_object(
    'integration', p_integration,
    'external_id', p_external_id
  );

  if found then
    if v_org.settings->'provisioning' is distinct from v_marker then
      raise exception 'PROVISIONING_SLUG_CONFLICT' using errcode = '22023';
    end if;
    insert into public.user_organizations(organization_id, user_id, role, accepted_at)
    values (v_org.id, v_org.created_by, 'admin', pg_catalog.now())
    on conflict (user_id, organization_id) do nothing;
    return pg_catalog.jsonb_build_object(
      'organization_id', v_org.id,
      'owner_id', v_org.created_by,
      'created', false
    );
  end if;

  perform public.fn_assert_installation_tenant_capacity(p_max_tenants);
  insert into public.organizations(slug, display_name, legal_name, status, created_by, settings)
  values (
    p_slug,
    p_organization_name,
    p_organization_name,
    'active',
    p_owner,
    pg_catalog.jsonb_build_object('provisioning', v_marker)
  )
  returning * into v_org;
  insert into public.user_organizations(organization_id, user_id, role, accepted_at)
  values (v_org.id, p_owner, 'admin', pg_catalog.now());

  return pg_catalog.jsonb_build_object(
    'organization_id', v_org.id,
    'owner_id', p_owner,
    'created', true
  );
end;
$$;

revoke all on function public.fn_provision_external_tenant_limited(uuid, text, text, text, text, text, bigint)
  from public, anon, authenticated;
grant execute on function public.fn_provision_external_tenant_limited(uuid, text, text, text, text, text, bigint)
  to service_role;

-- The installer bootstrap may create only the first organization. A valid
-- signed license always permits at least one tenant, and the lock is identical
-- to the runtime creation paths; re-running bootstrap returns its existing row.
create or replace function public.fn_bootstrap_first_tenant(
  p_installation_id text,
  p_owner uuid,
  p_slug text,
  p_display_name text,
  p_legal_name text,
  p_locale text
) returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_org public.organizations%rowtype;
  v_count bigint;
begin
  if p_owner is null or nullif(pg_catalog.btrim(p_slug), '') is null
    or nullif(pg_catalog.btrim(p_display_name), '') is null
    or p_locale is null or p_locale not in ('pt-BR', 'es') then
    raise exception 'BOOTSTRAP_TENANT_INPUT_INVALID' using errcode = '22023';
  end if;

  perform public.fn_lock_installation_tenant_creation(p_installation_id);
  select * into v_org from public.organizations where slug = p_slug for update;
  if found then
    if v_org.created_by is distinct from p_owner then
      raise exception 'BOOTSTRAP_TENANT_SLUG_CONFLICT' using errcode = '22023';
    end if;
    return pg_catalog.jsonb_build_object('id', v_org.id, 'slug', v_org.slug, 'created', false);
  end if;

  select pg_catalog.count(*) into v_count from public.organizations;
  if v_count > 0 then
    raise exception 'BOOTSTRAP_FIRST_TENANT_ONLY' using errcode = 'P0001';
  end if;

  insert into public.organizations(slug, display_name, legal_name, locale, status, created_by)
  values (p_slug, p_display_name, coalesce(nullif(p_legal_name, ''), p_display_name), p_locale, 'active', p_owner)
  returning * into v_org;
  insert into public.user_organizations(organization_id, user_id, role, accepted_at)
  values (v_org.id, p_owner, 'admin', pg_catalog.now());

  return pg_catalog.jsonb_build_object('id', v_org.id, 'slug', v_org.slug, 'created', true);
end;
$$;

revoke all on function public.fn_bootstrap_first_tenant(text, uuid, text, text, text, text)
  from public, anon, authenticated;
grant execute on function public.fn_bootstrap_first_tenant(text, uuid, text, text, text, text)
  to service_role;

-- No PostgREST role may bypass the creation functions with a direct insert.
-- The SECURITY DEFINER functions above execute as the table owner.
revoke insert on table public.organizations from public, anon, authenticated, service_role;

notify pgrst, 'reload schema';
