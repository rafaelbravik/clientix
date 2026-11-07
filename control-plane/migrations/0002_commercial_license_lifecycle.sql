-- Clientix License Server lifecycle extension.
-- This migration belongs to the isolated vendor Control Plane database only.
-- Never apply it to a self-hosted customer database.

alter table control_plane.licensing_customers
  add column if not exists status text not null default 'ACTIVE',
  add column if not exists document_hash text;

alter table control_plane.licensing_customers
  drop constraint if exists licensing_customers_status_check,
  drop constraint if exists ck_cp_customer_status;
alter table control_plane.licensing_customers
  add constraint ck_cp_customer_status check (status in ('ACTIVE', 'DISABLED'));
create unique index if not exists uq_cp_customer_document_hash
  on control_plane.licensing_customers(document_hash)
  where document_hash is not null;

alter table control_plane.licensing_licenses
  add column if not exists serial text,
  add column if not exists product text not null default 'clientix',
  add column if not exists deployment text not null default 'self-hosted',
  add column if not exists plan text not null default 'pro',
  add column if not exists revoked_at timestamptz,
  add column if not exists revocation_reason text,
  add column if not exists offline_validation_tolerance_days integer not null default 7,
  add column if not exists next_check_hours integer not null default 24;

-- Preserve legacy revoked records while satisfying the explicit revocation rule.
update control_plane.licensing_licenses
set revoked_at = coalesce(revoked_at, updated_at, now()),
    revocation_reason = coalesce(nullif(btrim(revocation_reason), ''), 'Legacy revocation')
where status = 'REVOKED';

update control_plane.licensing_licenses
set serial = 'CLX-' || to_char(issued_at, 'YYYY') || '-' || upper(substr(replace(id::text, '-', ''), 1, 4)) || '-' || upper(substr(replace(id::text, '-', ''), 5, 4))
where serial is null;

alter table control_plane.licensing_licenses
  alter column serial set not null,
  alter column issued_at drop not null;
alter table control_plane.licensing_licenses
  drop constraint if exists licensing_licenses_status_check;
alter table control_plane.licensing_licenses
  add constraint ck_cp_license_commercial_status
  check (status in ('DRAFT', 'ACTIVE', 'EXPIRED', 'SUSPENDED', 'REVOKED'));
alter table control_plane.licensing_licenses
  drop constraint if exists ck_cp_license_product,
  drop constraint if exists ck_cp_license_deployment,
  drop constraint if exists ck_cp_license_plan,
  drop constraint if exists ck_cp_license_offline_tolerance,
  drop constraint if exists ck_cp_license_next_check,
  drop constraint if exists ck_cp_license_revocation_reason;
alter table control_plane.licensing_licenses
  add constraint ck_cp_license_product check (product = 'clientix'),
  add constraint ck_cp_license_deployment check (deployment = 'self-hosted'),
  add constraint ck_cp_license_plan check (plan in ('standard', 'pro', 'enterprise')),
  add constraint ck_cp_license_offline_tolerance check (offline_validation_tolerance_days between 0 and 30),
  add constraint ck_cp_license_next_check check (next_check_hours between 1 and 720),
  add constraint ck_cp_license_revocation_reason check (
    (status = 'REVOKED' and revoked_at is not null and nullif(btrim(revocation_reason), '') is not null)
    or (status <> 'REVOKED')
  );
create unique index if not exists uq_cp_license_serial on control_plane.licensing_licenses(serial);

alter table control_plane.licensing_installations
  drop constraint if exists licensing_installations_status_check;
alter table control_plane.licensing_installations
  add constraint ck_cp_installation_status
  check (status in ('ACTIVE', 'SUSPENDED', 'REVOKED', 'DEACTIVATED', 'TRANSFERRED', 'DISABLED'));
alter table control_plane.licensing_installations
  add column if not exists last_seen_at timestamptz,
  add column if not exists last_validation_at timestamptz,
  add column if not exists clientix_version text,
  add column if not exists first_ip_hash text,
  add column if not exists metadata jsonb not null default '{}'::jsonb,
  add column if not exists activation_code_id uuid
    references control_plane.licensing_activation_codes(id) on delete set null;

alter table control_plane.licensing_events
  add column if not exists actor_type text not null default 'SYSTEM',
  add column if not exists actor_id text;

create index if not exists idx_cp_installations_last_validation
  on control_plane.licensing_installations(last_validation_at desc nulls last);
create index if not exists idx_cp_installations_activation_code
  on control_plane.licensing_installations(activation_code_id)
  where activation_code_id is not null;

