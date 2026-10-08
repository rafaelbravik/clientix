-- =====================================================================
-- CLIENTIX VENDOR CONTROL PLANE - INITIAL MIGRATION (0001)
-- SCOPE: CONTROL PLANE CENTRAL - NUNCA EXECUTAR EM CLIENT DATABASE / VPS
-- =====================================================================

-- 1. Criação do namespace isolado
create schema if not exists control_plane;

-- 2. Tabela de controle de versão das migrations do Control Plane
create table if not exists control_plane.schema_migrations (
  version text primary key,
  checksum text not null,
  applied_at timestamptz not null default now()
);

-- 3. Master Signing Keys do Vendor (PÚBLICAS APENAS)
-- Chaves privadas ficam estritamente em KMS/Vault/Secrets, NUNCA no banco
create table if not exists control_plane.licensing_signer_keys (
  key_id text primary key,
  algorithm text not null default 'Ed25519' check (algorithm = 'Ed25519'),
  public_key_pem text not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  retired_at timestamptz
);

-- 4. Clientes comerciais / contratantes
create table if not exists control_plane.licensing_customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  legal_name text,
  billing_email text not null unique,
  country text check (country is null or country ~* '^[A-Z]{2}$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- 5. Licenças emitidas
create table if not exists control_plane.licensing_licenses (
  id uuid primary key default gen_random_uuid(),
  customer_id uuid not null references control_plane.licensing_customers(id) on delete restrict,
  license_type text not null check (license_type in ('internal', 'partner', 'enterprise')),
  status text not null check (status in ('ACTIVE', 'SUSPENDED', 'REVOKED')),
  signing_key_id text not null references control_plane.licensing_signer_keys(key_id) on delete restrict,
  issued_at timestamptz not null default now(),
  valid_from timestamptz not null default now(),
  expires_at timestamptz not null,
  maintenance_until timestamptz,
  grace_days integer not null default 7 check (grace_days >= 0 and grace_days <= 90),
  max_installations integer not null default 1 check (max_installations > 0),
  max_tenants integer check (max_tenants is null or max_tenants > 0),
  resale_allowed boolean not null default false,
  white_label boolean not null default false,
  features text[] not null default array[]::text[],
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_license_valid_range check (valid_from < expires_at)
);

-- 6. Códigos de ativação com digest HMAC-SHA256
-- ON DELETE RESTRICT para evitar hard-delete em cascata
create table if not exists control_plane.licensing_activation_codes (
  id uuid primary key default gen_random_uuid(),
  license_id uuid not null references control_plane.licensing_licenses(id) on delete restrict,
  code_hash text not null unique,
  max_uses integer not null default 1 check (max_uses > 0),
  used_count integer not null default 0,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint ck_activation_code_usage check (used_count >= 0 and used_count <= max_uses)
);

-- 7. Instalações registradas
create table if not exists control_plane.licensing_installations (
  id text primary key,
  license_id uuid not null references control_plane.licensing_licenses(id) on delete restrict,
  public_key text not null,
  public_key_fingerprint text not null unique check (public_key_fingerprint ~* '^[0-9a-f]{64}$'),
  status text not null check (status in ('ACTIVE', 'SUSPENDED', 'REVOKED', 'DEACTIVATED')),
  environment text not null default 'production',
  app_version text,
  last_heartbeat_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ck_canonical_installation_id check (id ~* '^inst_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')
);

-- 8. Nonces de proteção contra replay
create table if not exists control_plane.licensing_nonces (
  installation_id text not null references control_plane.licensing_installations(id) on delete cascade,
  nonce text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  primary key (installation_id, nonce)
);

-- 9. Trilha de auditoria append-only
create table if not exists control_plane.licensing_events (
  id uuid primary key default gen_random_uuid(),
  license_id uuid references control_plane.licensing_licenses(id) on delete set null,
  installation_id text references control_plane.licensing_installations(id) on delete set null,
  event_type text not null,
  payload jsonb not null default '{}'::jsonb,
  actor text not null default 'system',
  created_at timestamptz not null default now()
);

-- 10. Índices operacionais
create index if not exists idx_cp_licenses_customer on control_plane.licensing_licenses(customer_id, status);
create index if not exists idx_cp_installations_license on control_plane.licensing_installations(license_id, status);
create index if not exists idx_cp_installations_fingerprint on control_plane.licensing_installations(public_key_fingerprint);
create index if not exists idx_cp_nonces_expires_at on control_plane.licensing_nonces(expires_at);
create index if not exists idx_cp_events_installation on control_plane.licensing_events(installation_id, created_at desc);
create index if not exists idx_cp_events_type on control_plane.licensing_events(event_type, created_at desc);

-- 11. Função de limpeza de nonces expirados
create or replace function control_plane.prune_expired_nonces(p_now timestamptz default now())
returns integer
language plpgsql
security definer
set search_path = control_plane, pg_catalog, pg_temp
as $$
declare
  v_count integer;
begin
  delete from control_plane.licensing_nonces
  where expires_at <= p_now;
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 12. Blindagem de privilégios públicos
revoke all on schema control_plane from public;
revoke all on all tables in schema control_plane from public;
revoke all on all sequences in schema control_plane from public;
revoke all on all functions in schema control_plane from public;

-- Revoga explicitamente de anon e authenticated caso existam no banco
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema control_plane from anon';
    execute 'revoke all on all tables in schema control_plane from anon';
    execute 'revoke all on all sequences in schema control_plane from anon';
    execute 'revoke all on all functions in schema control_plane from anon';
  end if;
  if exists (select 1 from pg_roles where rolname = 'authenticated') then
    execute 'revoke all on schema control_plane from authenticated';
    execute 'revoke all on all tables in schema control_plane from authenticated';
    execute 'revoke all on all sequences in schema control_plane from authenticated';
    execute 'revoke all on all functions in schema control_plane from authenticated';
  end if;
end;
$$;

-- 13. Concessão de privilégios mínimos ao role de runtime se ele já existir
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'clientix_control_plane') then
    execute 'grant usage on schema control_plane to clientix_control_plane';
    execute 'grant select on control_plane.licensing_signer_keys to clientix_control_plane';
    execute 'grant select, insert, update on control_plane.licensing_customers to clientix_control_plane';
    execute 'grant select, insert, update on control_plane.licensing_licenses to clientix_control_plane';
    execute 'grant select, insert, update on control_plane.licensing_activation_codes to clientix_control_plane';
    execute 'grant select, insert, update on control_plane.licensing_installations to clientix_control_plane';
    execute 'grant select, insert, delete on control_plane.licensing_nonces to clientix_control_plane';
    execute 'grant select, insert on control_plane.licensing_events to clientix_control_plane';
    execute 'grant execute on function control_plane.prune_expired_nonces(timestamptz) to clientix_control_plane';

    -- Imutabilidade estrita garantida: revoke UPDATE e DELETE em licensing_events
    execute 'revoke update, delete on control_plane.licensing_events from clientix_control_plane';
  end if;
end;
$$;
