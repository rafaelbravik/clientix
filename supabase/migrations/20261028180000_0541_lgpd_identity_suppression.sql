-- Impede que um titular anonimizado a pedido seja recriado por ingressos que
-- resolvem contato fora da importação histórica. Reutiliza o HMAC, a chave e a
-- tabela de tombstones da migration 0518; não aplica o bloqueio geral de
-- importação histórica aos contatos novos legítimos. Também preserva identidades
-- sociais e e-mail que a cascata LGPD remove do cadastro.

-- Recibos têm identificadores conhecidos pela tela do pedido. Impede que o
-- membro do tenant contorne o role da rota baixando o objeto diretamente pelo
-- Storage API; a leitura dos recibos passa pelo proxy autenticado. Outros
-- exports continuam sob a policy tenant_read_lgpd_exports existente.
drop policy if exists lgpd_receipts_proxy_only on storage.objects;
create policy lgpd_receipts_proxy_only on storage.objects
  as restrictive for select
  using (
    bucket_id <> 'lgpd-exports'
    or split_part(name, '/', 2) <> 'receipts'
  );

create or replace function private.fn_contacts_identity_suppression_guard()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private, extensions
as $$
declare
  v_identities text[] := '{}'::text[];
  v_identity text;
  v_digits text;
  v_phone text;
  v_lid text;
  v_chat text;
  v_social text;
  v_email text;
  v_digest bytea;
  v_suppressed boolean := false;
begin
  if new.organization_id is null then
    raise exception 'lgpd_suppression_unavailable' using errcode = '55000';
  end if;

  -- A cascata apaga as identidades na mesma gravação que marca a lápide; a
  -- trigger 0518 já capturou os HMACs a partir de OLD antes desta.
  if tg_op = 'UPDATE' then
    if old.is_anonymized is true then
      -- Upsert de integração também pode atingir uma linha anonimizada já
      -- existente. Permite limpar resíduos legados e reusar uma fixture sem
      -- identidade; nunca permite adicionar/trocar identidade, mudar de tenant
      -- ou desmarcar uma lápide que ainda guarda identidade.
      if new.organization_id is distinct from old.organization_id
         or (new.phone_number is not null and new.phone_number is distinct from old.phone_number)
         or (new.wa_lid is not null and new.wa_lid is distinct from old.wa_lid)
         or (new.social_identity is not null and new.social_identity is distinct from old.social_identity)
         or (new.email is not null and new.email is distinct from old.email)
         or (nullif(new.source_metadata->>'waha_lid', '') is not null
             and nullif(new.source_metadata->>'waha_lid', '') is distinct from nullif(old.source_metadata->>'waha_lid', ''))
         or (nullif(new.source_metadata->>'waha_chat_id', '') is not null
             and nullif(new.source_metadata->>'waha_chat_id', '') is distinct from nullif(old.source_metadata->>'waha_chat_id', ''))
         or (new.is_anonymized is distinct from true and (
              old.phone_number is not null or old.wa_lid is not null or old.social_identity is not null
              or old.email is not null
              or nullif(old.source_metadata->>'waha_lid', '') is not null
              or nullif(old.source_metadata->>'waha_chat_id', '') is not null
            )) then
        raise exception 'lgpd_subject_suppressed' using errcode = '42501';
      end if;
      return new;
    end if;
    if new.is_anonymized is true then
      return new;
    end if;
  elsif new.is_anonymized is true then
    return new;
  end if;

  begin
    -- Mesmo lock tenant-scoped usado pela captura da lápide e pelo importador.
    -- Serializa o check com a transição para anonimizado, sem lock global.
    perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text, 51808));

    v_phone := coalesce(new.phone_number, '');
    v_digits := regexp_replace(v_phone, '\D', '', 'g');
    if length(v_digits) >= 8 then
      v_identities := array_append(v_identities, 'phone:' || v_digits);
      if v_digits ~ '^55[1-9][0-9][6-9][0-9]{7}$' then
        v_identities := array_append(v_identities,
          'phone:55' || substring(v_digits from 3 for 2) || '9' || substring(v_digits from 5));
      elsif v_digits ~ '^55[1-9][0-9]9[6-9][0-9]{7}$' then
        v_identities := array_append(v_identities,
          'phone:55' || substring(v_digits from 3 for 2) || substring(v_digits from 6));
      end if;
    end if;

    v_lid := nullif(regexp_replace(coalesce(nullif(new.wa_lid, ''), new.source_metadata->>'waha_lid', ''), '@.*$', ''), '');
    if v_lid ~ '^[a-zA-Z0-9.-]{1,100}$' then
      v_identities := array_append(v_identities, 'lid:' || v_lid);
      v_identities := array_append(v_identities, 'chat:' || v_lid || '@lid');
    end if;

    v_chat := nullif(new.source_metadata->>'waha_chat_id', '');
    if v_chat ~ '^\+?[0-9]{8,15}@(c\.us|s\.whatsapp\.net)$' then
      v_identities := array_append(v_identities, 'chat:' || v_chat);
      v_digits := regexp_replace(split_part(v_chat, '@', 1), '\D', '', 'g');
      v_identities := array_append(v_identities, 'phone:' || v_digits);
      if v_digits ~ '^55[1-9][0-9][6-9][0-9]{7}$' then
        v_identities := array_append(v_identities,
          'phone:55' || substring(v_digits from 3 for 2) || '9' || substring(v_digits from 5));
      elsif v_digits ~ '^55[1-9][0-9]9[6-9][0-9]{7}$' then
        v_identities := array_append(v_identities,
          'phone:55' || substring(v_digits from 3 for 2) || substring(v_digits from 6));
      end if;
    elsif v_chat ~ '^[a-zA-Z0-9.-]{1,100}@lid$' then
      v_identities := array_append(v_identities, 'chat:' || v_chat);
      v_identities := array_append(v_identities, 'lid:' || split_part(v_chat, '@', 1));
    end if;

    -- Identidade opaca usada por Instagram, TikTok, Telegram e Zernio.
    -- Prefixo próprio evita colisão com telefone/LID; a normalização é a mesma
    -- na lápide e na tentativa de ingresso.
    v_social := nullif(lower(btrim(new.social_identity)), '');
    if v_social is not null then
      v_identities := array_append(v_identities, 'social:' || v_social);
    end if;

    -- E-mail é a identidade primária do ingresso de e-mail e também é aceito
    -- por imports/webhooks. Usa a mesma tabela e a mesma chave HMAC do WhatsApp.
    v_email := nullif(lower(btrim(new.email)), '');
    if v_email is not null then
      v_identities := array_append(v_identities, 'email:' || v_email);
    end if;

    foreach v_identity in array v_identities loop
      v_digest := private.fn_whatsapp_history_digest(v_identity);
      if v_digest is null then
        raise exception 'lgpd_suppression_unavailable' using errcode = '55000';
      end if;
      if exists (
        select 1
          from public.whatsapp_history_suppressed_identities s
         where s.organization_id = new.organization_id
           and s.identity_digest = v_digest
      ) then
        v_suppressed := true;
        exit;
      end if;
    end loop;
  exception when others then
    if sqlerrm = 'lgpd_suppression_unavailable' then raise; end if;
    raise exception 'lgpd_suppression_unavailable' using errcode = '55000';
  end;

  if v_suppressed then
    raise exception 'lgpd_subject_suppressed' using errcode = '42501';
  end if;
  return new;
