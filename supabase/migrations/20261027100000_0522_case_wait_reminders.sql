-- 0522 — relógio e cadência por espera humana de caso.
--
-- 0521 está reservado por outra linha de desenvolvimento do repositório
-- (`20261002201500_0521_avisos_do_security_advisor.sql`). Este identificador
-- fica livre entre refs e evita colisão em instalações que unam as linhas.
--
-- O relógio é por entrada em `awaiting_human`, não por idade do caso nem por
-- `updated_at`. `followup_attempts` continua sendo a métrica histórica; a nova
-- coluna limita a cadência dentro da espera atual.

alter table public.agent_cases
  add column if not exists case_wait_started_at timestamptz,
  add column if not exists case_wait_reminders_sent smallint not null default 0;

-- Estado antigo já em espera não recebe rajada após a atualização. O total
-- legado é preservado em `followup_attempts`; o contador por espera herda até
-- três avisos conhecidos. Como a cadência antiga não é reconstruível, o relógio
-- reinicia na migration para evitar catch-up imediato usando uma nova cadência.
do $$
declare
  v_backfill_at timestamptz := clock_timestamp();
begin
  update public.agent_cases c
     set case_wait_reminders_sent = least(greatest(coalesce(c.followup_attempts, 0), 0), 3)::smallint,
         case_wait_started_at = v_backfill_at
   where c.status = 'awaiting_human'
     and c.case_wait_started_at is null;
end
$$;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.agent_cases'::regclass
       and conname = 'agent_cases_case_wait_reminders_sent_check'
  ) then
    alter table public.agent_cases
      add constraint agent_cases_case_wait_reminders_sent_check
      check (case_wait_reminders_sent between 0 and 10);
  end if;

  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.agent_cases'::regclass
       and conname = 'agent_cases_case_wait_clock_status_check'
  ) then
    alter table public.agent_cases
      add constraint agent_cases_case_wait_clock_status_check
      check (
        (status = 'awaiting_human') = (case_wait_started_at is not null)
        and (case_wait_started_at is not null or case_wait_reminders_sent = 0)
      );
  end if;
end
$$;

create or replace function public.fn_track_case_wait_clock()
returns trigger
language plpgsql
set search_path to 'public', 'pg_temp'
as $$
begin
  if tg_op = 'INSERT' then
    if new.status = 'awaiting_human' then
      new.case_wait_started_at := clock_timestamp();
      new.case_wait_reminders_sent := 0;
    else
      new.case_wait_started_at := null;
      new.case_wait_reminders_sent := 0;
    end if;
  elsif new.status is distinct from old.status then
    if new.status = 'awaiting_human' then
      new.case_wait_started_at := clock_timestamp();
      new.case_wait_reminders_sent := 0;
    else
      new.case_wait_started_at := null;
      new.case_wait_reminders_sent := 0;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_agent_case_wait_clock on public.agent_cases;
create trigger trg_agent_case_wait_clock
  before insert or update on public.agent_cases
  for each row execute function public.fn_track_case_wait_clock();

revoke execute on function public.fn_track_case_wait_clock()
  from public, anon, authenticated;

-- Atualização parcial e atômica do JSON de settings; o objeto inteiro não sai
-- do banco e outras configurações da organização não podem ser sobrescritas.
create or replace function public.fn_definir_case_wait_reminder_config(
  p_org uuid,
  p_actor uuid,
  p_enabled boolean,
  p_interval_hours integer,
  p_reminder_limit integer
) returns integer
language plpgsql
volatile
security definer
set search_path to 'public', 'pg_temp'
as $$
declare
  v_linhas integer;
begin
  if p_org is null or p_actor is null or p_enabled is null
     or p_interval_hours is null or p_reminder_limit is null
     or p_interval_hours not between 1 and 168
     or p_reminder_limit not between 1 and 10 then
    raise exception 'case_wait_reminder_config_invalid'
      using errcode = '22023';
  end if;

  if not exists (
       select 1 from public.user_organizations uo
        where uo.user_id = p_actor
          and uo.organization_id = p_org
          and uo.role = 'admin'
          and uo.revoked_at is null
     )
     and not exists (
       select 1 from public.platform_admins pa
        where pa.user_id = p_actor
          and pa.revoked_at is null
     ) then
    raise exception 'case_wait_reminder_config_forbidden'
      using errcode = '42501';
  end if;

  update public.organizations o
     set settings = jsonb_set(
       coalesce(o.settings, '{}'::jsonb),
       '{case_wait_reminders}',
       jsonb_build_object(
         'enabled', p_enabled,
         'interval_hours', p_interval_hours,
         'limit', p_reminder_limit
       ),
       true
     )
   where o.id = p_org;

  get diagnostics v_linhas = row_count;
  return v_linhas;
end;
$$;

comment on function public.fn_definir_case_wait_reminder_config(uuid, uuid, boolean, integer, integer) is
  'Atualiza atomicamente a cadência de avisos por espera humana. Admin da organização ou admin de plataforma; chamado pela Server Action autorizada.';

