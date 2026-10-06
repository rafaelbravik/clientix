-- 0502 — Protocolo de atendimento legível nas demandas e conversas (Etapa 1 Clientix).
--
-- ## O que resolve
-- Cada atendimento (Demanda/Conversa) passa a ter um número de protocolo legível
-- para humanos (ex.: PROT-20261001-0001), facilitando a identificação pelo cliente
-- e pelo atendente, além de permitir busca direta no Inbox e suporte a {{protocolo}}
-- em mensagens automáticas.

create sequence if not exists public.seq_protocolo_atendimento start with 1001;

create or replace function public.fn_gerar_protocolo()
returns text language plpgsql as $$
declare
  v_seq bigint;
  v_date text;
begin
  v_seq := nextval('public.seq_protocolo_atendimento');
  v_date := to_char(clock_timestamp(), 'YYYYMMDD');
  return 'PROT-' || v_date || '-' || lpad(v_seq::text, 4, '0');
end;
$$;

revoke execute on function public.fn_gerar_protocolo() from public, anon;
grant execute on function public.fn_gerar_protocolo() to authenticated, service_role;

-- 1. Colunas nas tabelas principais
alter table public.demandas add column if not exists protocolo text;
create unique index if not exists idx_demandas_protocolo_unique on public.demandas(protocolo) where protocolo is not null;

alter table public.conversations add column if not exists protocolo text;
create index if not exists idx_conversations_protocolo on public.conversations(organization_id, protocolo) where protocolo is not null;

-- 2. Backfill idempotente
update public.demandas set protocolo = public.fn_gerar_protocolo() where protocolo is null;
update public.conversations c
   set protocolo = d.protocolo
  from public.demandas d
 where d.id = c.current_demanda_id
   and c.protocolo is null
   and d.protocolo is not null;

update public.conversations
   set protocolo = public.fn_gerar_protocolo()
 where protocolo is null
   and status not in ('closed', 'archived', 'resolved');

-- 3. Atualização de fn_service_inbound para propagar protocolo
create or replace function public.fn_service_inbound(p_message uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
 m public.messages;
 c public.conversations;
 d public.demandas;
 reopened boolean;
 keep_owner boolean;
 pre_contact uuid;
begin
 select * into m from public.messages where id = p_message;
 if not found or m.direction <> 'inbound' or m.service_revision is not null then return; end if;
 select * into c from public.conversations where id = m.conversation_id;
 if not found or c.organization_id is distinct from m.organization_id
    or c.channel_session_id is distinct from m.channel_session_id
    or not exists(select 1 from public.channel_sessions where id=m.channel_session_id and organization_id=m.organization_id)
 then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 if c.is_group or coalesce(c.group_chat_id,'') like '%@g.us' then return; end if;
 if c.contact_id is distinct from m.contact_id
    or not exists(select 1 from public.contacts where id=m.contact_id and organization_id=m.organization_id)
 then raise exception 'service_scope_mismatch' using errcode='23503'; end if;
 pre_contact:=c.contact_id;
 perform public.fn_service_lock(c.organization_id,c.contact_id);
 select * into c from public.conversations where id=m.conversation_id and organization_id=m.organization_id for no key update;
 if c.contact_id is distinct from pre_contact then raise exception 'service_contact_changed' using errcode='40001'; end if;
 if m.sent_at <= c.service_closed_at then return; end if;
 reopened := c.status in ('closed','resolved','archived');
 keep_owner := reopened and c.assigned_to_user_id is not null
   and coalesce((select o.settings->'routing'->'conversation_stays_with_attendant' = 'true'::jsonb
                   from public.organizations o where o.id = c.organization_id), false)
   and coalesce(public.fn_member_role_in_org(c.assigned_to_user_id,c.organization_id),'none')
     in ('agent','manager','admin');
 if not reopened then
   select x.* into d from public.demandas x join public.demanda_conversas dc on dc.demanda_id=x.id
    where x.id=c.current_demanda_id and x.organization_id=c.organization_id and x.contact_id=c.contact_id
      and dc.organization_id=c.organization_id and dc.conversation_id=c.id
      and dc.service_revision=c.service_revision and x.fechada_em is null;
 end if;
 if d.id is null then
   insert into public.demandas
     (organization_id,contact_id,aberta_em,origem,estado,dono_kind,dono_user_id,proximo_passo,protocolo)
    values(c.organization_id,c.contact_id,m.sent_at,'inbound','aberta',
      case when keep_owner then 'humano' else 'ia' end,
      case when keep_owner then c.assigned_to_user_id else null end,
      'Responder à nova mensagem do cliente',
      public.fn_gerar_protocolo()) returning * into d;
 elsif d.protocolo is null then
   d.protocolo := public.fn_gerar_protocolo();
   update public.demandas set protocolo = d.protocolo where id = d.id;
 end if;
 if reopened then
   update public.conversations set
     status=case when keep_owner then 'claimed' else 'open' end,
     status_changed_at=clock_timestamp(),
     service_revision=service_revision+1,service_started_at=m.sent_at,
     assigned_to_user_id=case when keep_owner then c.assigned_to_user_id else null end,
     assigned_at=case when keep_owner then clock_timestamp() else null end,
     assignee_kind=case when keep_owner then 'user' else null end,
     bot_silenced_until=case when keep_owner then 'infinity'::timestamptz else c.bot_silenced_until end,
     active_ai_agent_id=null,
     current_demanda_id=d.id,
     protocolo=coalesce(d.protocolo, public.fn_gerar_protocolo())
    where id=c.id and organization_id=c.organization_id returning * into c;
 else
   update public.conversations set
     service_revision=service_revision+case when current_demanda_id is not null and current_demanda_id<>d.id then 1 else 0 end,
     service_started_at=case when current_demanda_id is not null and current_demanda_id<>d.id then m.sent_at else coalesce(service_started_at,m.sent_at) end,
     current_demanda_id=d.id,
     protocolo=coalesce(d.protocolo, c.protocolo, public.fn_gerar_protocolo())
    where id=c.id and organization_id=c.organization_id returning * into c;
 end if;
 insert into public.demanda_conversas(organization_id,demanda_id,conversation_id,service_revision)
  values(c.organization_id,d.id,c.id,c.service_revision) on conflict(demanda_id,conversation_id)
  do update set service_revision=excluded.service_revision;
 update public.messages set service_revision=c.service_revision,demanda_id=d.id,demanda_revision=d.revision
  where id=m.id and organization_id=c.organization_id;
end; $$;
revoke execute on function public.fn_service_inbound(uuid) from public,anon,authenticated;
grant execute on function public.fn_service_inbound(uuid) to service_role;
