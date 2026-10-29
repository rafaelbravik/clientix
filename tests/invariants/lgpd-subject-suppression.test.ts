import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER ?? "";
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

describe("LGPD — supressão do titular apagado em ingressos de contato", () => {
  it("bloqueia recriação no tenant de origem e permite o mesmo telefone em outro tenant", () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const contact = randomUUID();
    const phone12 = "+553284793302";
    const phone13 = "+5532984793302";
    const phoneOther = "+553132345678";
    const result = sql(`
      begin;
      insert into public.organizations(id,slug,legal_name,display_name) values
        ('${orgA}','lgpd-suppression-a-${orgA}','QA LGPD A','QA LGPD A'),
        ('${orgB}','lgpd-suppression-b-${orgB}','QA LGPD B','QA LGPD B');
      set role service_role;
      insert into public.contacts(id,organization_id,phone_number,email,social_identity,source_metadata,source,display_name)
        values ('${contact}','${orgA}','${phone12}','Titular.QA@Example.test','instagram:qa-account:qa-participant',
          '{"waha_lid":"qa-lid-subject","waha_chat_id":"5532984793302@c.us"}'::jsonb,'whatsapp','Titular QA');
      update public.contacts
         set is_anonymized=true, anonymized_at=now(), phone_number=null,
             email=null, social_identity=null, source_metadata='{}'::jsonb
       where organization_id='${orgA}' and id='${contact}';

      do $$ begin
        begin
          perform public.fn_upsert_wa_contact('${orgA}','phone','${phone13}',null,'5532984793302@c.us',null);
          raise exception 'expected_tombstone_rejection' using errcode='P0001';
        exception when sqlstate '42501' then
          if sqlerrm <> 'lgpd_subject_suppressed' then raise; end if;
        end;
        begin
          insert into public.contacts(organization_id,phone_number,source,display_name)
            values ('${orgA}','${phone12}','import','Tentativa de recriação');
          raise exception 'expected_direct_insert_rejection' using errcode='P0001';
        exception when sqlstate '42501' then
          if sqlerrm <> 'lgpd_subject_suppressed' then raise; end if;
        end;
        begin
          insert into public.contacts(organization_id,social_identity,source,display_name)
            values ('${orgA}','instagram:qa-account:qa-participant','social','Tentativa social');
          raise exception 'expected_social_tombstone_rejection' using errcode='P0001';
        exception when sqlstate '42501' then
          if sqlerrm <> 'lgpd_subject_suppressed' then raise; end if;
        end;
        begin
          insert into public.contacts(organization_id,email,source,display_name)
            values ('${orgA}','Titular.QA@Example.test','email','Tentativa por e-mail');
          raise exception 'expected_email_tombstone_rejection' using errcode='P0001';
        exception when sqlstate '42501' then
          if sqlerrm <> 'lgpd_subject_suppressed' then raise; end if;
        end;
      end $$;

      do $$ begin
        begin
          update public.contacts
             set phone_number='${phone12}', email='Titular.QA@Example.test',
                 social_identity='instagram:qa-account:qa-participant'
           where organization_id='${orgA}' and id='${contact}' and is_anonymized=true;
          raise exception 'expected_anonymized_identity_rejection' using errcode='P0001';
        exception when sqlstate '42501' then
          if sqlerrm <> 'lgpd_subject_suppressed' then raise; end if;
        end;
        begin
          update public.contacts
             set is_anonymized=false, phone_number='${phone12}'
           where organization_id='${orgA}' and id='${contact}' and is_anonymized=true;
          raise exception 'expected_unmark_with_identity_rejection' using errcode='P0001';
        exception when sqlstate '42501' then
          if sqlerrm <> 'lgpd_subject_suppressed' then raise; end if;
        end;
      end $$;

      select 'OTHER_TENANT=' || (public.fn_upsert_wa_contact('${orgB}','phone','${phone13}',null,'5532984793302@c.us',null) is not null)::text;
      insert into public.contacts(organization_id,social_identity,source,display_name)
        values ('${orgB}','instagram:qa-account:qa-participant','social','Outro tenant');
      insert into public.contacts(organization_id,email,source,display_name)
        values ('${orgB}','titular.qa@example.test','email','Outro tenant');
      select 'NEW_IDENTITY=' || (public.fn_upsert_wa_contact('${orgA}','phone','${phoneOther}',null,'553132345678@c.us',null) is not null)::text;
      select 'SUPPRESSION=' || public.fn_whatsapp_history_check_suppression('${orgA}',array['phone:5532984793302']);
      select 'SOCIAL_B=' || count(*) from public.contacts where organization_id='${orgB}' and social_identity='instagram:qa-account:qa-participant' and is_anonymized=false;
      select 'EMAIL_B=' || count(*) from public.contacts where organization_id='${orgB}' and email_normalized='titular.qa@example.test' and is_anonymized=false;
      select 'ANON_IDENTITIES=' || (phone_number is null and email is null and social_identity is null and wa_lid is null and source_metadata='{}'::jsonb)::text
        from public.contacts where organization_id='${orgA}' and id='${contact}' and is_anonymized=true;
      select 'ACTIVE_A=' || count(*) from public.contacts where organization_id='${orgA}' and is_anonymized=false and phone_number is not null;
      select 'ACTIVE_B=' || count(*) from public.contacts where organization_id='${orgB}' and is_anonymized=false and phone_number is not null;
      reset role;
      rollback;
    `);
    expect(result).toContain("OTHER_TENANT=true");
    expect(result).toContain("NEW_IDENTITY=true");
    expect(result).toContain("SUPPRESSION=identity_suppressed");
    expect(result).toContain("SOCIAL_B=1");
    expect(result).toContain("EMAIL_B=1");
    expect(result).toContain("ANON_IDENTITIES=true");
    expect(result).toContain("ACTIVE_A=1");
    expect(result).toContain("ACTIVE_B=1");
  });

  it("falha fechado se a chave HMAC canônica ficar indisponível", () => {
    const org = randomUUID();
    const contact = randomUUID();
    const result = sql(`
      begin;
      insert into public.organizations(id,slug,legal_name,display_name)
        values ('${org}','lgpd-suppression-key-${org}','QA LGPD','QA LGPD');
      set role service_role;
      insert into public.contacts(id,organization_id,social_identity,source,display_name)
        values ('${contact}','${org}','telegram:qa-subject','telegram','Titular QA');
      reset role;
      delete from private.whatsapp_history_suppression_key where singleton=true;
      set role service_role;
      do $$ begin
        update public.contacts
           set is_anonymized=true, anonymized_at=now(), social_identity=null
         where id='${contact}' and organization_id='${org}';
        begin
          insert into public.contacts(organization_id,phone_number,source)
            values ('${org}','+5531999991234','import');
          raise exception 'expected_closed_failure' using errcode='P0001';
        exception when sqlstate '55000' then
          if sqlerrm <> 'lgpd_suppression_unavailable' then raise; end if;
        end;
      end $$;
      select 'ANONYMIZED=' || is_anonymized::text from public.contacts where organization_id='${org}' and id='${contact}';
      select 'IDENTITY_CLEARED=' || (email is null and social_identity is null and source_metadata='{}'::jsonb)::text
        from public.contacts where organization_id='${org}' and id='${contact}';
      select 'BLOCKED=' || count(*) from public.whatsapp_history_import_blocks where organization_id='${org}' and reason_code='suppression_key_unavailable';
      select 'CREATED=' || count(*) from public.contacts where organization_id='${org}';
      reset role;
      rollback;
    `);
    expect(result).toContain("ANONYMIZED=true");
    expect(result).toContain("IDENTITY_CLEARED=true");
    expect(result).toContain("BLOCKED=1");
    expect(result).toContain("CREATED=1");
  });

  it("não expõe a rotina privada nem deixa ler recibo diretamente pelo Storage", () => {
    const privileges = sql(`
      select has_function_privilege('anon','private.fn_contacts_identity_suppression_guard()','EXECUTE')::text || ',' ||
             has_function_privilege('authenticated','private.fn_contacts_identity_suppression_guard()','EXECUTE')::text || ',' ||
             has_function_privilege('service_role','private.fn_contacts_identity_suppression_guard()','EXECUTE')::text;
      select coalesce(qual, '') from pg_policies
       where schemaname='storage' and tablename='objects' and policyname='lgpd_receipts_proxy_only';
      select has_function_privilege('anon','public.fn_upsert_wa_contact(uuid,text,text,text,text,text)','EXECUTE')::text || ',' ||
             has_function_privilege('authenticated','public.fn_upsert_wa_contact(uuid,text,text,text,text,text)','EXECUTE')::text || ',' ||
             has_function_privilege('service_role','public.fn_upsert_wa_contact(uuid,text,text,text,text,text)','EXECUTE')::text;
    `);
    expect(privileges).toContain("false,false,false");
    expect(privileges).toContain("split_part(name, '/'::text, 2) <> 'receipts'::text");
    expect(privileges).toContain("false,false,true");
  });
});