-- Distributed fixed-window rate limiting. Only HMAC digests are stored; raw IPs
-- and installation identifiers are never retained in this table.
create table if not exists control_plane.licensing_rate_limit_buckets (
  key_digest text not null check (key_digest ~ '^[0-9a-f]{64}$'),
  window_start timestamptz not null,
  request_count integer not null check (request_count > 0),
  updated_at timestamptz not null default now(),
  primary key (key_digest, window_start)
);
create index if not exists idx_cp_rate_limit_window_start
  on control_plane.licensing_rate_limit_buckets(window_start);

-- Admin retries must not extend a term twice after a dropped connection.
-- The key is opaque and stores no request body or credential.
create table if not exists control_plane.licensing_admin_operations (
  operation text not null check (operation in ('renew')),
  idempotency_key text not null check (length(idempotency_key) between 16 and 200),
  license_id uuid not null references control_plane.licensing_licenses(id) on delete restrict,
  request_fingerprint text not null check (request_fingerprint ~ '^[0-9a-f]{64}$'),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  primary key (operation, idempotency_key)
);

create or replace function control_plane.renew_license(
  p_license_id uuid,
  p_duration_months integer,
  p_new_expires_at timestamptz,
  p_new_maintenance_until timestamptz,
  p_has_new_maintenance boolean,
  p_signing_key_id text,
  p_actor_id text,
  p_idempotency_key text,
  p_request_fingerprint text
)
returns setof control_plane.licensing_licenses
language plpgsql
set search_path = control_plane, pg_catalog, pg_temp
as $$
declare
  v_operation control_plane.licensing_admin_operations%rowtype;
  v_license control_plane.licensing_licenses%rowtype;
  v_new_expires_at timestamptz;
begin
  if p_license_id is null
     or nullif(btrim(p_signing_key_id), '') is null
     or nullif(btrim(p_actor_id), '') is null
     or nullif(btrim(p_idempotency_key), '') is null
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$'
     or (p_duration_months is null) = (p_new_expires_at is null)
     or (p_duration_months is not null and p_duration_months not between 1 and 120) then
    raise exception 'invalid license renewal request';
  end if;

  insert into licensing_admin_operations (operation, idempotency_key, license_id, request_fingerprint)
  values ('renew', p_idempotency_key, p_license_id, p_request_fingerprint)
  on conflict (operation, idempotency_key) do nothing;

  select * into v_operation
  from licensing_admin_operations
  where operation = 'renew' and idempotency_key = p_idempotency_key
  for update;

  if v_operation.license_id <> p_license_id or v_operation.request_fingerprint <> p_request_fingerprint then
    raise exception 'idempotency key already used for a different request';
  end if;

  select * into v_license
  from licensing_licenses
  where id = p_license_id
  for update;

  if not found or v_license.status in ('DRAFT', 'REVOKED') then
    raise exception 'license is not eligible for renewal';
  end if;

  if v_operation.completed_at is not null then
    return next v_license;
    return;
  end if;

  if p_new_expires_at is not null then
    v_new_expires_at := p_new_expires_at;
  else
    v_new_expires_at := greatest(v_license.expires_at, clock_timestamp())
      + make_interval(months => p_duration_months);
  end if;

  if v_new_expires_at <= v_license.valid_from then
    raise exception 'renewed expiration must follow valid_from';
  end if;

  update licensing_licenses
  set expires_at = v_new_expires_at,
      maintenance_until = case when p_has_new_maintenance then p_new_maintenance_until else maintenance_until end,
      status = case when status = 'EXPIRED' then 'ACTIVE' else status end,
      signing_key_id = p_signing_key_id,
      issued_at = clock_timestamp(),
      updated_at = clock_timestamp()
  where id = p_license_id
  returning * into v_license;

  insert into licensing_events
    (license_id, event_type, payload, actor, actor_type, actor_id, created_at)
  values
    (p_license_id, 'LICENSE_RENEWED', jsonb_build_object('expires_at', v_new_expires_at), 'admin', 'ADMIN', p_actor_id, now()),
    (p_license_id, 'LICENSE_REISSUED', jsonb_build_object('key_id', p_signing_key_id), 'admin', 'ADMIN', p_actor_id, now());

  update licensing_admin_operations
  set completed_at = now()
  where operation = 'renew' and idempotency_key = p_idempotency_key;

  return next v_license;
end;
$$;

-- Atomic administrative transfer: lock the license and source installation,
-- deactivate the old key, and register the target key in one database statement.
create or replace function control_plane.transfer_license_installation(
  p_expected_license_id uuid,
  p_from_installation_id text,
  p_to_installation_id text,
  p_to_public_key text,
  p_to_public_key_fingerprint text,
  p_clientix_version text,
  p_reason text,
  p_actor_id text
)
returns table (license_id uuid, from_installation_id text, to_installation_id text)
language plpgsql
set search_path = control_plane, pg_catalog, pg_temp
as $$
declare
  v_license_id uuid;
  v_source_status text;
  v_license_status text;
  v_existing_license_id uuid;
  v_existing_fingerprint text;
  v_max_installations integer;
  v_active_installations integer;
