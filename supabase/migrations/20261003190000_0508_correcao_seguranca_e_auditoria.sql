-- Remediação SEC-001 da auditoria técnica (2026-10-03):
-- Revoga EXECUTE de authenticated em public.fn_resolve_inbound_number(text)
-- e fixa search_path = ''. Apenas service_role pode executar.

create or replace function public.fn_resolve_inbound_number(p_number text)
returns table (
  organization_id uuid,
  routing_mode text,
  default_ai_agent_id uuid,
  fallback_user_id uuid
)
language sql
security definer
stable
set search_path = ''
as $$
  select organization_id, routing_mode, default_ai_agent_id, fallback_user_id
  from public.phone_numbers
  where number = p_number and is_active
  limit 1;
$$;

revoke execute on function public.fn_resolve_inbound_number(text) from public, anon, authenticated;
grant execute on function public.fn_resolve_inbound_number(text) to service_role;

-- Remediação WEB-001 da auditoria técnica (2026-10-03):
-- Bloqueia leitura de webhook_path_token e segredos criptografados por authenticated/anon via PostgREST.
-- Apenas service_role (usado pelos route handlers administrativos do servidor) tem acesso aos segredos.
revoke select on public.channel_sessions from authenticated, anon;
grant select (
  id, organization_id, waha_session_name, engine, status, status_reason,
  phone_number, display_name, last_health_check_at, last_status_change_at,
  consecutive_health_fails, daily_message_limit, warmup_started_at, warmup_completed_at,
  is_warmup_complete, metadata, created_at, updated_at, created_by, provider,
  meta_phone_number_id, meta_waba_id, zernio_account_id, wacalls_session_id,
  wacalls_jid, wacalls_paired_at, datafy_phone_number_id, datafy_waba_id,
  archived_at, meta_webhook_override_uri, meta_webhook_override_erro, meta_webhook_override_em,
  telegram_bot_id, telegram_bot_username, email_address, instagram_account_id,
  instagram_username, tiktok_business_id, tiktok_username, telegram_user_id,
  telegram_phone, telegram_api_id
) on public.channel_sessions to authenticated;

-- Remediação DB-001 e PROD-UPDATE da auditoria técnica (2026-10-03):
-- Garante que a FK de channel_session_id valide o mesmo tenant via (organization_id, channel_session_id)
-- e aplica as políticas restritivas de suporte para a tabela instagram_comment_rules.
alter table public.instagram_comment_rules
  drop constraint if exists instagram_comment_rules_channel_session_id_fkey;

alter table public.instagram_comment_rules
  drop constraint if exists instagram_comment_rules_session_org_fk;

alter table public.instagram_comment_rules
  add constraint instagram_comment_rules_session_org_fk
  foreign key (organization_id, channel_session_id)
  references public.channel_sessions(organization_id, id)
  on delete cascade;

-- Remediação PLAN-001 da auditoria técnica (2026-10-03):
-- Trigger que previne race conditions em conexões concorrentes simultâneas de canais
-- e reativações de canais arquivados via UPDATE.
-- Executa com lock advisory na organização garantindo serialização estrita no Postgres.
create or replace function public.fn_check_channel_session_quota()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_settings jsonb;
  v_plan text;
  v_max_channels int;
  v_current_channels int;
begin
  -- Se for UPDATE: só verifica se estiver reativando canal arquivado (archived_at mudou de NOT NULL para NULL)
  if (TG_OP = 'UPDATE') then
    if not (OLD.archived_at is not null and NEW.archived_at is null) then
      return NEW;
    end if;
  else
    -- Se for INSERT mas já nascer arquivado, não consome quota ativa
    if (NEW.archived_at is not null) then
      return NEW;
    end if;
  end if;

  -- Serializa inserções e reativações de canais para a mesma organização contra race condition
  perform pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text, 2282));

  select settings into v_settings
  from public.organizations
  where id = NEW.organization_id;

  if v_settings is not null then
    v_plan := coalesce(v_settings->>'plan', 'standard');
    
    -- Verifica override explícito em plan_limits
    if v_settings->'plan_limits' ? 'max_channels' and v_settings->'plan_limits'->>'max_channels' is not null then
      v_max_channels := (v_settings->'plan_limits'->>'max_channels')::int;
    else
      -- Limite padrão por plano: standard = 1, pro = 5, enterprise = ilimitado (desconhecido/inválido = fallback seguro standard)
      if v_plan = 'pro' then
        v_max_channels := 5;
      elsif v_plan = 'enterprise' then
        v_max_channels := null;
      else
        v_max_channels := 1;
      end if;
    end if;

    if v_max_channels is not null then
      -- Conta canais ativos, desconsiderando a linha atual em caso de UPDATE
      select count(*) into v_current_channels
      from public.channel_sessions
      where organization_id = NEW.organization_id
        and archived_at is null
        and (TG_OP = 'INSERT' or id <> NEW.id);

      if v_current_channels >= v_max_channels then
        raise exception 'quota_exceeded: limite maximo de canais atingido para o plano % (% / %)',
          v_plan, v_current_channels, v_max_channels
          using errcode = 'P0003';
      end if;
    end if;
  end if;

  return NEW;
end;
$$;

revoke all on function public.fn_check_channel_session_quota() from public, anon, authenticated;
grant execute on function public.fn_check_channel_session_quota() to service_role;

drop trigger if exists trg_check_channel_session_quota on public.channel_sessions;
create trigger trg_check_channel_session_quota
  before insert or update of archived_at on public.channel_sessions
  for each row
  execute function public.fn_check_channel_session_quota();

notify pgrst, 'reload schema';
