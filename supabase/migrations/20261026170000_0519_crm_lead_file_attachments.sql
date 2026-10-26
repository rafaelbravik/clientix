-- 0519 — campos personalizados de arquivo em negócios do CRM.
--
-- Os objetos usam o bucket privado `internal-media`, mas um prefixo próprio
-- (`{org}/lead-attachments/{lead}/{attachment}.{ext}`) que não entra na poda
-- de notas/conversas. Leitura de bytes acontece pela API autenticada; nem o
-- storage_path nem uma URL assinada são entregues ao cliente.
--
-- A metadata row só nasce depois do upload e o trigger recompõe o caminho a
-- partir de IDs confiáveis, valida o objeto existente, lê o tipo/multiplicidade
-- da definição vigente do pipeline e serializa o limite por campo.

create unique index if not exists crm_leads_organization_id_id_key
  on public.crm_leads (organization_id, id);

create table if not exists public.crm_lead_attachments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  lead_id uuid not null,
  custom_field_key text not null check (custom_field_key ~ '^[A-Za-z][A-Za-z0-9_]{0,39}$'),
  storage_bucket text not null default 'internal-media' check (storage_bucket = 'internal-media'),
  storage_path text not null,
  original_filename text not null,
  safe_filename text not null,
  mime_type text not null check (mime_type in ('application/pdf', 'image/png', 'image/jpeg', 'image/webp')),
  size_bytes bigint not null check (size_bytes between 1 and 5242880),
  multiple boolean not null default false,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint crm_lead_attachments_lead_org_fkey
    foreign key (organization_id, lead_id)
    references public.crm_leads (organization_id, id) on delete cascade,
  constraint crm_lead_attachments_path_matches_owner check (
    storage_path = organization_id::text || '/lead-attachments/' || lead_id::text || '/' ||
      id::text || case mime_type
        when 'application/pdf' then '.pdf'
        when 'image/png' then '.png'
        when 'image/jpeg' then '.jpg'
        when 'image/webp' then '.webp'
      end
  )
);

comment on table public.crm_lead_attachments is
  'Metadados de anexos privados de campos file do CRM; os blobs vivem em internal-media.';
comment on column public.crm_lead_attachments.storage_path is
  'Caminho interno tenant/lead/attachment scoped; nunca exposto em respostas HTTP.';
comment on column public.crm_lead_attachments.multiple is
  'Snapshot da configuração do campo no momento do upload; limita concorrência de single-file.';

create index if not exists crm_lead_attachments_org_lead_field_created_idx
  on public.crm_lead_attachments (organization_id, lead_id, custom_field_key, created_at desc);
create unique index if not exists crm_lead_attachments_single_field_unique
  on public.crm_lead_attachments (organization_id, lead_id, custom_field_key)
  where not multiple;
create unique index if not exists crm_lead_attachments_bucket_path_unique
  on public.crm_lead_attachments (storage_bucket, storage_path);

alter table public.crm_lead_attachments enable row level security;
alter table public.crm_lead_attachments force row level security;
revoke all on public.crm_lead_attachments from public, anon, authenticated, service_role;
grant select (id, organization_id, lead_id, custom_field_key,
  safe_filename, mime_type, size_bytes, created_at)
  on public.crm_lead_attachments to authenticated;
grant select, insert, delete on public.crm_lead_attachments to service_role;

drop policy if exists crm_lead_attachments_select on public.crm_lead_attachments;
create policy crm_lead_attachments_select on public.crm_lead_attachments
  for select to authenticated
  using (
    organization_id in (select public.fn_user_org_ids())
    and exists (
      select 1 from public.crm_leads l
       where l.id = crm_lead_attachments.lead_id
         and l.organization_id = crm_lead_attachments.organization_id
         and public.fn_can_view_lead(l.organization_id, l.owner_user_id)
    )
  );

create or replace function public.fn_prepare_crm_lead_attachment()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings jsonb;
  v_fields jsonb;
  v_field jsonb;
  v_owner uuid;
  v_multiple boolean := false;
  v_count integer;
  v_extension text;
  v_name text;