end;
$$;
revoke all on function private.fn_contacts_identity_suppression_guard() from public, anon, authenticated, service_role;

drop trigger if exists trg_contacts_identity_suppression_insert on public.contacts;
create trigger trg_contacts_identity_suppression_insert
  before insert on public.contacts
  for each row execute function private.fn_contacts_identity_suppression_guard();

drop trigger if exists trg_contacts_identity_suppression_update on public.contacts;
create trigger trg_contacts_identity_suppression_update
  before update of organization_id, phone_number, wa_lid, source_metadata, social_identity, email on public.contacts
  for each row execute function private.fn_contacts_identity_suppression_guard();

-- A cascata remove social_identity e email. Capture ambos antes da limpeza,
-- para sincronizações sociais e de e-mail não recriarem a mesma pessoa.
create or replace function private.fn_contacts_capture_identity_suppression()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, public, private
as $$
declare
  v_email text;
begin
  if coalesce(old.is_anonymized, false)
     or not coalesce(new.is_anonymized, false) then
    return new;
  end if;

  begin
    perform pg_advisory_xact_lock(hashtextextended(old.organization_id::text, 51808));
    if nullif(btrim(old.social_identity), '') is not null then
      perform private.fn_whatsapp_history_store_identity(
        old.organization_id,
        'social:' || lower(btrim(old.social_identity))
      );
    end if;
    v_email := nullif(lower(btrim(old.email)), '');
    if v_email is not null then
      perform private.fn_whatsapp_history_store_identity(old.organization_id, 'email:' || v_email);
    end if;
  exception when others then
    -- Mesma política da captura histórica WhatsApp: a cascata de anonimização
    -- continua, mas a organização fica sinalizada para a ingestão fail-closed.
    insert into public.whatsapp_history_import_blocks (organization_id, reason_code)
    values (old.organization_id, 'suppression_key_unavailable') on conflict (organization_id) do nothing;
  end;
  -- Algumas cascatas antigas não limpavam estes identificadores. A captura
  -- ocorre a partir de OLD; o objeto salvo nunca conserva endereços externos.
  new.phone_number := null;
  new.email := null;
  new.social_identity := null;
  new.source_metadata := '{}'::jsonb;
  return new;
