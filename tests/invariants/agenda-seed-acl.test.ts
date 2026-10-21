import { execFileSync } from "node:child_process";

import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
const containerName: string = container;

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

describe("ACL do catálogo de tipos da agenda", () => {
  it("RPC limitada cria a organização e o trigger semeia os três tipos", () => {
    const userId = randomUUID();
    const slug = `agenda-seed-${userId.slice(0, 8)}`;
    const resultado = sql(`
      begin;
      insert into auth.users (id, email)
      values ('${userId}', 'agenda-seed-${userId}@invariant.test')
      on conflict (id) do nothing;
      set local role service_role;
      select public.fn_provision_signup_tenant_limited(
        '${userId}',
        '${slug}',
        'Agenda Seed Service Role',
        'inst_00000000-0000-4000-8000-000000000001',
        null
      );
      select 'ORG_COUNT=' || count(*)::text from public.organizations where slug = '${slug}';
      select 'SEED_COUNT=' || count(*)::text
        from public.calendar_event_types
       where organization_id = (select id from public.organizations where slug = '${slug}');
      rollback;
    `);

    expect(resultado).toContain("ORG_COUNT=1");
    expect(resultado).toContain("SEED_COUNT=3");
  });

  it("concede somente CRUD autenticado e SELECT/INSERT/UPDATE de service_role; anon não acessa", () => {
    const privilegios = sql(`
      select
        has_table_privilege('anon', 'public.calendar_event_types', 'SELECT')::text || ',' ||
        has_table_privilege('anon', 'public.calendar_event_types', 'INSERT')::text || ',' ||
        has_table_privilege('anon', 'public.calendar_event_types', 'UPDATE')::text || ',' ||
        has_table_privilege('anon', 'public.calendar_event_types', 'DELETE')::text || '|' ||
        has_table_privilege('authenticated', 'public.calendar_event_types', 'SELECT')::text || ',' ||
        has_table_privilege('authenticated', 'public.calendar_event_types', 'INSERT')::text || ',' ||
        has_table_privilege('authenticated', 'public.calendar_event_types', 'UPDATE')::text || ',' ||
        has_table_privilege('authenticated', 'public.calendar_event_types', 'DELETE')::text || ',' ||
        has_table_privilege('authenticated', 'public.calendar_event_types', 'TRUNCATE')::text || '|' ||
        has_table_privilege('service_role', 'public.calendar_event_types', 'SELECT')::text || ',' ||
        has_table_privilege('service_role', 'public.calendar_event_types', 'INSERT')::text || ',' ||
        has_table_privilege('service_role', 'public.calendar_event_types', 'UPDATE')::text || ',' ||
        has_table_privilege('service_role', 'public.calendar_event_types', 'DELETE')::text || ',' ||
        has_table_privilege('service_role', 'public.calendar_event_types', 'TRUNCATE')::text || ',' ||
        has_table_privilege('service_role', 'public.calendar_event_types', 'REFERENCES')::text || ',' ||
        has_table_privilege('service_role', 'public.calendar_event_types', 'TRIGGER')::text;
    `);

    expect(privilegios).toBe("false,false,false,false|true,true,true,true,false|true,true,true,false,false,false,false");
  });

  it("mantém a seed SECURITY INVOKER com search_path restrito", () => {
    const definicao = sql(`
      select p.prosecdef::text || '|' || (p.proconfig @> array['search_path=public, pg_temp']::text[])::text
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public'
         and p.proname = 'fn_semear_tipos_de_agendamento'
         and pg_get_function_identity_arguments(p.oid) = 'p_organization_id uuid';
    `);

    expect(definicao).toBe("false|true");
  });
});