begin
  select p.settings, l.owner_user_id
    into v_settings, v_owner
    from public.crm_leads l
    join public.crm_pipelines p
      on p.id = l.pipeline_id and p.organization_id = l.organization_id
   where l.id = new.lead_id and l.organization_id = new.organization_id;
  if not found then
    raise exception using errcode = '23503', constraint = 'crm_lead_attachments_lead_org_fkey',
      message = 'lead_attachment_lead_not_found';
  end if;

  if auth.uid() is not null and (
    not public.fn_role_at_least(new.organization_id, 'agent')
    or not public.fn_support_write_allowed(new.organization_id)
    or not public.fn_can_view_lead(new.organization_id, v_owner)
  ) then
    raise exception using errcode = '42501', message = 'lead_attachment_forbidden';
  end if;

  v_fields := case when jsonb_typeof(v_settings->'fields') = 'array'
    then v_settings->'fields' else '[]'::jsonb end;
  select f.value into v_field
    from jsonb_array_elements(v_fields) as f(value)
   where f.value->>'key' = new.custom_field_key
     and f.value->>'type' = 'file'
   limit 1;
  if v_field is null then
    raise exception using errcode = '23514', constraint = 'crm_lead_attachment_file_field',
      message = 'lead_attachment_field_not_file';
  end if;

  v_multiple := case when jsonb_typeof(v_field->'multiple') = 'boolean'
    then (v_field->>'multiple')::boolean else false end;
  new.multiple := v_multiple;
  new.storage_bucket := 'internal-media';
  new.created_by := coalesce(auth.uid(), new.created_by);
  new.created_at := coalesce(new.created_at, now());

  v_name := left(coalesce(new.original_filename, 'arquivo'), 255);
  v_name := replace(replace(replace(replace(v_name, chr(13), '_'), chr(10), '_'), '/', '_'), chr(92), '_');
  v_name := regexp_replace(v_name, '[[:cntrl:]]', '_', 'g');
  new.original_filename := v_name;
  new.safe_filename := left(v_name, 180);

  v_extension := case new.mime_type
    when 'application/pdf' then '.pdf'
    when 'image/png' then '.png'
    when 'image/jpeg' then '.jpg'
    when 'image/webp' then '.webp'
    else null
  end;
  if v_extension is null or new.size_bytes < 1 or new.size_bytes > 5242880 then
    raise exception using errcode = '23514', constraint = 'crm_lead_attachments_file_contract',
      message = 'lead_attachment_file_contract_invalid';
  end if;

  new.storage_path := new.organization_id::text || '/lead-attachments/' || new.lead_id::text || '/' ||
    new.id::text || v_extension;
  if not exists (
    select 1 from storage.objects o
     where o.bucket_id = 'internal-media' and o.name = new.storage_path
       and o.created_at > now() - interval '1 day'
  ) then
    raise exception using errcode = '23514', constraint = 'crm_lead_attachment_storage_object',
      message = 'lead_attachment_storage_object_missing';
  end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(new.organization_id::text || ':' || new.lead_id::text || ':' || new.custom_field_key, 519)
  );
  select count(*) into v_count
    from public.crm_lead_attachments a
   where a.organization_id = new.organization_id
     and a.lead_id = new.lead_id
     and a.custom_field_key = new.custom_field_key;
  if v_count >= 10 or (not v_multiple and v_count > 0) then
    raise exception using errcode = '23514', constraint = 'crm_lead_attachment_field_limit',
      message = 'lead_attachment_field_limit_reached';
  end if;

  return new;
end;
$$;
revoke all on function public.fn_prepare_crm_lead_attachment() from public, anon, authenticated, service_role;
drop trigger if exists trg_prepare_crm_lead_attachment on public.crm_lead_attachments;
create trigger trg_prepare_crm_lead_attachment
  before insert on public.crm_lead_attachments
  for each row execute function public.fn_prepare_crm_lead_attachment();

create or replace function public.fn_delete_crm_lead_attachment(
  p_organization_id uuid,
  p_lead_id uuid,
  p_attachment_id uuid
) returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_path text;
  v_bucket text;
  v_field_key text;
  v_owner uuid;
  v_stage uuid;
  v_settings jsonb;
  v_is_won boolean;
  v_is_lost boolean;
  v_required boolean := false;
  v_count integer;
