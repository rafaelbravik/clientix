import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";
import { motivoDoErro } from "./psql-transporte";

function erroSob(papel: "anon" | "authenticated", comando: string): string | null {
  try {
    sql(`set role ${papel};\n${comando};\nreset role;`);
    return null;
  } catch (err) {
    return motivoDoErro(err);
  }
}

describe("assinaturas comerciais por tenant", () => {
  it("isola a tabela e limita as funções de mutação ao service_role", () => {
    expect(
      sql(`
        select (
          (select relrowsecurity from pg_class where oid = 'public.tenant_plan_subscriptions'::regclass)
          and not has_table_privilege('anon', 'public.tenant_plan_subscriptions', 'SELECT')
          and not has_table_privilege('anon', 'public.tenant_plan_subscriptions', 'INSERT')
          and not has_table_privilege('anon', 'public.tenant_plan_subscriptions', 'UPDATE')
          and not has_table_privilege('anon', 'public.tenant_plan_subscriptions', 'DELETE')
          and not has_table_privilege('authenticated', 'public.tenant_plan_subscriptions', 'SELECT')
          and not has_table_privilege('authenticated', 'public.tenant_plan_subscriptions', 'INSERT')
          and not has_table_privilege('authenticated', 'public.tenant_plan_subscriptions', 'UPDATE')
          and not has_table_privilege('authenticated', 'public.tenant_plan_subscriptions', 'DELETE')
          and has_table_privilege('service_role', 'public.tenant_plan_subscriptions', 'SELECT')
          and has_table_privilege('service_role', 'public.tenant_plan_subscriptions', 'INSERT')
          and has_table_privilege('service_role', 'public.tenant_plan_subscriptions', 'UPDATE')
          and not has_table_privilege('service_role', 'public.tenant_plan_subscriptions', 'DELETE')
          and has_function_privilege('service_role', 'public.fn_platform_set_tenant_plan_subscription(uuid,uuid,text,text,text,bigint,text,timestamptz,timestamptz,timestamptz,boolean)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.fn_platform_set_tenant_plan_subscription(uuid,uuid,text,text,text,bigint,text,timestamptz,timestamptz,timestamptz,boolean)', 'EXECUTE')
          and not has_function_privilege('authenticated', 'public.fn_platform_set_tenant_plan_subscription(uuid,uuid,text,text,text,bigint,text,timestamptz,timestamptz,timestamptz,boolean)', 'EXECUTE')
          and has_function_privilege('service_role', 'public.fn_create_tenant_with_owner_subscription_limited(uuid,uuid,jsonb,text,text,bigint)', 'EXECUTE')
          and not has_function_privilege('anon', 'public.fn_create_tenant_with_owner_subscription_limited(uuid,uuid,jsonb,text,text,bigint)', 'EXECUTE')
        );
      `),
    ).toBe("t");
  });

  it("anon e authenticated recebem permission denied em toda operação direta", () => {
    const consultas = [
      "select * from public.tenant_plan_subscriptions limit 1",
      "insert into public.tenant_plan_subscriptions (organization_id, plan_slug, status, billing_interval, current_period_starts_at, current_period_ends_at) values (gen_random_uuid(), 'standard', 'active', 'monthly', now(), now() + interval '30 days')",
      "update public.tenant_plan_subscriptions set status = 'canceled' where false",
      "delete from public.tenant_plan_subscriptions where false",
    ];

    for (const papel of ["anon", "authenticated"] as const) {
      for (const consulta of consultas) {
        expect(erroSob(papel, consulta), `${papel} executou: ${consulta}`).toContain(
          "permission denied",
        );
      }
    }
  });

  it("atualiza o plano sem perder settings, mantém registro terminal e recusa admin global", () => {
    const owner = randomUUID();
    const admin = randomUUID();
    const organization = randomUUID();
    const suffix = owner.slice(0, 8);
    const output = sql(`
      begin;
      insert into auth.users (id, email) values
        ('${owner}', 'owner-sub-${suffix}@invariant.test'),
        ('${admin}', 'admin-sub-${suffix}@invariant.test');
      insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason, platform_role)
      values
        ('${owner}', '${owner}', 'full', false, 'subscription invariant', 'owner'),
        ('${admin}', '${owner}', 'full', false, 'subscription invariant', 'admin');
      insert into public.organizations (id, slug, legal_name, display_name, settings)
      values (
        '${organization}', 'subscription-${suffix}', 'Subscription Test', 'Subscription Test',
        '{"plan":"standard","plan_limits":{"max_users":7},"test_marker":"preserved"}'::jsonb
      );

      select public.fn_platform_set_tenant_plan_subscription(
        '${owner}', '${organization}', 'pro', 'active', 'monthly', 15900, 'BRL',
        clock_timestamp() - interval '1 minute', clock_timestamp() + interval '30 days', null, false
      )->>'status';
      select public.fn_platform_set_tenant_plan_subscription(
        '${owner}', '${organization}', 'pro', 'canceled', 'monthly', 15900, 'BRL',
        clock_timestamp() - interval '1 minute', clock_timestamp() + interval '30 days', null, false
      )->>'status';
      select public.fn_platform_set_tenant_plan_subscription(
        '${owner}', '${organization}', 'standard', 'active', 'annual', 9900, 'BRL',
        clock_timestamp() - interval '1 minute', clock_timestamp() + interval '365 days', null, false
      )->>'status';

      do $test$
      begin
        begin
          perform public.fn_platform_set_tenant_plan_subscription(
            '${admin}', '${organization}', 'pro', 'active', 'monthly', 15900, 'BRL',
            clock_timestamp() - interval '1 minute', clock_timestamp() + interval '30 days', null, false
          );
          raise exception 'NON_OWNER_CHANGED_SUBSCRIPTION';
        exception when insufficient_privilege then
          null;
        end;
      end
      $test$;

      select
        (select count(*) from public.tenant_plan_subscriptions where organization_id = '${organization}')::text
        || '|' || (select status from public.tenant_plan_subscriptions where organization_id = '${organization}' and status = 'active')
        || '|' || (select plan_slug from public.tenant_plan_subscriptions where organization_id = '${organization}' and status = 'active')
        || '|' || (select settings->>'plan' from public.organizations where id = '${organization}')
        || '|' || (select settings->'plan_limits'->>'max_users' from public.organizations where id = '${organization}')
        || '|' || (select settings->>'test_marker' from public.organizations where id = '${organization}');
      rollback;
    `);

    expect(output).toContain("2|active|standard|standard|7|preserved");
  });
});