revoke execute on function public.fn_definir_case_wait_reminder_config(uuid, uuid, boolean, integer, integer)
  from public, anon, authenticated;
grant execute on function public.fn_definir_case_wait_reminder_config(uuid, uuid, boolean, integer, integer)
  to service_role;

-- O lock da linha do caso é o claim: duas rodadas concorrentes não avançam o
-- contador da mesma espera. A função não mexe em updated_at, não emite evento e
-- não envia outbound; apenas abre um aviso na Central.
create or replace function public.fn_claim_case_wait_reminders(p_limit integer default 200)
returns table (examinados integer, avisados integer, ja_avisados integer)
language plpgsql
volatile
security invoker
set search_path to 'public', 'pg_temp'
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_case record;
  v_examinados integer := 0;
  v_avisados integer := 0;
  v_ja_avisados integer := 0;
  v_nova_tentativa smallint;
  v_horas integer;
begin
  for v_case in
    select c.id,
           c.organization_id,
           c.title,
           c.case_wait_started_at,
           c.case_wait_reminders_sent,
           cfg.interval_hours,
           cfg.reminder_limit
      from public.agent_cases c
      join public.organizations o on o.id = c.organization_id
      cross join lateral (
        select
          case when o.settings #>> '{case_wait_reminders,enabled}' = 'false'
            then false else true end as enabled,
          case
            when coalesce(o.settings #>> '{case_wait_reminders,interval_hours}', '') ~ '^[0-9]{1,3}$'
              then case
                when (o.settings #>> '{case_wait_reminders,interval_hours}')::integer between 1 and 168
                  then (o.settings #>> '{case_wait_reminders,interval_hours}')::smallint
                else 24::smallint
              end
            else 24::smallint
          end as interval_hours,
          case
            when coalesce(o.settings #>> '{case_wait_reminders,limit}', '') ~ '^[0-9]{1,2}$'
              then case
                when (o.settings #>> '{case_wait_reminders,limit}')::integer between 1 and 10
                  then (o.settings #>> '{case_wait_reminders,limit}')::smallint
                else 3::smallint
              end
            else 3::smallint
          end as reminder_limit
      ) cfg
     where c.status = 'awaiting_human'
       and c.case_wait_started_at is not null
       and cfg.enabled
       and c.case_wait_reminders_sent < cfg.reminder_limit
       and c.case_wait_started_at
           + ((c.case_wait_reminders_sent + 1) * cfg.interval_hours) * interval '1 hour' <= v_now
     order by c.case_wait_started_at, c.id
     for update of c skip locked
     limit least(greatest(coalesce(p_limit, 200), 1), 200)
  loop
    v_examinados := v_examinados + 1;

    if exists (
      select 1
        from public.agent_inbox_items i
       where i.organization_id = v_case.organization_id
         and i.kind = 'case_stale'
         and i.ref_kind = 'agent_case'
         and i.ref_id = v_case.id
         and i.status = 'open'
    ) then
      v_ja_avisados := v_ja_avisados + 1;
      continue;
    end if;

    v_nova_tentativa := (v_case.case_wait_reminders_sent + 1)::smallint;
    v_horas := greatest(1, floor(extract(epoch from (v_now - v_case.case_wait_started_at)) / 3600)::integer);

    update public.agent_cases c
       set case_wait_reminders_sent = v_nova_tentativa,
           followup_attempts = least(c.followup_attempts + 1, 32767)::smallint
     where c.id = v_case.id
       and c.organization_id = v_case.organization_id
       and c.status = 'awaiting_human'
       and c.case_wait_started_at = v_case.case_wait_started_at
       and c.case_wait_reminders_sent = v_case.case_wait_reminders_sent;

    if not found then
      continue;
    end if;

    insert into public.agent_inbox_items (
      organization_id, kind, severity, title, body, ref_kind, ref_id
    ) values (
      v_case.organization_id,
      'case_stale',
      'warn',
      'Um atendimento espera decisão há ' || v_horas || case when v_horas = 1 then ' hora' else ' horas' end,
      '"' || replace(v_case.title, '"', '""') || '" está aguardando alguém da equipe desde a última entrada na espera humana. Abra o caso e diga o que fazer — concluir, pedir informação ao cliente ou passar para uma pessoa.'
        || case when v_nova_tentativa >= v_case.reminder_limit then ' Este é o último aviso automático desta espera.' else '' end,
      'agent_case',
      v_case.id
    );

    v_avisados := v_avisados + 1;
  end loop;

  return query select v_examinados, v_avisados, v_ja_avisados;
end;
$$;

comment on function public.fn_claim_case_wait_reminders(integer) is
  'Claim concorrente de avisos vencidos por espera humana. Somente service_role; abre Central, preserva followup_attempts histórico e não toca updated_at.';

revoke execute on function public.fn_claim_case_wait_reminders(integer)
  from public, anon, authenticated;
grant execute on function public.fn_claim_case_wait_reminders(integer)
  to service_role;

notify pgrst, 'reload schema';
