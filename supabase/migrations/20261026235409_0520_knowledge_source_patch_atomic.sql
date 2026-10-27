-- P1-04: metadata, FAQ replacement and reindex event form one transaction.
-- Called only by the authenticated, manager-gated route through service_role.
create or replace function public.fn_update_ai_knowledge_source_atomic(
  p_source_id uuid,
  p_organization_id uuid,
  p_patch jsonb
) returns jsonb
  language plpgsql
  security definer
  set search_path to 'public'
as $function$
declare
  v_source_type text;
  v_agent_id uuid;
  v_item jsonb;
  v_tag jsonb;
  v_items_count integer := 0;
begin
  if p_patch is null or jsonb_typeof(p_patch) <> 'object' then
    raise exception 'invalid knowledge source patch' using errcode = '22023';
  end if;

  if exists (
    select 1
      from jsonb_object_keys(p_patch) as patch_key(key)
     where patch_key.key not in ('name', 'source_metadata', 'items')
  ) then
    raise exception 'unknown knowledge source patch key' using errcode = '22023';
  end if;

  select s.source_type, s.agent_id
    into v_source_type, v_agent_id
    from public.ai_knowledge_sources s
   where s.id = p_source_id
     and s.organization_id = p_organization_id
   for update;

  if not found then
    raise exception 'knowledge source not found' using errcode = 'P0002';
  end if;

  if p_patch ? 'name' and (
    jsonb_typeof(p_patch->'name') is distinct from 'string'
    or char_length(p_patch->>'name') < 2
    or char_length(p_patch->>'name') > 120
  ) then
    raise exception 'invalid knowledge source name' using errcode = '22023';
  end if;

  if p_patch ? 'source_metadata'
     and jsonb_typeof(p_patch->'source_metadata') <> 'object' then
    raise exception 'invalid knowledge source metadata' using errcode = '22023';
  end if;

  -- Validate the WHOLE replacement before changing metadata or deleting rows.
  if p_patch ? 'items' then
    if jsonb_typeof(p_patch->'items') <> 'array' or v_source_type <> 'faq' then
      raise exception 'FAQ items require a FAQ source and an array' using errcode = '22023';
    end if;

    for v_item in select value from jsonb_array_elements(p_patch->'items') as items(value)
    loop
      if jsonb_typeof(v_item) is distinct from 'object'
         or jsonb_typeof(v_item->'question') is distinct from 'string'
         or char_length(v_item->>'question') < 1
         or jsonb_typeof(v_item->'answer') is distinct from 'string'
         or char_length(v_item->>'answer') < 1
         or (v_item ? 'tags' and jsonb_typeof(v_item->'tags') is distinct from 'array')
         or (v_item ? 'locale' and jsonb_typeof(v_item->'locale') is distinct from 'string') then
        raise exception 'invalid FAQ item' using errcode = '22023';
      end if;

      if v_item ? 'tags' then
        for v_tag in select value from jsonb_array_elements(v_item->'tags') as tags(value)
        loop
          if jsonb_typeof(v_tag) is distinct from 'string' then
            raise exception 'invalid FAQ item tag' using errcode = '22023';
          end if;
        end loop;
      end if;
    end loop;
  end if;

  if p_patch ? 'name' or p_patch ? 'source_metadata' then
    update public.ai_knowledge_sources
       set name = case when p_patch ? 'name' then p_patch->>'name' else name end,
           source_metadata = case when p_patch ? 'source_metadata'
             then p_patch->'source_metadata' else source_metadata end,
           updated_at = now()
     where id = p_source_id
       and organization_id = p_organization_id;
  end if;

  if p_patch ? 'items' then
    delete from public.ai_faq_items
     where organization_id = p_organization_id
       and knowledge_source_id = p_source_id;

    insert into public.ai_faq_items (
      organization_id, knowledge_source_id, question, answer, tags, locale, position
    )
    select
      p_organization_id,
      p_source_id,
      item.value->>'question',
      item.value->>'answer',
      array(select jsonb_array_elements_text(coalesce(item.value->'tags', '[]'::jsonb))),
      coalesce(item.value->>'locale', 'pt-BR'),
      (item.ordinality - 1)::integer
      from jsonb_array_elements(p_patch->'items') with ordinality as item(value, ordinality);

    get diagnostics v_items_count = row_count;
  end if;

  -- The event is part of the same transaction: an event failure rolls back the
  -- source update and FAQ replacement instead of leaving changed data unindexed.
  perform public.emit_event(
    'knowledge_source.updated',
    'ai_knowledge_source',
    p_source_id,
    jsonb_build_object(
      'knowledge_source_id', p_source_id,
      'agent_id', v_agent_id,
      'source_type', v_source_type
    ),
    '{}'::jsonb,
    p_organization_id
  );

  if p_patch ? 'items' then
    return jsonb_build_object('id', p_source_id, 'items_count', v_items_count);
  end if;
  return jsonb_build_object('id', p_source_id);
end;
$function$;

revoke all on function public.fn_update_ai_knowledge_source_atomic(uuid, uuid, jsonb)
  from public, anon, authenticated;
grant execute on function public.fn_update_ai_knowledge_source_atomic(uuid, uuid, jsonb)
  to service_role;
