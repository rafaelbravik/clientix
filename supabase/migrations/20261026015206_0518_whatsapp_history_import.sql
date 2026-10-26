-- 0518 — importação server-side do histórico WhatsApp, isolada do inbound ao vivo.
-- O marcador é persistido em messages.metadata e os observers de INSERT o ignoram.

create table if not exists public.whatsapp_history_imports (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  channel_session_id uuid not null references public.channel_sessions(id) on delete restrict,
  status text not null default 'pending'
    check (status in ('pending','running','completed','failed','cancelled')),
  range_days smallint not null check (range_days in (30,90,180,365)),
  range_start timestamptz not null,
  cursor jsonb not null default '{"chat_offset":0}'::jsonb,
  imported_count integer not null default 0 check (imported_count >= 0),
  skipped_count integer not null default 0 check (skipped_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  last_error_code text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  lease_token uuid,
  lease_expires_at timestamptz,
  next_attempt_at timestamptz default now(),
  attempts integer not null default 0 check (attempts >= 0),
  foreign key (organization_id, channel_session_id)
    references public.channel_sessions (organization_id, id) on delete restrict,
  unique (organization_id, id)
);

create unique index if not exists whatsapp_history_one_active_per_session
  on public.whatsapp_history_imports (organization_id, channel_session_id)
  where status in ('pending','running');
create index if not exists whatsapp_history_imports_claimable
  on public.whatsapp_history_imports (status, lease_expires_at, created_at);

alter table public.whatsapp_history_imports enable row level security;
alter table public.whatsapp_history_imports force row level security;
revoke all on public.whatsapp_history_imports from public, anon, authenticated;
grant all on public.whatsapp_history_imports to service_role;

-- Hashes keyed with a random database secret preserve the ability to refuse a
-- historical re-import after LGPD redaction without retaining phone/LID values.
create table if not exists private.whatsapp_history_suppression_key (
  singleton boolean primary key default true check (singleton),
  secret bytea not null check (octet_length(secret) >= 32)
);
revoke all on private.whatsapp_history_suppression_key from public, anon, authenticated, service_role;
insert into private.whatsapp_history_suppression_key (singleton, secret)
values (true, extensions.gen_random_bytes(32))
on conflict (singleton) do nothing;

create table if not exists public.whatsapp_history_suppressed_identities (
  organization_id uuid not null references public.organizations(id) on delete cascade,
  identity_digest bytea not null check (octet_length(identity_digest) = 32),
  created_at timestamptz not null default now(),
  primary key (organization_id, identity_digest)
);
alter table public.whatsapp_history_suppressed_identities enable row level security;
alter table public.whatsapp_history_suppressed_identities force row level security;
revoke all on public.whatsapp_history_suppressed_identities from public, anon, authenticated;
grant all on public.whatsapp_history_suppressed_identities to service_role;

create table if not exists public.whatsapp_history_import_blocks (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  reason_code text not null check (reason_code in ('legacy_identity_unrecoverable','suppression_key_unavailable')),
  created_at timestamptz not null default now()
);
alter table public.whatsapp_history_import_blocks enable row level security;
alter table public.whatsapp_history_import_blocks force row level security;
revoke all on public.whatsapp_history_import_blocks from public, anon, authenticated;
grant all on public.whatsapp_history_import_blocks to service_role;

create or replace function private.fn_whatsapp_history_digest(p_value text)
returns bytea language plpgsql security definer
set search_path = pg_catalog, private, extensions as $$
declare v_key bytea;
begin
  if p_value is null or length(p_value) = 0 or length(p_value) > 300 then return null; end if;
  select secret into v_key from private.whatsapp_history_suppression_key where singleton = true;
  if v_key is null then raise exception 'history_suppression_key_unavailable'; end if;
  return extensions.hmac(convert_to(lower(btrim(p_value)), 'UTF8'), v_key, 'sha256');
end; $$;
revoke all on function private.fn_whatsapp_history_digest(text) from public, anon, authenticated, service_role;

create or replace function private.fn_whatsapp_history_store_identity(p_org uuid, p_identity text)
returns void language plpgsql security definer
set search_path = pg_catalog, public, private as $$
declare v_digest bytea;
begin
  if p_identity is null or btrim(p_identity) = '' then return; end if;
  v_digest := private.fn_whatsapp_history_digest(p_identity);
  insert into public.whatsapp_history_suppressed_identities (organization_id, identity_digest)
  values (p_org, v_digest) on conflict do nothing;
end; $$;
revoke all on function private.fn_whatsapp_history_store_identity(uuid,text) from public, anon, authenticated, service_role;

create or replace function private.fn_whatsapp_history_capture_redaction()
returns trigger language plpgsql security definer
set search_path = pg_catalog, public, private, extensions as $$
declare
  v_identity text;
  v_chat text;
  v_digits text;
  v_phone text;
  v_contact_has_identity boolean := false;
begin
  if coalesce(old.is_anonymized, false) or not coalesce(new.is_anonymized, false) then return new; end if;

  begin
    -- Serializa o tombstone com a criação/importação de contatos na mesma org.
    -- O import usa o mesmo lock antes de checar a supressão e resolver contato.
    perform pg_advisory_xact_lock(hashtextextended(old.organization_id::text, 51808));
    if old.phone_number is not null then
      v_digits := regexp_replace(old.phone_number, '\D', '', 'g');
      if length(v_digits) >= 8 then
        perform private.fn_whatsapp_history_store_identity(old.organization_id, 'phone:' || v_digits);
        v_contact_has_identity := true;
        if v_digits ~ '^55[1-9][0-9][6-9][0-9]{7}$' then
          v_phone := '55' || substring(v_digits from 3 for 2) || '9' || substring(v_digits from 5);
          perform private.fn_whatsapp_history_store_identity(old.organization_id, 'phone:' || v_phone);
        elsif v_digits ~ '^55[1-9][0-9]9[6-9][0-9]{7}$' then
          v_phone := '55' || substring(v_digits from 3 for 2) || substring(v_digits from 6);
          perform private.fn_whatsapp_history_store_identity(old.organization_id, 'phone:' || v_phone);
        end if;
      end if;
    end if;

    v_identity := nullif(regexp_replace(coalesce(old.wa_lid, old.source_metadata->>'waha_lid', ''), '@.*$', ''), '');
    if v_identity ~ '^[a-zA-Z0-9.-]{1,100}$' then
      perform private.fn_whatsapp_history_store_identity(old.organization_id, 'lid:' || v_identity);
      perform private.fn_whatsapp_history_store_identity(old.organization_id, 'chat:' || v_identity || '@lid');
      v_contact_has_identity := true;
    end if;
    v_chat := nullif(old.source_metadata->>'waha_chat_id', '');
    if v_chat ~ '^\+?[0-9]{8,15}@(c\.us|s\.whatsapp\.net)$' then
      perform private.fn_whatsapp_history_store_identity(old.organization_id, 'chat:' || v_chat);
      v_digits := regexp_replace(split_part(v_chat, '@', 1), '\D', '', 'g');
      perform private.fn_whatsapp_history_store_identity(old.organization_id, 'phone:' || v_digits);
      v_contact_has_identity := true;
    elsif v_chat ~ '^[a-zA-Z0-9.-]{1,100}@lid$' then
      perform private.fn_whatsapp_history_store_identity(old.organization_id, 'chat:' || v_chat);
      perform private.fn_whatsapp_history_store_identity(old.organization_id, 'lid:' || split_part(v_chat, '@', 1));
      v_contact_has_identity := true;
    end if;

    for v_chat in
      select distinct split_part(m.external_id, '_', 2)
        from public.messages m
        join public.conversations c on c.organization_id = m.organization_id and c.id = m.conversation_id
       where c.organization_id = old.organization_id and c.contact_id = old.id
         and m.external_id ~ '^(true|false)_[^_]+@(c\.us|s\.whatsapp\.net|lid)_[^_]+$'
    loop
      if v_chat ~ '^\+?[0-9]{8,15}@(c\.us|s\.whatsapp\.net)$' then
        perform private.fn_whatsapp_history_store_identity(old.organization_id, 'chat:' || v_chat);
        v_digits := regexp_replace(split_part(v_chat, '@', 1), '\D', '', 'g');
        perform private.fn_whatsapp_history_store_identity(old.organization_id, 'phone:' || v_digits);
        v_contact_has_identity := true;
      elsif v_chat ~ '^[a-zA-Z0-9.-]{1,100}@lid$' then
        perform private.fn_whatsapp_history_store_identity(old.organization_id, 'chat:' || v_chat);
        perform private.fn_whatsapp_history_store_identity(old.organization_id, 'lid:' || split_part(v_chat, '@', 1));
        v_contact_has_identity := true;
      end if;
    end loop;

    -- Previous anonymization erased the direct address. In that org we cannot
    -- prove a future chat is not the redacted person, so imports fail closed.
    if old.source = 'whatsapp' and not v_contact_has_identity then
      insert into public.whatsapp_history_import_blocks (organization_id, reason_code)
      values (old.organization_id, 'legacy_identity_unrecoverable') on conflict (organization_id) do nothing;
    end if;
  exception when others then
    insert into public.whatsapp_history_import_blocks (organization_id, reason_code)
    values (old.organization_id, 'suppression_key_unavailable') on conflict (organization_id) do nothing;
  end;
  return new;
end; $$;
revoke all on function private.fn_whatsapp_history_capture_redaction() from public, anon, authenticated, service_role;
drop trigger if exists trg_contacts_capture_history_suppression on public.contacts;
create trigger trg_contacts_capture_history_suppression
  before update of is_anonymized on public.contacts
  for each row when (new.is_anonymized is true and old.is_anonymized is distinct from true)
  execute function private.fn_whatsapp_history_capture_redaction();

-- Backfill identifiers that survived older redaction. Contacts without any
-- recoverable WhatsApp identifier block imports for that org, instead of being
-- recreated silently from provider history.
do $$
declare r record; v_chat text; v_digits text; v_has_identity boolean;
begin
  for r in select id, organization_id, wa_lid, source_metadata
             from public.contacts where is_anonymized = true and source = 'whatsapp'
  loop
    v_has_identity := false;
    if regexp_replace(coalesce(r.wa_lid, r.source_metadata->>'waha_lid', ''), '@.*$', '') ~ '^[a-zA-Z0-9.-]{1,100}$' then
      perform private.fn_whatsapp_history_store_identity(r.organization_id, 'lid:' || regexp_replace(coalesce(r.wa_lid, r.source_metadata->>'waha_lid'), '@.*$', ''));
      perform private.fn_whatsapp_history_store_identity(r.organization_id, 'chat:' || regexp_replace(coalesce(r.wa_lid, r.source_metadata->>'waha_lid'), '@.*$', '') || '@lid');
      v_has_identity := true;
    end if;
    v_chat := nullif(r.source_metadata->>'waha_chat_id', '');
    if v_chat ~ '^\+?[0-9]{8,15}@(c\.us|s\.whatsapp\.net)$' then
      perform private.fn_whatsapp_history_store_identity(r.organization_id, 'chat:' || v_chat);
      v_digits := regexp_replace(split_part(v_chat, '@', 1), '\D', '', 'g');
      perform private.fn_whatsapp_history_store_identity(r.organization_id, 'phone:' || v_digits);
      v_has_identity := true;
    elsif v_chat ~ '^[a-zA-Z0-9.-]{1,100}@lid$' then
      perform private.fn_whatsapp_history_store_identity(r.organization_id, 'chat:' || v_chat);
      perform private.fn_whatsapp_history_store_identity(r.organization_id, 'lid:' || split_part(v_chat, '@', 1));
      v_has_identity := true;
    end if;
    for v_chat in
      select distinct split_part(m.external_id, '_', 2)
        from public.messages m
        join public.conversations c on c.organization_id=m.organization_id and c.id=m.conversation_id
       where c.organization_id=r.organization_id and c.contact_id=r.id
         and m.external_id ~ '^(true|false)_[^_]+@(c\.us|s\.whatsapp\.net|lid)_[^_]+$'
    loop
      if v_chat ~ '^\+?[0-9]{8,15}@(c\.us|s\.whatsapp\.net)$' then
        perform private.fn_whatsapp_history_store_identity(r.organization_id, 'chat:' || v_chat);
        v_digits := regexp_replace(split_part(v_chat, '@', 1), '\D', '', 'g');
        perform private.fn_whatsapp_history_store_identity(r.organization_id, 'phone:' || v_digits);
        v_has_identity := true;
      elsif v_chat ~ '^[a-zA-Z0-9.-]{1,100}@lid$' then
        perform private.fn_whatsapp_history_store_identity(r.organization_id, 'chat:' || v_chat);
        perform private.fn_whatsapp_history_store_identity(r.organization_id, 'lid:' || split_part(v_chat, '@', 1));
        v_has_identity := true;
      end if;
    end loop;
    if not v_has_identity then
      insert into public.whatsapp_history_import_blocks (organization_id, reason_code)
      values (r.organization_id, 'legacy_identity_unrecoverable') on conflict (organization_id) do nothing;
    end if;
  end loop;
end; $$;

create or replace function public.fn_whatsapp_history_check_suppression(p_org uuid, p_identities text[])
returns text language plpgsql security definer set search_path=public,private as $$
declare v_identity text; v_digest bytea;
begin
  if exists (select 1 from public.whatsapp_history_import_blocks where organization_id=p_org) then
    return 'legacy_import_blocked';
  end if;
  begin
    foreach v_identity in array coalesce(p_identities, '{}'::text[]) loop
      v_digest := private.fn_whatsapp_history_digest(v_identity);
      if v_digest is not null and exists (
        select 1 from public.whatsapp_history_suppressed_identities
         where organization_id=p_org and identity_digest=v_digest
      ) then return 'identity_suppressed'; end if;
    end loop;
  exception when others then return 'suppression_key_unavailable'; end;
  return 'allowed';
end; $$;
revoke all on function public.fn_whatsapp_history_check_suppression(uuid,text[]) from public,anon,authenticated;
grant execute on function public.fn_whatsapp_history_check_suppression(uuid,text[]) to service_role;

-- A verificação de tombstone e a resolução do contato acontecem na mesma
-- transação. Depois da resolução, travamos a linha e recusamos contato já
-- anonimizado/fundido antes que uma importação possa recriá-lo.
create or replace function public.fn_whatsapp_history_upsert_contact(
  p_import uuid, p_lease uuid, p_kind text, p_phone text, p_lid text,
  p_chat_id text, p_identities text[]
) returns uuid language plpgsql security definer set search_path=public as $$
declare j public.whatsapp_history_imports; v_contact uuid; v_block text; v_anonymized boolean; v_merged uuid;
begin
  select * into j from public.whatsapp_history_imports where id=p_import for share;
  if not found or j.status <> 'running' or j.lease_token is distinct from p_lease or j.lease_expires_at <= clock_timestamp() then
    raise exception 'history_import_lease_lost' using errcode='40001';
  end if;
  if p_kind not in ('phone','lid') or (p_kind='phone' and coalesce(p_phone,'')='') or (p_kind='lid' and coalesce(p_lid,'')='') then
    raise exception 'history_identity_invalid' using errcode='22023';
  end if;
  if not exists (select 1 from public.channel_sessions s where s.id=j.channel_session_id and s.organization_id=j.organization_id and s.provider='waha') then
    raise exception 'history_scope_mismatch' using errcode='23503';
  end if;
  v_block := public.fn_whatsapp_history_check_suppression(j.organization_id,p_identities);
  if v_block <> 'allowed' then raise exception 'history_identity_suppressed' using errcode='42501'; end if;
  v_contact := public.fn_upsert_wa_contact(j.organization_id,p_kind,p_phone,p_lid,p_chat_id,null);
  if v_contact is null then raise exception 'history_contact_resolution_failed' using errcode='23503'; end if;
  select c.is_anonymized,c.is_merged_into into v_anonymized,v_merged
    from public.contacts c where c.organization_id=j.organization_id and c.id=v_contact for update;
  if not found or coalesce(v_anonymized,true) or v_merged is not null then
    raise exception 'history_identity_suppressed' using errcode='42501';
  end if;
  return v_contact;
end; $$;
revoke all on function public.fn_whatsapp_history_upsert_contact(uuid,uuid,text,text,text,text,text[]) from public,anon,authenticated;
grant execute on function public.fn_whatsapp_history_upsert_contact(uuid,uuid,text,text,text,text,text[]) to service_role;

create or replace function public.fn_whatsapp_history_claim(p_lease_seconds integer default 120)
returns setof public.whatsapp_history_imports language plpgsql security definer set search_path=public as $$
declare v_id uuid; v_lease uuid := gen_random_uuid();
begin
  select id into v_id from public.whatsapp_history_imports
   where (status='pending' and next_attempt_at <= clock_timestamp())
      or (status='running' and (lease_expires_at is null or lease_expires_at < clock_timestamp()))
   order by created_at, id for update skip locked limit 1;
  if v_id is null then return; end if;
  return query update public.whatsapp_history_imports
    set status='running', lease_token=v_lease,
        lease_expires_at=clock_timestamp()+make_interval(secs=>greatest(30,least(coalesce(p_lease_seconds,120),300))),
        started_at=coalesce(started_at,clock_timestamp()), updated_at=clock_timestamp()
    where id=v_id and ((status='pending' and next_attempt_at <= clock_timestamp())
      or (status='running' and (lease_expires_at is null or lease_expires_at < clock_timestamp())))
    returning *;
end; $$;
revoke all on function public.fn_whatsapp_history_claim(integer) from public,anon,authenticated;
grant execute on function public.fn_whatsapp_history_claim(integer) to service_role;

create or replace function public.fn_whatsapp_history_insert_message(
  p_import uuid, p_lease uuid, p_contact uuid, p_conversation uuid,
  p_external_id text, p_type text, p_direction text, p_status text,
  p_body text, p_media_url text, p_media_mime text, p_sent_at timestamptz,
  p_metadata jsonb default '{}'::jsonb
) returns table(message_id uuid, was_inserted boolean) language plpgsql security definer set search_path=public as $$
declare j public.whatsapp_history_imports; v_id uuid;
begin
  select * into j from public.whatsapp_history_imports where id=p_import for share;
  if not found or j.status <> 'running' or j.lease_token is distinct from p_lease or j.lease_expires_at <= clock_timestamp() then
    raise exception 'history_import_lease_lost' using errcode='40001';
  end if;
  if p_external_id is null or length(p_external_id) not between 1 and 512
     or p_direction not in ('inbound','outbound')
     or p_type not in ('text','image','video','audio','document','sticker','location','contact','reaction','system')
     or p_sent_at is null then
    raise exception 'history_message_invalid' using errcode='22023';
  end if;
  if not exists (
    select 1 from public.channel_sessions s
      join public.conversations c on c.organization_id=s.organization_id and c.channel_session_id=s.id
      join public.contacts p on p.organization_id=s.organization_id and p.id=p_contact
     where s.organization_id=j.organization_id and s.id=j.channel_session_id
       and c.id=p_conversation and c.contact_id=p_contact and c.is_group=false
       and p.is_anonymized=false and p.is_merged_into is null
  ) then raise exception 'history_scope_mismatch' using errcode='23503'; end if;
  -- A constraint é DEFERRABLE no schema legado. Forçamos a checagem dentro da
  -- função para que o caminho de dedupe reconheça uma mensagem já recebida ao vivo.
  set constraints messages_org_external_id_unique immediate;
  begin
    insert into public.messages (
      organization_id, conversation_id, channel_session_id, contact_id, external_id,
      type, direction, status, body, media_url, media_mime, sent_via, sent_at, delivered_at, metadata
    ) values (
      j.organization_id, p_conversation, j.channel_session_id, p_contact, p_external_id,
      p_type, p_direction, case when p_direction='inbound' then 'delivered' else coalesce(p_status,'sent') end,
      p_body, p_media_url, p_media_mime, 'external_device', p_sent_at, null,
      coalesce(p_metadata,'{}'::jsonb) || jsonb_build_object('historico_importado','true','importacao_id',j.id)
    ) returning id into v_id;
    update public.whatsapp_history_imports set imported_count=imported_count+1,updated_at=clock_timestamp()
      where id=j.id and status='running' and lease_token=p_lease;
    if not found then raise exception 'history_import_lease_lost' using errcode='40001'; end if;
    return query select v_id,true;
  exception when unique_violation then
    select m.id into v_id from public.messages m
      where m.organization_id=j.organization_id and m.external_id=p_external_id
        and m.channel_session_id=j.channel_session_id and m.conversation_id=p_conversation and m.contact_id=p_contact;
    if v_id is not null then return query select v_id,false; return; end if;
    raise exception 'history_external_identity_mismatch' using errcode='23505';
  end;
end; $$;
revoke all on function public.fn_whatsapp_history_insert_message(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,timestamptz,jsonb) from public,anon,authenticated;
grant execute on function public.fn_whatsapp_history_insert_message(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,timestamptz,jsonb) to service_role;

-- Se a entrega ao vivo vencer a corrida de unicidade, o inbound normal já criou
-- a linha e seus eventos. Se o histórico vencer, esta função converte essa
-- mesma linha quando o webhook legítimo chegar: a mutação e o evento live são
-- atômicos, e uma reentrega posterior não volta a gerar message.received.
create or replace function public.fn_whatsapp_history_accept_live_duplicate(
  p_org uuid, p_session uuid, p_contact uuid, p_conversation uuid, p_external_id text
) returns boolean language plpgsql security definer set search_path=public as $$
declare m public.messages;
begin
  if p_org is null or p_session is null or p_contact is null or p_conversation is null
     or p_external_id is null or length(p_external_id) not between 1 and 512 then
    return false;
  end if;
  select * into m from public.messages
   where organization_id=p_org and channel_session_id=p_session and contact_id=p_contact
     and conversation_id=p_conversation and external_id=p_external_id and direction='inbound'
   for update;
  if not found or (m.metadata->>'historico_importado' is distinct from 'true'
      and m.metadata->>'importacao_id' is null) then
    return false;
  end if;
  perform public.fn_service_lock(p_org,p_contact);
  update public.messages set metadata=(coalesce(metadata,'{}'::jsonb)-'historico_importado'-'importacao_id')
    || jsonb_build_object('historico_convertido_ao_vivo',true)
   where id=m.id;
  perform public.fn_service_inbound(m.id);
  update public.conversations set reply_context_revision=reply_context_revision+1
   where organization_id=p_org and id=p_conversation and contact_id=p_contact;
  perform public.emit_event(
    'message.received','message',m.id,
    jsonb_build_object('message_id',m.id,'conversation_id',p_conversation,'contact_id',p_contact,
      'direction','inbound','channel_session_id',p_session),
    jsonb_build_object('source','waha_live_collision_recovered'),p_org
  );
  return true;
end; $$;
revoke all on function public.fn_whatsapp_history_accept_live_duplicate(uuid,uuid,uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.fn_whatsapp_history_accept_live_duplicate(uuid,uuid,uuid,uuid,text) to service_role;

-- Cria a âncora da timeline FECHADA, sem o evento de roteamento de conversa
-- nova. Uma conversa existente (possivelmente ativa) nunca tem seu estado ou
-- agregados alterados por uma importação histórica.
create or replace function public.fn_whatsapp_history_upsert_conversation(
  p_import uuid, p_lease uuid, p_contact uuid, p_last_message_at timestamptz,
  p_preview text
) returns table (conversation_id uuid, was_created boolean)
language plpgsql security definer set search_path=public as $$
declare j public.whatsapp_history_imports; v_id uuid; v_created boolean := false;
begin
  select * into j from public.whatsapp_history_imports where id=p_import for share;
  if not found or j.status <> 'running' or j.lease_token is distinct from p_lease or j.lease_expires_at <= clock_timestamp() then
    raise exception 'history_import_lease_lost' using errcode='40001';
  end if;
  if not exists (
    select 1 from public.channel_sessions s
      join public.contacts c on c.organization_id=s.organization_id and c.id=p_contact
     where s.organization_id=j.organization_id and s.id=j.channel_session_id
       and c.is_anonymized=false and c.is_merged_into is null
  ) then raise exception 'history_scope_mismatch' using errcode='23503'; end if;
  insert into public.conversations (
    organization_id, contact_id, channel_session_id, channel, status,
    is_group, unread_count_for_assignee, metadata,
    last_message_at, last_message_preview
  ) values (
    j.organization_id, p_contact, j.channel_session_id, 'whatsapp', 'closed',
    false, 0, '{}'::jsonb, p_last_message_at, left(coalesce(p_preview,''),280)
  ) on conflict (organization_id, contact_id, channel_session_id) where is_group=false
    do nothing returning id into v_id;
  if v_id is not null then
    v_created := true;
  else
    select c.id into v_id from public.conversations c
     where c.organization_id=j.organization_id and c.contact_id=p_contact
       and c.channel_session_id=j.channel_session_id and c.is_group=false;
  end if;
  if v_id is null then raise exception 'history_conversation_missing' using errcode='23503'; end if;
  return query select v_id, v_created;
end; $$;
revoke all on function public.fn_whatsapp_history_upsert_conversation(uuid,uuid,uuid,timestamptz,text) from public,anon,authenticated;
grant execute on function public.fn_whatsapp_history_upsert_conversation(uuid,uuid,uuid,timestamptz,text) to service_role;

-- Uma conversa inteira é validada em memória e então persistida numa só
-- transação. Cancelamento/lease expirado não pode deixar identidade validada
-- pela metade na timeline. A chamada também registra apenas MEDIA_PERSIST.
create or replace function public.fn_whatsapp_history_persist_conversation(
  p_import uuid, p_lease uuid, p_kind text, p_phone text, p_lid text,
  p_chat_id text, p_identities text[], p_messages jsonb
) returns jsonb language plpgsql security definer set search_path=public as $$
declare
  j public.whatsapp_history_imports;
  v_contact uuid;
  v_conversation uuid;
  v_last timestamptz;
  v_preview text;
  v_message jsonb;
  v_message_id uuid;
  v_inserted boolean;
  v_ids jsonb := '[]'::jsonb;
  v_media_ids jsonb := '[]'::jsonb;
  v_count integer := 0;
  v_suppression text;
begin
  select * into j from public.whatsapp_history_imports where id=p_import for share;
  if not found or j.status <> 'running' or j.lease_token is distinct from p_lease or j.lease_expires_at <= clock_timestamp() then
    raise exception 'history_import_lease_lost' using errcode='40001';
  end if;
  if jsonb_typeof(p_messages) <> 'array' or jsonb_array_length(p_messages) not between 1 and 300 then
    raise exception 'history_conversation_size_invalid' using errcode='22023';
  end if;
  -- Um lock curto por organização fecha a janela entre verificar o tombstone e
  -- criar/associar contato. A trigger LGPD usa o mesmo lock antes de gravar os
  -- HMACs; não há recriação silenciosa durante uma solicitação concorrente.
  perform pg_advisory_xact_lock(hashtextextended(j.organization_id::text, 51808));
  v_suppression := public.fn_whatsapp_history_check_suppression(j.organization_id,p_identities);
  if v_suppression <> 'allowed' then
    return jsonb_build_object('skipped',true,'reason_code',v_suppression);
  end if;
  select max((item->>'sent_at')::timestamptz) into v_last from jsonb_array_elements(p_messages) item;
  select left(coalesce(item->>'body',''),280) into v_preview
    from jsonb_array_elements(p_messages) item order by (item->>'sent_at')::timestamptz desc limit 1;
  v_contact := public.fn_whatsapp_history_upsert_contact(p_import,p_lease,p_kind,p_phone,p_lid,p_chat_id,p_identities);
  select h.conversation_id into v_conversation
    from public.fn_whatsapp_history_upsert_conversation(p_import,p_lease,v_contact,v_last,v_preview) h;
  for v_message in select value from jsonb_array_elements(p_messages) loop
    select h.message_id,h.was_inserted into v_message_id,v_inserted
      from public.fn_whatsapp_history_insert_message(
        p_import,p_lease,v_contact,v_conversation,
        v_message->>'external_id',v_message->>'type',v_message->>'direction',v_message->>'status',
        v_message->>'body',v_message->>'media_url',v_message->>'media_mime',
        (v_message->>'sent_at')::timestamptz,coalesce(v_message->'metadata','{}'::jsonb)
      ) h;
    if v_inserted then
      v_count := v_count+1;
      v_ids := v_ids || jsonb_build_array(v_message_id);
      if nullif(v_message->>'media_url','') is not null then
        v_media_ids := v_media_ids || jsonb_build_array(v_message_id);
        perform public.emit_event(
          'media.persist_requested','message',v_message_id,
          jsonb_build_object('message_id',v_message_id,'conversation_id',v_conversation),
          jsonb_build_object('source','whatsapp_history'),j.organization_id
        );
      end if;
    end if;
  end loop;
  return jsonb_build_object(
    'contact_id',v_contact,'conversation_id',v_conversation,
    'inserted_count',v_count,'message_ids',v_ids,'media_message_ids',v_media_ids
  );
end; $$;
revoke all on function public.fn_whatsapp_history_persist_conversation(uuid,uuid,text,text,text,text,text[],jsonb) from public,anon,authenticated;
grant execute on function public.fn_whatsapp_history_persist_conversation(uuid,uuid,text,text,text,text,text[],jsonb) to service_role;

create or replace function public.fn_whatsapp_history_checkpoint(
  p_import uuid, p_lease uuid, p_cursor jsonb, p_imported integer,
  p_skipped integer, p_failed integer, p_status text, p_error_code text default null
) returns public.whatsapp_history_imports language plpgsql security definer set search_path=public as $$
declare j public.whatsapp_history_imports;
begin
  if p_status not in ('pending','completed','failed') then raise exception 'history_checkpoint_status_invalid' using errcode='22023'; end if;
  update public.whatsapp_history_imports set
    cursor=coalesce(p_cursor,cursor),
    imported_count=imported_count+greatest(coalesce(p_imported,0),0),
    skipped_count=skipped_count+greatest(coalesce(p_skipped,0),0),
    failed_count=failed_count+greatest(coalesce(p_failed,0),0),
    status=p_status,
    attempts=case when p_error_code is not null then attempts+1 else 0 end,
    next_attempt_at=case
      when p_status='pending' and p_error_code is not null
        then clock_timestamp()+make_interval(secs=>least(1800,30*(2^greatest(attempts,0))::integer))
      when p_status='pending' then clock_timestamp()
      else null end,
    last_error_code=case when p_error_code ~ '^[a-z0-9_]{1,80}$' then p_error_code else null end,
    finished_at=case when p_status in ('completed','failed') then clock_timestamp() else null end,
    lease_token=null, lease_expires_at=null, updated_at=clock_timestamp()
   where id=p_import and status='running' and lease_token=p_lease
   returning * into j;
  if not found then raise exception 'history_import_lease_lost' using errcode='40001'; end if;
  return j;
end; $$;
revoke all on function public.fn_whatsapp_history_checkpoint(uuid,uuid,jsonb,integer,integer,integer,text,text) from public,anon,authenticated;
grant execute on function public.fn_whatsapp_history_checkpoint(uuid,uuid,jsonb,integer,integer,integer,text,text) to service_role;

-- A history insert is durable state, but it is never a live inbound event.
create or replace function public.fn_demanda_abre_no_inbound()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.metadata->>'historico_importado' = 'true' then return new; end if;
  perform public.fn_service_inbound(new.id);
  return new;
end; $$;
revoke execute on function public.fn_demanda_abre_no_inbound() from public,anon,authenticated;

create or replace function public.fn_message_service_lock()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.metadata->>'historico_importado' = 'true' then return new; end if;
  if new.direction='inbound' and new.contact_id is not null then perform public.fn_service_lock(new.organization_id,new.contact_id); end if;
  return new;
end; $$;
revoke execute on function public.fn_message_service_lock() from public,anon,authenticated;

create or replace function public.fn_reply_inbound_revision()
returns trigger language plpgsql security definer set search_path=public as $$
begin
  if new.metadata->>'historico_importado' is distinct from 'true' and new.direction='inbound' then
    update public.conversations set reply_context_revision=reply_context_revision+1
     where organization_id=new.organization_id and id=new.conversation_id and contact_id=new.contact_id;
  end if;
  return new;
end; $$;
revoke all on function public.fn_reply_inbound_revision() from public,anon,authenticated;

create or replace function public.fn_emit_message_event()
returns trigger language plpgsql set search_path=public,pg_temp as $$
declare v_event text;
begin
  if new.metadata->>'historico_importado' = 'true' then return new; end if;
  if new.direction='inbound' then
    if exists(select 1 from public.conversations c where c.id=new.conversation_id and c.organization_id=new.organization_id and c.is_group) then
      v_event := 'message.group_received';
    else v_event := 'message.received'; end if;
  else
    v_event := case new.status when 'sending' then 'message.sending' when 'sent' then 'message.sent' when 'failed' then 'message.failed' else 'message.outbound' end;
  end if;
  perform public.fn_log_event(new.organization_id,v_event,jsonb_build_object(
    'message_id',new.id,'conversation_id',new.conversation_id,'contact_id',new.contact_id,
    'direction',new.direction,'type',new.type,'status',new.status,'external_id',new.external_id,
    'channel_session_id',new.channel_session_id,'body_preview',left(new.body,280)));
  return new;
end; $$;

comment on table public.whatsapp_history_imports is
  'Jobs server-only de importação WhatsApp. Cursor e leases nunca são enviados à UI.';
comment on table public.whatsapp_history_suppressed_identities is
  'HMACs de identificadores de contatos anonimizados; sem telefone/LID em claro.';
comment on function public.fn_whatsapp_history_insert_message(uuid,uuid,uuid,uuid,text,text,text,text,text,text,text,timestamptz,jsonb) is
  'Insere mensagem histórica sob lease válido e grava o marcador persistente que impede efeitos de inbound ao vivo.';
comment on function public.fn_whatsapp_history_upsert_conversation(uuid,uuid,uuid,timestamptz,text) is
  'Cria conversa histórica fechada sem roteamento; nunca altera conversa preexistente.';
comment on function public.fn_whatsapp_history_persist_conversation(uuid,uuid,text,text,text,text,text[],jsonb) is
  'Persiste atomicamente uma conversa histórica já validada; emite somente pedidos de persistência de mídia.';