begin
  if p_expected_license_id is null
     or p_from_installation_id = p_to_installation_id
     or nullif(btrim(p_reason), '') is null
     or p_to_public_key_fingerprint !~* '^[0-9a-f]{64}$' then
    raise exception 'invalid transfer request';
  end if;

  select i.license_id, i.status into v_license_id, v_source_status
  from licensing_installations i
  where i.id = p_from_installation_id
  for update;

  if not found or v_license_id <> p_expected_license_id then raise exception 'source installation unavailable'; end if;

  select l.status, l.max_installations into v_license_status, v_max_installations
  from licensing_licenses l
  where l.id = v_license_id
  for update;

  if v_license_status <> 'ACTIVE' then raise exception 'license unavailable'; end if;

  -- Retry after a committed transfer returns the existing target without
  -- creating another row or event.
  if v_source_status = 'TRANSFERRED' then
    select i.license_id, i.public_key_fingerprint
      into v_existing_license_id, v_existing_fingerprint
    from licensing_installations i
    where i.id = p_to_installation_id and i.status = 'ACTIVE';
    if v_existing_license_id = v_license_id and v_existing_fingerprint = p_to_public_key_fingerprint then
      return query select v_license_id, p_from_installation_id, p_to_installation_id;
      return;
    end if;
    raise exception 'source installation already transferred';
  end if;

  if v_source_status <> 'ACTIVE' then raise exception 'source installation unavailable'; end if;

  if exists (select 1 from licensing_installations i where i.id = p_to_installation_id)
     or exists (select 1 from licensing_installations i where i.public_key_fingerprint = p_to_public_key_fingerprint) then
    raise exception 'target installation unavailable';
  end if;

  select count(*)::integer into v_active_installations
  from licensing_installations i
  where i.license_id = v_license_id and i.status = 'ACTIVE';
  if v_active_installations > v_max_installations then raise exception 'installation limit exceeded'; end if;

  update licensing_installations
  set status = 'TRANSFERRED', updated_at = now()
  where id = p_from_installation_id;

  insert into licensing_installations
    (id, license_id, public_key, public_key_fingerprint, status, environment, app_version,
     last_heartbeat_at, last_seen_at, last_validation_at, clientix_version, created_at, updated_at)
  values
    (p_to_installation_id, v_license_id, p_to_public_key, p_to_public_key_fingerprint,
     'ACTIVE', 'production', p_clientix_version, now(), now(), now(), p_clientix_version, now(), now());

  insert into licensing_events (license_id, installation_id, event_type, payload, actor, actor_type, actor_id, created_at)
  values
    (v_license_id, p_from_installation_id, 'INSTALLATION_TRANSFERRED',
     jsonb_build_object('to_installation_id', p_to_installation_id, 'reason', left(btrim(p_reason), 500)),
     'admin', 'ADMIN', p_actor_id, now()),
    (v_license_id, p_to_installation_id, 'INSTALLATION_REGISTERED',
     jsonb_build_object('from_installation_id', p_from_installation_id),
     'admin', 'ADMIN', p_actor_id, now());

  return query select v_license_id, p_from_installation_id, p_to_installation_id;
end;
$$;

revoke all on function control_plane.transfer_license_installation(uuid, text, text, text, text, text, text, text) from public;

revoke all on control_plane.licensing_rate_limit_buckets from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on control_plane.licensing_rate_limit_buckets from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on control_plane.licensing_rate_limit_buckets from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'clientix_control_plane') then
    execute 'grant select, insert, update, delete on control_plane.licensing_rate_limit_buckets to clientix_control_plane';
    execute 'grant select, insert, update on control_plane.licensing_admin_operations to clientix_control_plane';
    execute 'grant execute on function control_plane.transfer_license_installation(uuid, text, text, text, text, text, text, text) to clientix_control_plane';
    execute 'grant execute on function control_plane.renew_license(uuid, integer, timestamptz, timestamptz, boolean, text, text, text, text) to clientix_control_plane';
  end if;
end;
$$;

revoke all on function control_plane.renew_license(uuid, integer, timestamptz, timestamptz, boolean, text, text, text, text) from public;
revoke all on control_plane.licensing_admin_operations from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on control_plane.licensing_admin_operations from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on control_plane.licensing_admin_operations from authenticated';
  end if;
end;
$$;