begin
  if auth.uid() is null
     or not public.fn_role_at_least(p_organization_id, 'agent')
     or not public.fn_support_write_allowed(p_organization_id) then
    raise exception using errcode = '42501', message = 'lead_attachment_forbidden';
  end if;
  select owner_user_id into v_owner
    from public.crm_leads
   where id = p_lead_id and organization_id = p_organization_id;
  if not found or not public.fn_can_view_lead(p_organization_id, v_owner) then
    raise exception using errcode = '42501', message = 'lead_attachment_forbidden';
  end if;

  select custom_field_key into v_field_key
    from public.crm_lead_attachments
   where id = p_attachment_id
     and lead_id = p_lead_id
     and organization_id = p_organization_id
  ;
  if not found then return false; end if;

  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_organization_id::text || ':' || p_lead_id::text || ':' || v_field_key, 519)
  );

  select storage_bucket, storage_path into v_bucket, v_path
    from public.crm_lead_attachments
   where id = p_attachment_id
     and lead_id = p_lead_id
     and organization_id = p_organization_id
   for update;
  if not found then return false; end if;

  select l.stage_id, p.settings, s.is_won, s.is_lost
    into v_stage, v_settings, v_is_won, v_is_lost
    from public.crm_leads l
    join public.crm_pipelines p on p.id = l.pipeline_id and p.organization_id = l.organization_id
    join public.crm_stages s on s.id = l.stage_id and s.pipeline_id = l.pipeline_id
   where l.id = p_lead_id and l.organization_id = p_organization_id;
  if found then
    v_required := exists (
      select 1 from jsonb_array_elements(
        case when jsonb_typeof(v_settings->'fields') = 'array'
          then v_settings->'fields' else '[]'::jsonb end
      ) as f(value)
      where f.value->>'key' = v_field_key
        and f.value->>'type' = 'file'
        and (
          exists (
            select 1 from jsonb_array_elements_text(
              case when jsonb_typeof(f.value->'obrigatorio_em'->'etapas') = 'array'
                then f.value->'obrigatorio_em'->'etapas' else '[]'::jsonb end
            ) as etapa(stage_id)
            where etapa.stage_id = v_stage::text
          )
          or (v_is_won and f.value->'obrigatorio_em'->'ao_ganhar' = 'true'::jsonb)
          or (v_is_lost and f.value->'obrigatorio_em'->'ao_perder' = 'true'::jsonb)
        )
    );
  end if;
  if v_required then
    select count(*) into v_count
      from public.crm_lead_attachments a
     where a.organization_id = p_organization_id
       and a.lead_id = p_lead_id
       and a.custom_field_key = v_field_key;
    if v_count <= 1 then
      raise exception using errcode = '23514',
        constraint = 'crm_lead_file_attachment_required',
        message = 'required_file_attachment_missing';
    end if;
  end if;

  insert into public.storage_redaction_queue (organization_id, bucket, object_path)
  values (p_organization_id, v_bucket, v_path)
  on conflict (bucket, object_path) do update
    set status = 'pending', attempts = 0, enqueued_at = now(),
        processed_at = null, error_message = null
    where public.storage_redaction_queue.status in ('deleted', 'skipped');

  delete from public.crm_lead_attachments
   where id = p_attachment_id
     and lead_id = p_lead_id
     and organization_id = p_organization_id;
  return true;
end;
$$;
revoke all on function public.fn_delete_crm_lead_attachment(uuid, uuid, uuid) from public, anon, authenticated, service_role;
grant execute on function public.fn_delete_crm_lead_attachment(uuid, uuid, uuid) to authenticated;