end;
$$;
revoke all on function private.fn_contacts_capture_identity_suppression() from public, anon, authenticated, service_role;
drop trigger if exists trg_contacts_capture_social_suppression on public.contacts;
drop trigger if exists trg_contacts_capture_identity_suppression on public.contacts;
create trigger trg_contacts_capture_identity_suppression
  before update of is_anonymized on public.contacts
  for each row when (new.is_anonymized is true and old.is_anonymized is distinct from true)
  execute function private.fn_contacts_capture_identity_suppression();

-- Migra tombstones legados que ainda guardavam endereços fora do conjunto
-- WhatsApp original. HMACs ficam no mecanismo canônico; valores em claro são
-- removidos. Se a chave estiver indisponível, bloqueia-se a ingestão da org.
do $$
declare
  r record;
  v_phone text;
  v_digits text;
  v_alt text;
  v_lid text;
  v_chat text;
  v_email text;
  v_social text;
begin
  for r in
    select id, organization_id, phone_number, wa_lid, source_metadata, social_identity, email
      from public.contacts
     where is_anonymized is true
       and (phone_number is not null or wa_lid is not null or social_identity is not null
            or email is not null or coalesce(source_metadata, '{}'::jsonb) <> '{}'::jsonb)
     order by organization_id, id
  loop
    begin
      perform pg_advisory_xact_lock(hashtextextended(r.organization_id::text, 51808));
      v_phone := nullif(r.phone_number, '');
      v_digits := regexp_replace(coalesce(v_phone, ''), '\D', '', 'g');
      if length(v_digits) >= 8 then
        perform private.fn_whatsapp_history_store_identity(r.organization_id, 'phone:' || v_digits);
        if v_digits ~ '^55[1-9][0-9][6-9][0-9]{7}$' then
          v_alt := '55' || substring(v_digits from 3 for 2) || '9' || substring(v_digits from 5);
          perform private.fn_whatsapp_history_store_identity(r.organization_id, 'phone:' || v_alt);
        elsif v_digits ~ '^55[1-9][0-9]9[6-9][0-9]{7}$' then
          v_alt := '55' || substring(v_digits from 3 for 2) || substring(v_digits from 6);
          perform private.fn_whatsapp_history_store_identity(r.organization_id, 'phone:' || v_alt);
        end if;
      end if;
      v_lid := nullif(regexp_replace(coalesce(nullif(r.wa_lid, ''), r.source_metadata->>'waha_lid', ''), '@.*$', ''), '');
      if v_lid ~ '^[a-zA-Z0-9.-]{1,100}$' then
        perform private.fn_whatsapp_history_store_identity(r.organization_id, 'lid:' || v_lid);
        perform private.fn_whatsapp_history_store_identity(r.organization_id, 'chat:' || v_lid || '@lid');
      end if;
      v_chat := nullif(r.source_metadata->>'waha_chat_id', '');
      if v_chat ~ '^\+?[0-9]{8,15}@(c\.us|s\.whatsapp\.net)$' then
        perform private.fn_whatsapp_history_store_identity(r.organization_id, 'chat:' || v_chat);
        v_digits := regexp_replace(split_part(v_chat, '@', 1), '\D', '', 'g');
        perform private.fn_whatsapp_history_store_identity(r.organization_id, 'phone:' || v_digits);
      elsif v_chat ~ '^[a-zA-Z0-9.-]{1,100}@lid$' then
        perform private.fn_whatsapp_history_store_identity(r.organization_id, 'chat:' || v_chat);
        perform private.fn_whatsapp_history_store_identity(r.organization_id, 'lid:' || split_part(v_chat, '@', 1));
      end if;
      v_social := nullif(lower(btrim(r.social_identity)), '');
      if v_social is not null then
        perform private.fn_whatsapp_history_store_identity(r.organization_id, 'social:' || v_social);
      end if;
      v_email := nullif(lower(btrim(r.email)), '');
      if v_email is not null then
        perform private.fn_whatsapp_history_store_identity(r.organization_id, 'email:' || v_email);
      end if;
    exception when others then
      insert into public.whatsapp_history_import_blocks (organization_id, reason_code)
      values (r.organization_id, 'suppression_key_unavailable') on conflict (organization_id) do nothing;
    end;
    update public.contacts set phone_number = null, email = null, social_identity = null,
      source_metadata = '{}'::jsonb
     where organization_id = r.organization_id and id = r.id and is_anonymized is true;
  end loop;
