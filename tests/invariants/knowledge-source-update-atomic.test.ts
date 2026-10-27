import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { GOV_ORG, seedGov, sql } from "./gov-helpers";

const SOURCE = "cccccccc-7777-4000-8000-000000000002";
const AGENT = "cccccccc-7777-4000-8000-000000000001";
const INSERT_FAILURE = "__clientix_test_fail_faq_insert__";

function patch(value: unknown): string {
  return JSON.stringify(value).replaceAll("'", "''");
}

function runPatch(value: unknown): string {
  return sql(
    `select public.fn_update_ai_knowledge_source_atomic('${SOURCE}', '${GOV_ORG}', '${patch(value)}'::jsonb)::text;`,
  );
}

function faqState(): { name: string; source_metadata: { marker?: string }; questions: string[] } {
  const result = sql(`
    select json_build_object(
      'name', s.name,
      'source_metadata', s.source_metadata,
      'questions', coalesce((
        select json_agg(f.question order by f.position)
          from public.ai_faq_items f
         where f.organization_id = '${GOV_ORG}' and f.knowledge_source_id = s.id
      ), '[]'::json)
    )::text
      from public.ai_knowledge_sources s
     where s.organization_id = '${GOV_ORG}' and s.id = '${SOURCE}';
  `);
  return JSON.parse(result);
}

beforeAll(() => {
  seedGov();
  sql(`
    insert into public.ai_agents (id, organization_id, name, system_prompt)
    values ('${AGENT}', '${GOV_ORG}', 'Atomic knowledge test', 'synthetic')
    on conflict (id) do nothing;
    insert into public.ai_knowledge_sources
      (id, organization_id, agent_id, source_type, name, source_metadata)
    values ('${SOURCE}', '${GOV_ORG}', '${AGENT}', 'faq', 'FAQ original', '{"marker":"original"}'::jsonb)
    on conflict (id) do update set name = excluded.name, source_metadata = excluded.source_metadata;
    delete from public.ai_faq_items where organization_id = '${GOV_ORG}' and knowledge_source_id = '${SOURCE}';
    insert into public.ai_faq_items (organization_id, knowledge_source_id, question, answer, position)
    values ('${GOV_ORG}', '${SOURCE}', 'Pergunta original', 'Resposta original', 0);
  `);
});

afterAll(() => {
  sql(`
    drop trigger if exists trg_test_knowledge_source_fail_faq_insert on public.ai_faq_items;
    drop function if exists public.fn_test_knowledge_source_fail_faq_insert();
    delete from public.ai_faq_items where organization_id = '${GOV_ORG}' and knowledge_source_id = '${SOURCE}';
    delete from public.ai_knowledge_sources where organization_id = '${GOV_ORG}' and id = '${SOURCE}';
    delete from public.ai_agents where organization_id = '${GOV_ORG}' and id = '${AGENT}';
  `);
});

describe("fn_update_ai_knowledge_source_atomic", () => {
  it("atualiza metadata, substitui o conjunto FAQ e emite o evento com contagem", () => {
    const output = JSON.parse(
      runPatch({
        name: "FAQ atualizada",
        source_metadata: { marker: "updated" },
        items: [{ question: "Pergunta nova", answer: "Resposta nova", tags: ["teste"], locale: "pt-BR" }],
      }),
    ) as { id: string; items_count: number };

    expect(output).toEqual({ id: SOURCE, items_count: 1 });
    expect(faqState()).toEqual({
      name: "FAQ atualizada",
      source_metadata: { marker: "updated" },
      questions: ["Pergunta nova"],
    });
    expect(
      sql(
        `select count(*) from public.event_log where organization_id = '${GOV_ORG}' and event_type = 'knowledge_source.updated' and entity_id = '${SOURCE}';`,
      ),
    ).toBe("1");
  });

  it("valida tudo antes da mutação e preserva os valores anteriores", () => {
    sql(`
      do $test$
      begin
        begin
          perform public.fn_update_ai_knowledge_source_atomic(
            '${SOURCE}', '${GOV_ORG}', '{"name":"não salvar","items":[{"question":""}]}'::jsonb
          );
          raise exception 'invalid patch unexpectedly succeeded' using errcode = 'ZX001';
        exception when sqlstate '22023' then null;
        end;
      end
      $test$;
    `);

    expect(faqState()).toEqual({
      name: "FAQ atualizada",
      source_metadata: { marker: "updated" },
      questions: ["Pergunta nova"],
    });
  });

  it("faz rollback completo se a inserção de um item falha após o delete", () => {
    sql(`
      create or replace function public.fn_test_knowledge_source_fail_faq_insert()
      returns trigger language plpgsql as $test$
      begin
        if new.question = '${INSERT_FAILURE}' then
          raise exception 'injected FAQ insert failure' using errcode = '23514';
        end if;
        return new;
      end
      $test$;
      drop trigger if exists trg_test_knowledge_source_fail_faq_insert on public.ai_faq_items;
      create trigger trg_test_knowledge_source_fail_faq_insert
        before insert on public.ai_faq_items
        for each row execute function public.fn_test_knowledge_source_fail_faq_insert();
      do $test$
      begin
        begin
          perform public.fn_update_ai_knowledge_source_atomic(
            '${SOURCE}', '${GOV_ORG}',
            '{"name":"não pode persistir","source_metadata":{"marker":"rollback"},"items":[{"question":"${INSERT_FAILURE}","answer":"valid"}]}'::jsonb
          );
          raise exception 'failure injection unexpectedly succeeded' using errcode = 'ZX002';
        exception when sqlstate '23514' then null;
        end;
      end
      $test$;
      drop trigger trg_test_knowledge_source_fail_faq_insert on public.ai_faq_items;
      drop function public.fn_test_knowledge_source_fail_faq_insert();
    `);

    expect(faqState()).toEqual({
      name: "FAQ atualizada",
      source_metadata: { marker: "updated" },
      questions: ["Pergunta nova"],
    });
  });

  it("não permite usar a RPC com organization_id de outro tenant", () => {
    sql(`
      do $test$
      begin
        begin
          perform public.fn_update_ai_knowledge_source_atomic(
            '${SOURCE}', 'dddddddd-0000-4000-8000-000000000001', '{"name":"cross tenant"}'::jsonb
          );
          raise exception 'cross-tenant update unexpectedly succeeded' using errcode = 'ZX003';
        exception when sqlstate 'P0002' then null;
        end;
      end
      $test$;
    `);

    expect(faqState().name).toBe("FAQ atualizada");
  });

  it("só service_role tem EXECUTE direto na função privilegiada", () => {
    const grants = JSON.parse(
      sql(`select json_build_object(
        'anon', has_function_privilege('anon', 'public.fn_update_ai_knowledge_source_atomic(uuid,uuid,jsonb)', 'EXECUTE'),
        'authenticated', has_function_privilege('authenticated', 'public.fn_update_ai_knowledge_source_atomic(uuid,uuid,jsonb)', 'EXECUTE'),
        'service_role', has_function_privilege('service_role', 'public.fn_update_ai_knowledge_source_atomic(uuid,uuid,jsonb)', 'EXECUTE')
      )::text;`),
    ) as { anon: boolean; authenticated: boolean; service_role: boolean };

    expect(grants).toEqual({ anon: false, authenticated: false, service_role: true });
  });
});