create or replace function public.fn_queue_crm_lead_attachments_for_contact()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lead_ids uuid[];
begin
  if new.is_anonymized is distinct from true or old.is_anonymized is true then
    return new;
  end if;

  select coalesce(array_agg(distinct l.id), '{}'::uuid[]) into v_lead_ids
    from public.crm_leads l
   where l.organization_id = new.organization_id
     and (l.contact_id = new.id or l.id in (
       select x.lead_id from public.crm_lead_links x
        where x.organization_id = new.organization_id
          and x.target_kind = 'contact' and x.target_id = new.id
     ));
  if cardinality(v_lead_ids) = 0 then return new; end if;

  insert into public.storage_redaction_queue (organization_id, bucket, object_path)
  select a.organization_id, a.storage_bucket, a.storage_path
    from public.crm_lead_attachments a
   where a.organization_id = new.organization_id and a.lead_id = any(v_lead_ids)
  on conflict (bucket, object_path) do update
    set status = 'pending', attempts = 0, enqueued_at = now(),
        processed_at = null, error_message = null
    where public.storage_redaction_queue.status in ('deleted', 'skipped');

  delete from public.crm_lead_attachments a
   where a.organization_id = new.organization_id and a.lead_id = any(v_lead_ids);
  return new;
end;
$$;
revoke all on function public.fn_queue_crm_lead_attachments_for_contact() from public, anon, authenticated, service_role;
drop trigger if exists trg_queue_crm_lead_attachments_for_contact on public.contacts;
create trigger trg_queue_crm_lead_attachments_for_contact
  before update of is_anonymized on public.contacts
  for each row execute function public.fn_queue_crm_lead_attachments_for_contact();

create or replace function public.fn_queue_crm_lead_attachments_for_contact_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_lead_ids uuid[];
begin
  select coalesce(array_agg(distinct l.id), '{}'::uuid[]) into v_lead_ids
    from public.crm_leads l
   where l.organization_id = old.organization_id
     and (l.contact_id = old.id or l.id in (
       select x.lead_id from public.crm_lead_links x
        where x.organization_id = old.organization_id
          and x.target_kind = 'contact' and x.target_id = old.id
     ));
  if cardinality(v_lead_ids) = 0 then return old; end if;

  insert into public.storage_redaction_queue (organization_id, bucket, object_path)
  select a.organization_id, a.storage_bucket, a.storage_path
    from public.crm_lead_attachments a
   where a.organization_id = old.organization_id and a.lead_id = any(v_lead_ids)
  on conflict (bucket, object_path) do update
    set status = 'pending', attempts = 0, enqueued_at = now(),
        processed_at = null, error_message = null
    where public.storage_redaction_queue.status in ('deleted', 'skipped');

  delete from public.crm_lead_attachments a
   where a.organization_id = old.organization_id and a.lead_id = any(v_lead_ids);
  return old;
end;
$$;
revoke all on function public.fn_queue_crm_lead_attachments_for_contact_delete() from public, anon, authenticated, service_role;
drop trigger if exists trg_queue_crm_lead_attachments_for_contact_delete on public.contacts;
create trigger trg_queue_crm_lead_attachments_for_contact_delete
  before delete on public.contacts
  for each row execute function public.fn_queue_crm_lead_attachments_for_contact_delete();

create or replace function public.fn_queue_crm_lead_attachments_for_delete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.storage_redaction_queue (organization_id, bucket, object_path)
  select old.organization_id, a.storage_bucket, a.storage_path
    from public.crm_lead_attachments a
   where a.organization_id = old.organization_id and a.lead_id = old.id
  on conflict (bucket, object_path) do update
    set status = 'pending', attempts = 0, enqueued_at = now(),
        processed_at = null, error_message = null
    where public.storage_redaction_queue.status in ('deleted', 'skipped');
  return old;
end;
$$;
revoke all on function public.fn_queue_crm_lead_attachments_for_delete() from public, anon, authenticated, service_role;
drop trigger if exists trg_queue_crm_lead_attachments_for_delete on public.crm_leads;
create trigger trg_queue_crm_lead_attachments_for_delete
  before delete on public.crm_leads
  for each row execute function public.fn_queue_crm_lead_attachments_for_delete();

create or replace function public.fn_require_crm_lead_file_attachments_on_stage_change()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_settings jsonb;
  v_fields jsonb;
  v_field jsonb;
  v_stage_is_won boolean := false;
  v_stage_is_lost boolean := false;
