-- 0509 · Proteção Atômica de Quota de Assentos de Usuários (SEC-RACE-001)
--
-- Impede race condition no consumo de assentos de usuários (membros ativos + convites pendentes)
-- serializando via advisory lock por organização e validando o teto do plano antes de INSERT/UPDATE.

create or replace function public.fn_check_user_seat_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_settings jsonb;
  v_plan text;
  v_max_users int;
  v_active_members int;
  v_pending_invites int;
  v_total_seats int;
begin
  if (TG_TABLE_NAME = 'team_invites') then
    v_org_id := NEW.organization_id;

    -- Se for UPDATE: só verifica se o convite estiver sendo reativado/desrevogado
    -- (ou seja, revoked_at deixou de ser preenchido enquanto continua pendente de aceite)
    if (TG_OP = 'UPDATE') then
      if not (OLD.revoked_at is not null and NEW.revoked_at is null and NEW.accepted_at is null) then
        return NEW;
      end if;
    else
      -- Se for INSERT mas já nascer aceito ou revogado, não consome assento pendente
      if (NEW.accepted_at is not null or NEW.revoked_at is not null) then
        return NEW;
      end if;
    end if;

  elsif (TG_TABLE_NAME = 'user_organizations') then
    v_org_id := NEW.organization_id;

    -- Se for UPDATE: só verifica se estiver reativando membro revogado
    -- (revoked_at mudou de NOT NULL para NULL)
    if (TG_OP = 'UPDATE') then
      if not (OLD.revoked_at is not null and NEW.revoked_at is null) then
        return NEW;
      end if;
    else
      -- Se for INSERT mas já nascer revogado, não consome assento
      if (NEW.revoked_at is not null) then
        return NEW;
      end if;
    end if;

  else
    return NEW;
  end if;

  -- Serializa inserções e reativações de assentos para a mesma organização contra race conditions.
  -- Namespace 2283 isolado de canal_sessions (2282) e de canais (2281).
  perform pg_advisory_xact_lock(hashtextextended(v_org_id::text, 2283));

  select settings into v_settings
  from public.organizations
  where id = v_org_id;

  if v_settings is not null then
    v_plan := coalesce(v_settings->>'plan', 'standard');

    -- Verifica override explícito em plan_limits
    if v_settings->'plan_limits' ? 'max_users' and v_settings->'plan_limits'->>'max_users' is not null then
      v_max_users := (v_settings->'plan_limits'->>'max_users')::int;
    else
      -- Limite padrão por plano: standard = 3, pro = 10, enterprise = ilimitado (desconhecido/inválido = fallback seguro standard)
      if v_plan = 'pro' then
        v_max_users := 10;
      elsif v_plan = 'enterprise' then
        v_max_users := null;
      else
        v_max_users := 3;
      end if;
    end if;

    if v_max_users is not null then
      -- 1. Conta membros ativos (revoked_at is null)
      select count(*) into v_active_members
      from public.user_organizations
      where organization_id = v_org_id
        and revoked_at is null
        and (TG_TABLE_NAME <> 'user_organizations' or TG_OP = 'INSERT' or id <> NEW.id);

      -- 2. Conta convites pendentes e não expirados
      select count(*) into v_pending_invites
      from public.team_invites
      where organization_id = v_org_id
        and accepted_at is null
        and revoked_at is null
        and expires_at > now()
        and (TG_TABLE_NAME <> 'team_invites' or TG_OP = 'INSERT' or id <> NEW.id);

      v_total_seats := v_active_members + v_pending_invites;

      if v_total_seats >= v_max_users then
        raise exception 'quota_exceeded: limite maximo de usuarios atingido para o plano % (% / %)',
          v_plan, v_total_seats, v_max_users
          using errcode = 'P0003';
      end if;
    end if;
  end if;

  return NEW;
end;
$$;

revoke all on function public.fn_check_user_seat_quota() from public, anon, authenticated;
grant execute on function public.fn_check_user_seat_quota() to service_role;

-- Trigger em team_invites
drop trigger if exists trg_check_user_seat_quota_invites on public.team_invites;
create trigger trg_check_user_seat_quota_invites
  before insert or update of revoked_at, accepted_at on public.team_invites
  for each row
  execute function public.fn_check_user_seat_quota();

-- Trigger em user_organizations
drop trigger if exists trg_check_user_seat_quota_members on public.user_organizations;
create trigger trg_check_user_seat_quota_members
  before insert or update of revoked_at on public.user_organizations
  for each row
  execute function public.fn_check_user_seat_quota();

notify pgrst, 'reload schema';
