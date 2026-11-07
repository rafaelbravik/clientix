-- LIC-04 completion: durable, versioned signed license artifacts and renewal outbox.
alter table control_plane.licensing_licenses
  add column if not exists license_revision bigint not null default 1;

do $$ begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'ck_licensing_licenses_revision_positive'
       and conrelid = 'control_plane.licensing_licenses'::regclass
  ) then
    alter table control_plane.licensing_licenses
      add constraint ck_licensing_licenses_revision_positive check (license_revision > 0);
  end if;
end $$;

create table if not exists control_plane.licensing_license_artifacts (
  artifact_id uuid primary key default gen_random_uuid(),
  license_id uuid not null references control_plane.licensing_licenses(id) on delete restrict,
  installation_id text not null references control_plane.licensing_installations(id) on delete restrict,
  license_revision bigint not null check (license_revision > 0),
  key_id text,
  issued_at timestamptz not null,
  expires_at timestamptz not null,
  payload_sha256 text check (payload_sha256 is null or payload_sha256 ~ '^[0-9a-f]{64}$'),
  artifact_sha256 text check (artifact_sha256 is null or artifact_sha256 ~ '^[0-9a-f]{64}$'),
  signed_document jsonb check (signed_document is null or jsonb_typeof(signed_document) = 'object'),
  status text not null default 'PENDING'
    check (status in ('PENDING', 'PROCESSING', 'ISSUED', 'SUPERSEDED')),
  source text not null default 'LICENSE_UPDATE'
    check (source in ('LICENSE_UPDATE', 'ACTIVATION', 'ONLINE_VALIDATION', 'ADMIN_EXPORT')),
  idempotency_key text not null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  next_attempt_at timestamptz not null default now(),
  lease_owner text,
  lease_expires_at timestamptz,
  last_failure_code text,
  created_at timestamptz not null default now(),
  signed_at timestamptz,
  unique (license_id, installation_id, license_revision),
  unique (idempotency_key),
  check (
    (status = 'ISSUED' and key_id is not null and payload_sha256 is not null
      and artifact_sha256 is not null and signed_document is not null and signed_at is not null)
    or status <> 'ISSUED'
  )
);

create index if not exists idx_licensing_artifacts_pending
  on control_plane.licensing_license_artifacts(next_attempt_at, created_at)
  where status in ('PENDING', 'PROCESSING');
create index if not exists idx_licensing_artifacts_installation_revision
  on control_plane.licensing_license_artifacts(license_id, installation_id, license_revision desc);

create or replace function control_plane.bump_signed_license_revision()
returns trigger
language plpgsql
set search_path = control_plane, pg_catalog, pg_temp
as $$
begin
  if row(
    new.serial, new.product, new.deployment, new.plan, new.license_type, new.status,
    new.signing_key_id, new.max_installations, new.max_tenants, new.resale_allowed,
    new.white_label, new.features, new.issued_at, new.valid_from, new.expires_at,
    new.maintenance_until, new.grace_days
  ) is distinct from row(
    old.serial, old.product, old.deployment, old.plan, old.license_type, old.status,
    old.signing_key_id, old.max_installations, old.max_tenants, old.resale_allowed,
    old.white_label, old.features, old.issued_at, old.valid_from, old.expires_at,
    old.maintenance_until, old.grace_days
  ) then
    new.license_revision := old.license_revision + 1;
  else
    new.license_revision := old.license_revision;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_bump_signed_license_revision on control_plane.licensing_licenses;
create trigger trg_bump_signed_license_revision
  before update on control_plane.licensing_licenses
  for each row execute function control_plane.bump_signed_license_revision();

create or replace function control_plane.queue_signed_license_revision()
returns trigger
language plpgsql
set search_path = control_plane, pg_catalog, pg_temp
as $$
begin
  if new.license_revision is distinct from old.license_revision then
    insert into control_plane.licensing_license_artifacts(
      license_id, installation_id, license_revision, key_id, issued_at, expires_at,
      status, source, idempotency_key
    )
    select new.id, i.id, new.license_revision, new.signing_key_id,
           coalesce(new.issued_at, now()), new.expires_at, 'PENDING',
           'LICENSE_UPDATE', 'license:' || new.id::text || ':' || i.id || ':' || new.license_revision::text
      from control_plane.licensing_installations i
     where i.license_id = new.id and i.status = 'ACTIVE'
    on conflict (license_id, installation_id, license_revision) do nothing;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_queue_signed_license_revision on control_plane.licensing_licenses;
create trigger trg_queue_signed_license_revision
  after update on control_plane.licensing_licenses
  for each row execute function control_plane.queue_signed_license_revision();

revoke all on function control_plane.bump_signed_license_revision() from public;
revoke all on function control_plane.queue_signed_license_revision() from public;
revoke all on control_plane.licensing_license_artifacts from public;

do $$ begin
  if exists (select 1 from pg_roles where rolname = 'clientix_control_plane') then
    execute 'grant select, insert, update on control_plane.licensing_license_artifacts to clientix_control_plane';
    execute 'revoke delete, truncate on control_plane.licensing_license_artifacts from clientix_control_plane';
  end if;
end $$;
