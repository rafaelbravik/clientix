-- 0510 · Proteção Atômica Contra Sobreposição Parcial na Agenda (CAL-001)
--
-- Impede sobreposição parcial ou total de horários de agendamentos (double booking)
-- para o mesmo atendente (owner_user_id) na mesma organização.
-- Serializa via advisory lock por atendente (owner_user_id) na organização e valida:
--   tstzrange(starts_at, ends_at, '[)') && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
-- Apenas para agendamentos ativos (status in ('pending', 'confirmed')).
-- Agendamentos com status 'cancelled', 'no_show' ou 'completed' liberam o horário.

create or replace function public.fn_check_appointment_overlap()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_conflito_id uuid;
begin
  -- Se o agendamento não possui atendente responsável (owner_user_id null), não ocupa agenda de pessoa
  if NEW.owner_user_id is null then
    return NEW;
  end if;

  -- Se o agendamento não estiver nos estados ativos que ocupam agenda ('pending', 'confirmed'), libera
  if NEW.status not in ('pending', 'confirmed') then
    return NEW;
  end if;

  -- Se ends_at <= starts_at, rejeita imediatamente
  if NEW.ends_at <= NEW.starts_at then
    raise exception 'periodo_invalido: ends_at deve ser estritamente posterior a starts_at'
      using errcode = '22023';
  end if;

  -- Se for UPDATE que não alterou starts_at, ends_at, status e owner_user_id, não precisa revalidar
  if (TG_OP = 'UPDATE') then
    if (OLD.starts_at = NEW.starts_at
        and OLD.ends_at = NEW.ends_at
        and OLD.status = NEW.status
        and OLD.owner_user_id = NEW.owner_user_id) then
      return NEW;
    end if;
  end if;

  -- Serializa inserções e atualizações para o mesmo atendente na organização.
  -- Namespace 2284 isolado de assentos (2283), sessões de canal (2282) e canais (2281).
  perform pg_advisory_xact_lock(hashtextextended(NEW.organization_id::text || ':' || NEW.owner_user_id::text, 2284));

  -- Busca se já existe agendamento ativo com sobreposição de intervalo [starts_at, ends_at)
  select id into v_conflito_id
  from public.calendar_appointments
  where organization_id = NEW.organization_id
    and owner_user_id = NEW.owner_user_id
    and status in ('pending', 'confirmed')
    and (TG_OP = 'INSERT' or id <> NEW.id)
    and tstzrange(starts_at, ends_at, '[)') && tstzrange(NEW.starts_at, NEW.ends_at, '[)')
  limit 1;

  if v_conflito_id is not null then
    raise exception 'agenda_horario_indisponivel: horario sobreposto com outro agendamento ativo (%)',
      v_conflito_id
      using errcode = '23P01';
  end if;

  return NEW;
end;
$$;

revoke all on function public.fn_check_appointment_overlap() from public, anon, authenticated;
grant execute on function public.fn_check_appointment_overlap() to service_role;

drop trigger if exists trg_check_appointment_overlap on public.calendar_appointments;
create trigger trg_check_appointment_overlap
  before insert or update of starts_at, ends_at, status, owner_user_id on public.calendar_appointments
  for each row
  execute function public.fn_check_appointment_overlap();

notify pgrst, 'reload schema';
