-- Commercial administration fields for the isolated vendor Control Plane.
-- This migration must never be applied to a self-hosted customer database.

alter table control_plane.licensing_customers
  add column if not exists phone text,
  add column if not exists internal_notes text;

alter table control_plane.licensing_events
  add column if not exists request_id text;

alter table control_plane.licensing_admin_operations
  drop constraint if exists licensing_admin_operations_operation_check,
  drop constraint if exists ck_cp_admin_operation_operation,
  add constraint ck_cp_admin_operation_operation
    check (operation in ('renew', 'create_license'));

create index if not exists idx_cp_licenses_status_expiry
  on control_plane.licensing_licenses(status, expires_at, created_at desc);
create index if not exists idx_cp_customers_name
  on control_plane.licensing_customers using btree (lower(name));
create index if not exists idx_cp_events_request_id
  on control_plane.licensing_events(request_id)
  where request_id is not null;

create or replace function control_plane.create_license_draft(
  p_customer_id uuid,
  p_serial text,
  p_license_type text,
  p_plan text,
  p_status text,
  p_max_installations integer,
  p_max_tenants integer,
  p_resale_allowed boolean,
  p_white_label boolean,
  p_features text[],
  p_valid_from timestamptz,
  p_expires_at timestamptz,
  p_maintenance_until timestamptz,
  p_grace_days integer,
  p_signing_key_id text,
  p_offline_validation_tolerance_days integer,
  p_next_check_hours integer,
  p_metadata jsonb,
  p_actor_id text,
  p_request_id text,
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
begin
  if p_customer_id is null
     or nullif(btrim(p_serial), '') is null
     or p_license_type is null or p_license_type not in ('internal', 'partner', 'enterprise')
     or p_plan is null or p_plan not in ('standard', 'pro', 'enterprise')
     or p_status is null or p_status not in ('DRAFT', 'ACTIVE')
     or p_max_installations is null or p_max_installations not between 1 and 10000
     or (p_max_tenants is not null and p_max_tenants < 1)
     or p_valid_from is null or p_expires_at is null or p_valid_from >= p_expires_at
     or p_grace_days is null or p_grace_days not between 0 and 90
     or nullif(btrim(p_signing_key_id), '') is null
     or p_offline_validation_tolerance_days is null or p_offline_validation_tolerance_days not between 0 and 30
     or p_next_check_hours is null or p_next_check_hours not between 1 and 720
     or nullif(btrim(p_actor_id), '') is null
     or nullif(btrim(p_request_id), '') is null
     or nullif(btrim(p_idempotency_key), '') is null
     or length(p_idempotency_key) > 200
     or p_request_fingerprint is null
     or p_request_fingerprint !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid license creation request';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('create_license:' || p_idempotency_key, 0));

  select * into v_operation
    from licensing_admin_operations
   where operation = 'create_license' and idempotency_key = p_idempotency_key
   for update;

  if found then
    if v_operation.request_fingerprint <> p_request_fingerprint then
      raise exception 'idempotency key already used for a different request';
    end if;
    return query select * from licensing_licenses where id = v_operation.license_id;
    return;
  end if;

  if not exists (
    select 1 from licensing_customers where id = p_customer_id and status = 'ACTIVE'
  ) then
    raise exception 'customer is unavailable';
  end if;
  if not exists (
    select 1 from licensing_signer_keys
     where key_id = p_signing_key_id and is_active = true
  ) then
    raise exception 'signing key is unavailable';
  end if;

  insert into licensing_licenses
    (serial, customer_id, product, deployment, plan, license_type, status, signing_key_id,
     issued_at, valid_from, expires_at, maintenance_until, grace_days, max_installations,
     max_tenants, resale_allowed, white_label, features, offline_validation_tolerance_days,
     next_check_hours, metadata, created_at, updated_at)
  values
    (p_serial, p_customer_id, 'clientix', 'self-hosted', p_plan, p_license_type, p_status, p_signing_key_id,
     case when p_status = 'ACTIVE' then now() else null end, p_valid_from, p_expires_at, p_maintenance_until, p_grace_days, p_max_installations,
     p_max_tenants, p_resale_allowed, p_white_label, coalesce(p_features, array[]::text[]),
     p_offline_validation_tolerance_days, p_next_check_hours, coalesce(p_metadata, '{}'::jsonb), now(), now())
  returning * into v_license;

  insert into licensing_admin_operations
    (operation, idempotency_key, license_id, request_fingerprint, completed_at, created_at)
  values ('create_license', p_idempotency_key, v_license.id, p_request_fingerprint, now(), now());

  insert into licensing_events
    (license_id, event_type, payload, actor, actor_type, actor_id, request_id, created_at)
  values
    (v_license.id, 'LICENSE_CREATED', jsonb_build_object('customer_id', p_customer_id, 'plan', p_plan, 'serial', p_serial),
     'admin', 'ADMIN', p_actor_id, p_request_id, now());

  if p_status = 'ACTIVE' then
    insert into licensing_events
      (license_id, event_type, payload, actor, actor_type, actor_id, request_id, created_at)
    values
      (v_license.id, 'LICENSE_ISSUED', jsonb_build_object('serial', p_serial),
       'admin', 'ADMIN', p_actor_id, p_request_id, now());
  end if;

  return next v_license;
end;
$$;

-- A request-scoped setting lets the existing atomic LIC-02 lifecycle
-- functions carry the vendor API request id into the events they insert.
create or replace function control_plane.attach_admin_request_id_to_event()
returns trigger
language plpgsql
set search_path = control_plane, pg_catalog, pg_temp
as $$
begin
  new.request_id := coalesce(new.request_id, nullif(current_setting('clientix.request_id', true), ''));
  return new;
end;
$$;

drop trigger if exists trg_cp_event_request_id on control_plane.licensing_events;
create trigger trg_cp_event_request_id
before insert on control_plane.licensing_events
for each row execute function control_plane.attach_admin_request_id_to_event();

create or replace function control_plane.renew_license_with_request_id(
  p_license_id uuid,
  p_duration_months integer,
  p_duration_days integer,
  p_new_expires_at timestamptz,
  p_new_maintenance_until timestamptz,
  p_has_new_maintenance boolean,
  p_signing_key_id text,
  p_actor_id text,
  p_idempotency_key text,
  p_request_fingerprint text,
  p_request_id text,
  p_renewal_basis text
)
returns setof control_plane.licensing_licenses
language plpgsql
set search_path = control_plane, pg_catalog, pg_temp
as $$
declare
  v_license control_plane.licensing_licenses%rowtype;
  v_expiration timestamptz;
begin
  if p_request_id is null or nullif(btrim(p_request_id), '') is null or length(p_request_id) > 200 then
    raise exception 'invalid request id';
  end if;
  perform set_config('clientix.request_id', p_request_id, true);

  select * into v_license from control_plane.licensing_licenses where id = p_license_id for update;
  if not found then raise exception 'license not found'; end if;
  if num_nonnulls(p_duration_months, p_duration_days, p_new_expires_at) <> 1 then
    raise exception 'choose exactly one renewal duration or custom expiration';
  end if;
  if p_duration_months is not null and p_duration_months not between 1 and 120 then
    raise exception 'invalid renewal duration';
  end if;
  if p_duration_days is not null and p_duration_days not between 1 and 3650 then
    raise exception 'invalid renewal duration';
  end if;
  if p_renewal_basis is not null and p_renewal_basis not in ('previous_expiration', 'today') then
    raise exception 'invalid renewal basis';
  end if;
  if v_license.expires_at <= clock_timestamp()
     and (p_renewal_basis is null or p_renewal_basis not in ('previous_expiration', 'today')) then
    raise exception 'expired license renewal basis is required';
  end if;
  if p_new_expires_at is not null then
    v_expiration := p_new_expires_at;
  elsif p_duration_days is not null then
    v_expiration := (case
      when p_renewal_basis = 'today' then clock_timestamp()
      else v_license.expires_at
    end) + make_interval(days => p_duration_days);
  else
    v_expiration := (case
      when p_renewal_basis = 'today' then clock_timestamp()
      else v_license.expires_at
    end) + make_interval(months => p_duration_months);
  end if;

  return query select * from control_plane.renew_license(
    p_license_id,
    null,
    v_expiration,
    p_new_maintenance_until,
    p_has_new_maintenance,
    p_signing_key_id,
    p_actor_id,
    p_idempotency_key,
    p_request_fingerprint
  );
end;
$$;

create or replace function control_plane.transfer_license_installation_with_request_id(
  p_expected_license_id uuid,
  p_from_installation_id text,
  p_to_installation_id text,
  p_to_public_key text,
  p_to_public_key_fingerprint text,
  p_clientix_version text,
  p_reason text,
  p_actor_id text,
  p_request_id text
)
returns table (license_id uuid, from_installation_id text, to_installation_id text)
language plpgsql
set search_path = control_plane, pg_catalog, pg_temp
as $$
begin
  if p_request_id is null or nullif(btrim(p_request_id), '') is null or length(p_request_id) > 200 then
    raise exception 'invalid request id';
  end if;
  perform set_config('clientix.request_id', p_request_id, true);
  return query select * from control_plane.transfer_license_installation(
    p_expected_license_id, p_from_installation_id, p_to_installation_id,
    p_to_public_key, p_to_public_key_fingerprint, p_clientix_version, p_reason, p_actor_id
  );
end;
$$;

create or replace function control_plane.authorize_installation_recovery_with_request_id(
  p_installation_id text,
  p_code_digest text,
  p_reason text,
  p_actor_id text,
  p_expires_at timestamptz,
  p_request_id text
)
returns table (recovery_id uuid, recovery_expires_at timestamptz)
language plpgsql
set search_path = control_plane, pg_catalog, pg_temp
as $$
begin
  if p_request_id is null or nullif(btrim(p_request_id), '') is null or length(p_request_id) > 200 then
    raise exception 'invalid request id';
  end if;
  perform set_config('clientix.request_id', p_request_id, true);
  return query select * from control_plane.authorize_installation_recovery(
    p_installation_id, p_code_digest, p_reason, p_actor_id, p_expires_at
  );
end;
$$;

revoke execute on function control_plane.attach_admin_request_id_to_event() from public;
revoke execute on function control_plane.renew_license_with_request_id(uuid, integer, integer, timestamptz, timestamptz, boolean, text, text, text, text, text, text) from public;
revoke execute on function control_plane.transfer_license_installation_with_request_id(uuid, text, text, text, text, text, text, text, text) from public;
revoke execute on function control_plane.authorize_installation_recovery_with_request_id(text, text, text, text, timestamptz, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'clientix_control_plane') then
    execute 'grant execute on function control_plane.renew_license_with_request_id(uuid, integer, integer, timestamptz, timestamptz, boolean, text, text, text, text, text, text) to clientix_control_plane';
    execute 'grant execute on function control_plane.transfer_license_installation_with_request_id(uuid, text, text, text, text, text, text, text, text) to clientix_control_plane';
    execute 'grant execute on function control_plane.authorize_installation_recovery_with_request_id(text, text, text, text, timestamptz, text) to clientix_control_plane';
  end if;
end;
$$;

revoke execute on function control_plane.create_license_draft(uuid, text, text, text, text, integer, integer, boolean, boolean, text[], timestamptz, timestamptz, timestamptz, integer, text, integer, integer, jsonb, text, text, text, text) from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'clientix_control_plane') then
    execute 'grant execute on function control_plane.create_license_draft(uuid, text, text, text, text, integer, integer, boolean, boolean, text[], timestamptz, timestamptz, timestamptz, integer, text, integer, integer, jsonb, text, text, text, text) to clientix_control_plane';
    execute 'grant select, update on control_plane.licensing_customers to clientix_control_plane';
    execute 'grant select, insert on control_plane.licensing_admin_operations to clientix_control_plane';
  end if;
end;
$$;