end;
$$;

-- A resolução WA não pode selecionar a lápide e reaproveitá-la como contato
-- ativo. O trigger acima é a trava atômica para a inserção/atualização final.
create or replace function public.fn_upsert_wa_contact(
  p_org uuid, p_kind text, p_phone text, p_lid text, p_chat_id text, p_notify text
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_id uuid;
  v_conflito text;
  v_lid text := nullif(regexp_replace(coalesce(p_lid, ''), '@.*$', ''), '');
  v_phone text := nullif(p_phone, '');
  v_digits text;
  v_alt text;
begin
  if p_org is null then
    raise exception 'lgpd_suppression_unavailable' using errcode = '55000';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org::text, 51808));

  -- Celular BR de 12 dígitos ganha o nono; a grafia sem o 9 é apenas busca.
  if v_phone is not null then
    v_digits := regexp_replace(v_phone, '\D', '', 'g');
    if v_digits ~ '^55[1-9][0-9][6-9][0-9]{7}$' then
      v_alt := '+' || v_digits;
      v_phone := '+55' || substring(v_digits from 3 for 2) || '9' || substring(v_digits from 5);
    elsif v_digits ~ '^55[1-9][0-9]9[6-9][0-9]{7}$' then
      v_phone := '+' || v_digits;
      v_alt := '+55' || substring(v_digits from 3 for 2) || substring(v_digits from 6);
    end if;
  end if;

  if v_lid is not null then
    select id into v_id from public.contacts
     where organization_id = p_org and wa_lid = v_lid
       and is_merged_into is null and is_anonymized = false
     limit 1;
  end if;

  if v_id is null and v_phone is not null then
    select id into v_id from public.contacts
     where organization_id = p_org and is_merged_into is null and is_anonymized = false
       and phone_number in (v_phone, v_alt)
     order by case when phone_number = v_phone then 0 else 1 end
     limit 1;
  end if;

  if v_id is not null and v_phone is not null and exists (
    select 1 from public.contacts
     where organization_id = p_org and phone_number = v_phone
       and is_merged_into is null and is_anonymized = false and id <> v_id
  ) then
    v_conflito := v_phone;
    v_phone := null;
  end if;

  if v_id is not null then
    update public.contacts set
      phone_number = case
        when v_phone is not null and (phone_number is null or phone_number = v_alt) then v_phone
        else phone_number
      end,
      display_name = coalesce(display_name, nullif(p_notify, '')),
      source_metadata = source_metadata
        || case when v_lid is not null then jsonb_build_object('waha_lid', v_lid) else '{}'::jsonb end
        || case when p_chat_id is not null then jsonb_build_object('waha_chat_id', p_chat_id) else '{}'::jsonb end
        || case when nullif(p_notify, '') is not null then jsonb_build_object('notify_name', p_notify) else '{}'::jsonb end
        || case when v_conflito is not null then jsonb_build_object('telefone_em_conflito', v_conflito) else '{}'::jsonb end,
      updated_at = now()
    where id = v_id and organization_id = p_org and is_anonymized = false
    returning id into v_id;
    if not found then
      raise exception 'lgpd_subject_suppressed' using errcode = '42501';
    end if;
    return v_id;
  end if;

  begin
    insert into public.contacts (organization_id, phone_number, source, consent, tags, source_metadata, display_name)
    values (p_org, v_phone, 'whatsapp', '{}'::jsonb, '{}'::text[],
      case when v_lid is not null
        then jsonb_build_object('waha_lid', v_lid, 'waha_chat_id', p_chat_id, 'notify_name', nullif(p_notify, ''))
        else jsonb_build_object('waha_chat_id', p_chat_id, 'notify_name', nullif(p_notify, '')) end,
      nullif(p_notify, ''))
    returning id into v_id;
    return v_id;
  exception when unique_violation then
    select id into v_id from public.contacts
     where organization_id = p_org and is_merged_into is null and is_anonymized = false
       and (
         (v_phone is not null and phone_number = v_phone)
         or (v_alt is not null and phone_number = v_alt)
         or (v_lid is not null and wa_lid = v_lid)
       )
     order by case when phone_number = v_phone then 0 else 1 end
     limit 1;
    return v_id;
  end;
end;
$$;
revoke all on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text) from public, anon, authenticated;
grant execute on function public.fn_upsert_wa_contact(uuid, text, text, text, text, text) to service_role;
