-- Installation attestation and clone detection for the vendor Control Plane.
-- This migration must never be applied to a self-hosted customer database.

alter table control_plane.licensing_installations
  add column if not exists clone_status text not null default 'NORMAL',
  add column if not exists clone_conflict_count integer not null default 0,
  add column if not exists last_clone_conflict_at timestamptz;

alter table control_plane.licensing_installations
  drop constraint if exists ck_cp_installation_clone_status,
  add constraint ck_cp_installation_clone_status
    check (clone_status in ('NORMAL', 'SUSPECTED_CLONE', 'CLONE_CONFIRMED', 'TRANSFER_PENDING')),
  drop constraint if exists ck_cp_installation_clone_conflict_count,
  add constraint ck_cp_installation_clone_conflict_count check (clone_conflict_count >= 0);

create table if not exists control_plane.licensing_instance_sessions (
  session_id text primary key check (session_id ~ '^sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  license_id uuid not null references control_plane.licensing_licenses(id) on delete restrict,
  installation_id text not null references control_plane.licensing_installations(id) on delete restrict,
  status text not null default 'ACTIVE' check (status in ('ACTIVE', 'ENDED')),
  boot_started_at timestamptz not null,
  started_at timestamptz not null default now(),
  last_heartbeat_at timestamptz not null default now(),
  ended_at timestamptz,
  clientix_version text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_cp_session_end_state check ((status = 'ACTIVE' and ended_at is null) or (status = 'ENDED' and ended_at is not null))
);

create index if not exists idx_cp_instance_sessions_active_installation
  on control_plane.licensing_instance_sessions(installation_id, last_heartbeat_at desc)
  where status = 'ACTIVE';
create index if not exists idx_cp_instance_sessions_license
  on control_plane.licensing_instance_sessions(license_id, last_heartbeat_at desc);

create table if not exists control_plane.licensing_attestation_challenges (
  challenge_digest text primary key check (challenge_digest ~ '^[0-9a-f]{64}$'),
  license_id uuid not null references control_plane.licensing_licenses(id) on delete restrict,
  installation_id text not null references control_plane.licensing_installations(id) on delete restrict,
  session_id text not null check (session_id ~ '^sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'),
  boot_started_at timestamptz not null,
  clientix_version text,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_cp_attestation_challenges_expiry
  on control_plane.licensing_attestation_challenges(expires_at);

create table if not exists control_plane.licensing_installation_recoveries (
  id uuid primary key default gen_random_uuid(),
  installation_id text not null references control_plane.licensing_installations(id) on delete restrict,
  code_digest text not null unique check (code_digest ~ '^[0-9a-f]{64}$'),
  reason text not null check (length(btrim(reason)) between 3 and 500),
  actor_id text not null,
  expires_at timestamptz not null,
  consumed_at timestamptz,
  consumed_public_key_fingerprint text,
  created_at timestamptz not null default now()
);
create unique index if not exists uq_cp_installation_recovery_pending
  on control_plane.licensing_installation_recoveries(installation_id)
  where consumed_at is null;
create index if not exists idx_cp_installation_recovery_expiry
  on control_plane.licensing_installation_recoveries(expires_at);

-- Any administrative installation state transition invalidates its live boot
-- sessions. Missing heartbeats alone never imply a clone; sessions only become
-- stale for conflict counting after the configured server-side freshness window.
create or replace function control_plane.end_sessions_for_inactive_installation()
returns trigger
language plpgsql
set search_path = control_plane, pg_catalog, pg_temp
as $$
declare
  v_session record;
begin
  if new.status <> 'ACTIVE' and old.status = 'ACTIVE' then
    for v_session in
      update licensing_instance_sessions
         set status = 'ENDED', ended_at = clock_timestamp(), updated_at = clock_timestamp()
       where installation_id = new.id and status = 'ACTIVE'
       returning license_id, installation_id, session_id
    loop
      insert into licensing_events
        (license_id, installation_id, event_type, payload, actor, actor_type, created_at)
      values
        (v_session.license_id, v_session.installation_id, 'INSTANCE_SESSION_ENDED',
         jsonb_build_object('session_id', v_session.session_id, 'reason', 'installation_status_changed'),
         'system', 'SYSTEM', clock_timestamp());
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_cp_end_sessions_for_inactive_installation on control_plane.licensing_installations;
create trigger trg_cp_end_sessions_for_inactive_installation
after update of status on control_plane.licensing_installations
for each row execute function control_plane.end_sessions_for_inactive_installation();

create or replace function control_plane.end_sessions_for_inactive_license()
returns trigger
language plpgsql
set search_path = control_plane, pg_catalog, pg_temp
as $$
declare
  v_session record;
begin
  if new.status in ('SUSPENDED', 'REVOKED') and old.status is distinct from new.status then
    for v_session in
      update licensing_instance_sessions
         set status = 'ENDED', ended_at = clock_timestamp(), updated_at = clock_timestamp()
       where license_id = new.id and status = 'ACTIVE'
       returning license_id, installation_id, session_id
    loop
      insert into licensing_events
        (license_id, installation_id, event_type, payload, actor, actor_type, created_at)
      values
        (v_session.license_id, v_session.installation_id, 'INSTANCE_SESSION_ENDED',
         jsonb_build_object('session_id', v_session.session_id, 'reason', 'license_status_changed'),
         'system', 'SYSTEM', clock_timestamp());
    end loop;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_cp_end_sessions_for_inactive_license on control_plane.licensing_licenses;
create trigger trg_cp_end_sessions_for_inactive_license
after update of status on control_plane.licensing_licenses
for each row execute function control_plane.end_sessions_for_inactive_license();

create or replace function control_plane.authorize_installation_recovery(
  p_installation_id text,
  p_code_digest text,
  p_reason text,
  p_actor_id text,
  p_expires_at timestamptz
)
returns table (recovery_id uuid, recovery_expires_at timestamptz)
language plpgsql
set search_path = control_plane, pg_catalog, pg_temp
as $$
declare
  v_installation licensing_installations%rowtype;
begin
  if nullif(btrim(p_installation_id), '') is null
     or p_code_digest is null or p_code_digest !~ '^[0-9a-f]{64}$'
     or nullif(btrim(p_reason), '') is null
     or length(btrim(p_reason)) > 500
     or nullif(btrim(p_actor_id), '') is null
     or p_expires_at <= clock_timestamp()
     or p_expires_at > clock_timestamp() + interval '24 hours' then
    raise exception 'invalid installation recovery authorization';
  end if;

  select * into v_installation
    from licensing_installations
   where id = p_installation_id
   for update;
  if not found or v_installation.status <> 'ACTIVE' then
    raise exception 'installation is not eligible for recovery';
  end if;

  update licensing_installation_recoveries
     set consumed_at = clock_timestamp()
   where installation_id = p_installation_id
     and consumed_at is null
     and expires_at <= clock_timestamp();

  if exists (
    select 1 from licensing_installation_recoveries
     where installation_id = p_installation_id
       and consumed_at is null
       and expires_at > clock_timestamp()
  ) then
    raise exception 'an active recovery authorization already exists';
  end if;

  insert into licensing_installation_recoveries
    (installation_id, code_digest, reason, actor_id, expires_at)
  values
    (p_installation_id, p_code_digest, left(btrim(p_reason), 500), p_actor_id, p_expires_at)
  returning id into recovery_id;
  recovery_expires_at := p_expires_at;

  update licensing_installations
     set clone_status = 'TRANSFER_PENDING', updated_at = clock_timestamp()
   where id = p_installation_id;

  with ended as (
    update licensing_instance_sessions
       set status = 'ENDED', ended_at = clock_timestamp(), updated_at = clock_timestamp()
     where installation_id = p_installation_id and status = 'ACTIVE'
     returning license_id, installation_id, session_id
  )
  insert into licensing_events
    (license_id, installation_id, event_type, payload, actor, actor_type, actor_id, created_at)
  select license_id, installation_id, 'INSTANCE_SESSION_ENDED',
         jsonb_build_object('session_id', session_id, 'reason', 'vendor_authorized_recovery'),
         'admin', 'ADMIN', p_actor_id, clock_timestamp()
    from ended;

  insert into licensing_events
    (license_id, installation_id, event_type, payload, actor, actor_type, actor_id, created_at)
  values
    (v_installation.license_id, p_installation_id, 'INSTALLATION_RECOVERY_AUTHORIZED',
     jsonb_build_object('reason', left(btrim(p_reason), 500), 'expires_at', p_expires_at),
     'admin', 'ADMIN', p_actor_id, clock_timestamp());
  return next;
end;
$$;

revoke all on function control_plane.end_sessions_for_inactive_installation() from public;
revoke all on function control_plane.end_sessions_for_inactive_license() from public;
revoke all on function control_plane.authorize_installation_recovery(text, text, text, text, timestamptz) from public;
revoke all on control_plane.licensing_instance_sessions from public;
revoke all on control_plane.licensing_attestation_challenges from public;
revoke all on control_plane.licensing_installation_recoveries from public;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on control_plane.licensing_instance_sessions from anon';
    execute 'revoke all on control_plane.licensing_attestation_challenges from anon';
    execute 'revoke all on control_plane.licensing_installation_recoveries from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on control_plane.licensing_instance_sessions from authenticated';
    execute 'revoke all on control_plane.licensing_attestation_challenges from authenticated';
    execute 'revoke all on control_plane.licensing_installation_recoveries from authenticated';
  end if;
  if exists (select 1 from pg_roles where rolname = 'clientix_control_plane') then
    execute 'grant select, insert, update on control_plane.licensing_instance_sessions to clientix_control_plane';
    execute 'grant select, insert, update, delete on control_plane.licensing_attestation_challenges to clientix_control_plane';
    execute 'grant select, insert, update on control_plane.licensing_installation_recoveries to clientix_control_plane';
    execute 'grant execute on function control_plane.end_sessions_for_inactive_installation() to clientix_control_plane';
    execute 'grant execute on function control_plane.end_sessions_for_inactive_license() to clientix_control_plane';
    execute 'grant execute on function control_plane.authorize_installation_recovery(text, text, text, text, timestamptz) to clientix_control_plane';
  end if;
end;
$$;
