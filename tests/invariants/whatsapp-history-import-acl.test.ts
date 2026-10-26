import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER ?? "";
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");

function sql(script: string): string {
  return execFileSync("docker", ["exec", "-i", container, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"], {
    input: script,
    encoding: "utf8",
  }).trim();
}

describe("importação de histórico WhatsApp — ACL e não-disparo", () => {
  it("fecha jobs, tombstones e bloqueios para anon/authenticated", () => {
    const result = sql(`
      select (
        (select relrowsecurity and relforcerowsecurity from pg_class where oid='public.whatsapp_history_imports'::regclass)::text || '|' ||
        has_table_privilege('anon','public.whatsapp_history_imports','SELECT')::text || ',' ||
        has_table_privilege('authenticated','public.whatsapp_history_imports','SELECT')::text || ',' ||
        has_table_privilege('anon','public.whatsapp_history_imports','INSERT')::text || ',' ||
        has_table_privilege('authenticated','public.whatsapp_history_imports','UPDATE')::text || '|' ||
        has_table_privilege('service_role','public.whatsapp_history_imports','SELECT')::text
      );
      select (
        has_table_privilege('anon','public.whatsapp_history_suppressed_identities','SELECT')::text || ',' ||
        has_table_privilege('authenticated','public.whatsapp_history_suppressed_identities','SELECT')::text || ',' ||
        has_table_privilege('anon','public.whatsapp_history_import_blocks','SELECT')::text || ',' ||
        has_table_privilege('authenticated','public.whatsapp_history_import_blocks','SELECT')::text
      );
    `);
    expect(result).toContain("true|false,false,false,false|true");
    expect(result).toContain("false,false,false,false");
  });

  it("somente service_role pode executar os pontos internos de persistência", () => {
    const names = [
      "fn_whatsapp_history_claim(integer)",
      "fn_whatsapp_history_checkpoint(uuid,uuid,jsonb,integer,integer,integer,text,text)",
      "fn_whatsapp_history_check_suppression(uuid,text[])",
      "fn_whatsapp_history_upsert_contact(uuid,uuid,text,text,text,text,text[])",
      "fn_whatsapp_history_persist_conversation(uuid,uuid,text,text,text,text,text[],jsonb)",
      "fn_whatsapp_history_accept_live_duplicate(uuid,uuid,uuid,uuid,text)",
    ];
    for (const signature of names) {
      const result = sql(`select has_function_privilege('anon','public.${signature}','EXECUTE')::text || ',' || has_function_privilege('authenticated','public.${signature}','EXECUTE')::text || ',' || has_function_privilege('service_role','public.${signature}','EXECUTE')::text;`);
      expect(result, signature).toBe("false,false,true");
    }
  });

  it("persiste uma mensagem sem evento de inbound, unread, demanda ou reabertura; repetição não duplica", () => {
    const org = randomUUID();
    const session = randomUUID();
    const user = randomUUID();
    const job = randomUUID();
    const lease = randomUUID();
    const channelName = `history-${session}`;
    const external = `false_5511999999999@c.us_${session.replaceAll("-", "")}`;
    const at = "2026-05-03T12:00:00.000Z";
    const result = sql(`
      begin;
      insert into auth.users(id,email) values ('${user}','history-${user}@invariant.test');
      insert into public.organizations(id,slug,legal_name,display_name) values ('${org}','hist-${session}','History Test','History Test');
      insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,status,provider)
        values ('${session}','${org}','${channelName}',decode('00','hex'),'WORKING','waha');
      insert into public.whatsapp_history_imports(id,organization_id,channel_session_id,status,range_days,range_start,lease_token,lease_expires_at)
        values ('${job}','${org}','${session}','running',30,now()-interval '30 days','${lease}',now()+interval '3 minutes');
      set role service_role;
      select public.fn_whatsapp_history_persist_conversation(
        '${job}','${lease}','phone','+5511999999999',null,'5511999999999@c.us',
        array['phone:5511999999999','chat:5511999999999@c.us','chat:5511999999999@s.whatsapp.net'],
        '[{"external_id":"${external}","type":"text","direction":"inbound","status":"delivered","body":"conteúdo de fixture","media_url":null,"media_mime":null,"sent_at":"${at}","metadata":{}}]'::jsonb
      );
      select public.fn_whatsapp_history_persist_conversation(
        '${job}','${lease}','phone','+5511999999999',null,'5511999999999@c.us',
        array['phone:5511999999999','chat:5511999999999@c.us','chat:5511999999999@s.whatsapp.net'],
        '[{"external_id":"${external}","type":"text","direction":"inbound","status":"delivered","body":"conteúdo de fixture","media_url":null,"media_mime":null,"sent_at":"${at}","metadata":{}}]'::jsonb
      );
      select 'BEFORE_LIVE_EVENTS=' || count(*) from public.event_log where organization_id='${org}' and event_type='message.received';
      select 'HISTORY_SIDE_EFFECTS=' || count(*) from public.event_log where organization_id='${org}'
        and (event_type like 'ai.%' or event_type like 'automation.%' or event_type like 'followup.%'
          or event_type like 'campaign.%' or event_type in ('message.received','message.sent','message.outbound','conversation.routing_requested'));
      select 'HISTORY_CONVERSATION=' || status || ',' || unread_count_for_assignee || ',' || coalesce(last_inbound_at::text,'null') || ',' || coalesce(last_outbound_at::text,'null')
        from public.conversations where organization_id='${org}';
      select public.fn_whatsapp_history_accept_live_duplicate(
        '${org}','${session}',
        (select contact_id from public.conversations where organization_id='${org}' and channel_session_id='${session}'),
        (select id from public.conversations where organization_id='${org}' and channel_session_id='${session}'),
        '${external}'
      );
      select 'REPLAY_ACCEPTED=' || public.fn_whatsapp_history_accept_live_duplicate(
        '${org}','${session}',
        (select contact_id from public.conversations where organization_id='${org}' and channel_session_id='${session}'),
        (select id from public.conversations where organization_id='${org}' and channel_session_id='${session}'),
        '${external}'
      );
      select 'MESSAGES=' || count(*) from public.messages where organization_id='${org}';
      select 'LIVE_EVENTS=' || count(*) from public.event_log where organization_id='${org}' and event_type='message.received';
      select 'LIVE_ROUTING_EVENTS=' || count(*) from public.event_log where organization_id='${org}' and event_type='conversation.routing_requested';
      select 'OUTBOUND_EVENTS=' || count(*) from public.event_log where organization_id='${org}' and event_type in ('message.sent','message.outbound');
      select 'MARKER=' || (metadata ? 'historico_importado')::text || ',' || (metadata ? 'historico_convertido_ao_vivo')::text from public.messages where organization_id='${org}';
      select 'COUNTERS=' || imported_count || ',' || skipped_count || ',' || failed_count from public.whatsapp_history_imports where id='${job}';
      select 'CONVERSATION=' || status || ',' || unread_count_for_assignee || ',' || coalesce(last_inbound_at::text,'null') || ',' || coalesce(last_outbound_at::text,'null')
        from public.conversations where organization_id='${org}';
      reset role;
      rollback;
    `);
    expect(result).toContain("BEFORE_LIVE_EVENTS=0");
    expect(result).toContain("HISTORY_SIDE_EFFECTS=0");
    expect(result).toContain("MESSAGES=1");
    expect(result).toContain("LIVE_EVENTS=1");
    expect(result).toContain("HISTORY_CONVERSATION=closed,0,null,null");
    expect(result).toContain("LIVE_ROUTING_EVENTS=1");
    expect(result).toContain("OUTBOUND_EVENTS=0");
    expect(result).toContain("MARKER=false,true");
    expect(result).toContain("REPLAY_ACCEPTED=false");
    expect(result).toContain("COUNTERS=1,0,0");
    expect(result).toContain("CONVERSATION=open,0,null,null");
  });

  it("impede associar o job a uma sessão de outro tenant", () => {
    const orgA = randomUUID();
    const orgB = randomUUID();
    const session = randomUUID();
    const user = randomUUID();
    const job = randomUUID();
    const result = sql(`
      begin;
      insert into auth.users(id,email) values ('${user}','history-${user}@invariant.test');
      insert into public.organizations(id,slug,legal_name,display_name) values
        ('${orgA}','hist-a-${session}','History A','History A'),
        ('${orgB}','hist-b-${session}','History B','History B');
      insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,status,provider)
        values ('${session}','${orgA}','history-${session}',decode('00','hex'),'WORKING','waha');
      do $$ begin
        begin
          insert into public.whatsapp_history_imports(id,organization_id,channel_session_id,status,range_days,range_start,created_by)
            values ('${job}','${orgB}','${session}','pending',30,now()-interval '30 days','${user}');
          raise exception 'cross tenant job unexpectedly accepted';
        exception when foreign_key_violation then null;
        end;
      end $$;
      select 'CROSS_TENANT_JOB=' || count(*) from public.whatsapp_history_imports where id='${job}';
      rollback;
    `);
    expect(result).toContain("CROSS_TENANT_JOB=0");
  });

  it("claim concorrente é único e cancelamento impede checkpoint stale e novo claim", () => {
    const org = randomUUID();
    const session = randomUUID();
    const user = randomUUID();
    const job = randomUUID();
    const result = sql(`
      begin;
      insert into auth.users(id,email) values ('${user}','history-${user}@invariant.test');
      insert into public.organizations(id,slug,legal_name,display_name) values ('${org}','hist-${session}','History Test','History Test');
      insert into public.channel_sessions(id,organization_id,waha_session_name,webhook_secret_encrypted,status,provider)
        values ('${session}','${org}','${session}',decode('00','hex'),'WORKING','waha');
      insert into public.whatsapp_history_imports(id,organization_id,channel_session_id,status,range_days,range_start,created_by)
        values ('${job}','${org}','${session}','pending',30,now()-interval '30 days','${user}');
      set role service_role;
      do $$
      declare claimed public.whatsapp_history_imports;
      begin
        select * into claimed from public.fn_whatsapp_history_claim(180);
        if claimed.id is distinct from '${job}'::uuid then raise exception 'claim did not return expected job'; end if;
        if exists(select 1 from public.fn_whatsapp_history_claim(180)) then raise exception 'duplicate claim succeeded'; end if;
        update public.whatsapp_history_imports
          set status='cancelled',lease_token=null,lease_expires_at=null,next_attempt_at=null,finished_at=now()
          where id='${job}';
        begin
          perform public.fn_whatsapp_history_checkpoint('${job}',claimed.lease_token,'{"chat_offset":1}'::jsonb,0,0,0,'pending',null);
          raise exception 'stale worker checkpoint unexpectedly succeeded';
        exception when serialization_failure then null;
        end;
        if exists(select 1 from public.fn_whatsapp_history_claim(180)) then raise exception 'cancelled job was reclaimed'; end if;
      end $$;
      select 'CANCELLED=' || status || ',' || (lease_token is null)::text || ',' || (next_attempt_at is null)::text
        from public.whatsapp_history_imports where id='${job}';
      reset role;
      rollback;
    `);
    expect(result).toContain("CANCELLED=cancelled,true,true");
  });
});