begin
  if new.stage_id is not distinct from old.stage_id then return new; end if;
  select p.settings, s.is_won, s.is_lost into v_settings, v_stage_is_won, v_stage_is_lost
    from public.crm_pipelines p
    join public.crm_stages s on s.id = new.stage_id and s.pipeline_id = p.id
   where p.id = new.pipeline_id and p.organization_id = new.organization_id;
  v_fields := case when jsonb_typeof(v_settings->'fields') = 'array'
    then v_settings->'fields' else '[]'::jsonb end;

  for v_field in
    select f.value from jsonb_array_elements(v_fields) as f(value)
     where f.value->>'type' = 'file'
       and (
         exists (
         select 1 from jsonb_array_elements_text(
           case when jsonb_typeof(f.value->'obrigatorio_em'->'etapas') = 'array'
             then f.value->'obrigatorio_em'->'etapas' else '[]'::jsonb end
         ) e(stage_id)
          where e.stage_id = new.stage_id::text
         )
         or (v_stage_is_won and f.value->'obrigatorio_em'->'ao_ganhar' = 'true'::jsonb)
         or (v_stage_is_lost and f.value->'obrigatorio_em'->'ao_perder' = 'true'::jsonb)
       )
  loop
    perform pg_catalog.pg_advisory_xact_lock(
      pg_catalog.hashtextextended(new.organization_id::text || ':' || new.id::text || ':' || (v_field->>'key'), 519)
    );
    perform 1 from public.crm_lead_attachments a
       where a.organization_id = new.organization_id
         and a.lead_id = new.id
         and a.custom_field_key = v_field->>'key'
       for key share;
    if not found then
      raise exception using errcode = '23514',
        constraint = 'crm_lead_file_attachment_required',
        message = 'required_file_attachment_missing';
    end if;
  end loop;
  return new;
end;
$$;
revoke all on function public.fn_require_crm_lead_file_attachments_on_stage_change() from public, anon, authenticated, service_role;
drop trigger if exists trg_require_crm_lead_file_attachments_on_stage_change on public.crm_leads;
create trigger trg_require_crm_lead_file_attachments_on_stage_change
  before update of stage_id on public.crm_leads
  for each row execute function public.fn_require_crm_lead_file_attachments_on_stage_change();

create or replace function public.fn_enqueue_orphan_crm_lead_attachments(p_limit integer default 500)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_limit integer := greatest(1, least(coalesce(p_limit, 500), 5000));
  v_count integer := 0;
begin
  with orphans as (
    select o.name as object_path,
           org.id as organization_id
      from storage.objects o
      join public.organizations org on org.id::text = split_part(o.name, '/', 1)
     where o.bucket_id = 'internal-media'
       and o.created_at < now() - interval '1 day'
       and split_part(o.name, '/', 2) = 'lead-attachments'
       and split_part(o.name, '/', 1) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and split_part(o.name, '/', 3) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       and split_part(o.name, '/', 4) ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(pdf|png|jpg|webp)$'
       and not exists (
         select 1 from public.crm_lead_attachments a
          where a.storage_bucket = o.bucket_id and a.storage_path = o.name
       )
       and not exists (
         select 1 from public.storage_redaction_queue q
          where q.bucket = o.bucket_id and q.object_path = o.name
            and q.status not in ('deleted', 'skipped')
       )
     order by o.created_at
     limit v_limit
  ), queued as (
    insert into public.storage_redaction_queue (organization_id, bucket, object_path)
    select organization_id, 'internal-media', object_path from orphans
    on conflict (bucket, object_path) do update
      set status = 'pending', attempts = 0, enqueued_at = now(),
          processed_at = null, error_message = null
      where public.storage_redaction_queue.status in ('deleted', 'skipped')
    returning 1
  )
  select count(*) into v_count from queued;
  return jsonb_build_object('orfas', v_count);
end;
$$;
revoke all on function public.fn_enqueue_orphan_crm_lead_attachments(integer) from public, anon, authenticated;
grant execute on function public.fn_enqueue_orphan_crm_lead_attachments(integer) to service_role;

-- Defesa em profundidade: app valida antes da escrita para devolver o diálogo;
-- este trigger impede que uma rota alternativa ou escrita concorrente entre na
-- etapa sem o anexo ativo correspondente.
revoke all on function public.fn_require_crm_lead_file_attachments_on_stage_change() from public, anon, authenticated, service_role;
