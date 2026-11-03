import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";
import { sql } from "./gov-helpers";

const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${process.env.TEST_DB_PORT}/postgres`,
});

afterAll(() => pool.end());

describe("first-run e propriedade global da plataforma", () => {
  it("mantém singleton, catálogo e funções globais fora do acesso do tenant", () => {
    const result = sql(`
      select
        (select count(*) = 1 from public.platform_settings where id = 1)::text,
        (select count(*) = 3 from public.platform_plan_catalog)::text,
        has_function_privilege('anon', 'public.fn_platform_initialized()', 'EXECUTE')::text,
        (select prosecdef from pg_proc where oid = 'public.fn_platform_initialized()'::regprocedure)::text,
        (select prosecdef from pg_proc where oid = 'platform_internal.fn_platform_initialized()'::regprocedure)::text,
        has_table_privilege('anon', 'public.platform_settings', 'SELECT')::text,
        has_column_privilege('anon', 'public.platform_settings', 'initialized_at', 'SELECT')::text,
        has_column_privilege('anon', 'public.platform_settings', 'setup_claim_id', 'SELECT')::text,
        (select count(*) = 0 from pg_policies where schemaname = 'public' and tablename = 'platform_settings' and policyname = 'platform_settings_setup_status_anon')::text,
        has_function_privilege('anon', 'platform_internal.fn_platform_initialized()', 'EXECUTE')::text,
        has_function_privilege('anon', 'public.fn_reserve_platform_setup(uuid)', 'EXECUTE')::text,
        has_function_privilege('authenticated', 'public.fn_finalize_platform_setup(uuid,uuid,text,text)', 'EXECUTE')::text,
        has_function_privilege('authenticated', 'public.fn_platform_manage_org_member(uuid,uuid,uuid,text,text,text)', 'EXECUTE')::text,
        has_function_privilege('service_role', 'public.fn_platform_manage_org_member(uuid,uuid,uuid,text,text,text)', 'EXECUTE')::text,
        has_function_privilege('anon', 'public.fn_platform_manage_global_admin(uuid,uuid,text,text,boolean,text,text)', 'EXECUTE')::text,
        has_function_privilege('service_role', 'public.fn_platform_manage_global_admin(uuid,uuid,text,text,boolean,text,text)', 'EXECUTE')::text,
        has_table_privilege('anon', 'public.platform_plan_catalog', 'SELECT')::text,
        has_table_privilege('authenticated', 'public.platform_admins', 'INSERT')::text,
        has_table_privilege('authenticated', 'public.platform_settings', 'UPDATE')::text,
        (select count(*) = 0 from public.platform_admins where platform_role = 'owner')::text;
    `);
    expect(result).toBe("true|true|true|false|true|false|false|false|true|true|false|false|false|true|false|true|false|false|false|true");
  });

  it("expõe ao anon somente o booleano, sem permissão de leitura do singleton", () => {
    const result = sql(`set role anon; select public.fn_platform_initialized()::text; reset role;`);
    expect(result.split(/\r?\n/).filter((line) => line === "true" || line === "false")).toHaveLength(1);
  });

  it("aplica o provider do instalador na mesma transação de criação da organização", () => {
    const actor = randomUUID();
    const key = randomUUID();
    const slug = `provider-${actor.slice(0, 8)}`;
    const email = `provider-${actor.slice(0, 8)}@invariant.test`;
    const result = sql(`
      begin;
      insert into auth.users (id, email) values ('${actor}', '${email}');
      insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason, platform_role)
      values ('${actor}', '${actor}', 'full', false, 'fixture de invariante', 'admin');
      update public.platform_plan_catalog set active = false where slug = 'standard';
      do $test$
      begin
        perform public.fn_create_tenant_with_owner_limited(
          '${actor}'::uuid,
          '${key}'::uuid,
          '{"display_name":"Inactive Plan Test","slug":"inactive-${actor.slice(0, 8)}","owner_email":"${email}","plan":"standard"}'::jsonb,
          repeat('a', 64),
          'inst_00000000-0000-4000-8000-000000000001',
          100
        );
        raise exception 'inactive plan was accepted';
      exception when invalid_parameter_value then
        null;
      end
      $test$;
      update public.platform_plan_catalog set active = true where slug = 'standard';
      select public.fn_create_tenant_with_owner_limited(
        '${actor}'::uuid,
        '${key}'::uuid,
        '{"display_name":"Provider Test","slug":"${slug}","owner_email":"${email}","plan":"standard","default_llm_provider":"openrouter"}'::jsonb,
        repeat('a', 64),
        'inst_00000000-0000-4000-8000-000000000001',
        100
      )->>'created';
      select settings->'llm'->>'provider' from public.organizations where slug = '${slug}';
      rollback;
    `);
    const values = result.split(/\r?\n/).filter((line) => line === "true" || line === "openrouter");
    expect(values).toEqual(["true", "openrouter"]);
  });

  it("duas reservas simultâneas de first-run não podem vencer", async () => {
    const claim1 = randomUUID();
    const claim2 = randomUUID();
    sql(`
      update public.platform_settings
         set initialized_at = null, initialized_by = null,
             setup_claim_id = null, setup_claimed_at = null
       where id = 1;
      delete from public.platform_admins where platform_role <> 'owner';
    `);

    const [first, second] = await Promise.all([
      pool.query<{ reserved: boolean }>("select public.fn_reserve_platform_setup($1::uuid) as reserved", [claim1]),
      pool.query<{ reserved: boolean }>("select public.fn_reserve_platform_setup($1::uuid) as reserved", [claim2]),
    ]);
    const outcomes = [first.rows[0]?.reserved, second.rows[0]?.reserved].sort();
    expect(outcomes).toEqual([false, true]);

    sql(`
      update public.platform_settings
         set setup_claim_id = null, setup_claimed_at = null
       where id = 1 and initialized_at is null;
    `);
  });

  it("papel de organização não concede autoridade global de plataforma", () => {
    const userId = randomUUID();
    const organizationId = randomUUID();
    const result = sql(`
      begin;
      insert into auth.users (id, email)
      values ('${userId}', 'tenant-admin-invariant@deskcomm.test');
      insert into public.organizations (id, slug, display_name, legal_name)
      values ('${organizationId}', 'tenant-admin-invariant', 'Tenant Admin Test', 'Tenant Admin Test');
      insert into public.user_organizations (organization_id, user_id, role, accepted_at)
      values ('${organizationId}', '${userId}', 'admin', clock_timestamp());
      select set_config('request.jwt.claim.sub', '${userId}', true);
      select public.fn_is_platform_admin()::text;
      insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
      values ('${userId}', '${userId}', 'full', false, 'fixture de invariante');
      select public.fn_is_platform_admin()::text;
      rollback;
    `);
    const booleans = result.trim().split(/\r?\n/).filter((line) => line === "true" || line === "false");
    expect(booleans).toEqual(["false", "true"]);
  });

  it("admin global convida e altera vínculo sem transferir autoridade para o papel de tenant", () => {
    const platformAdminId = randomUUID();
    const tenantAdminId = randomUUID();
    const targetId = randomUUID();
    const otherAdminId = randomUUID();
    const organizationId = randomUUID();
    const result = sql(`
      begin;
      insert into auth.users (id, email) values
        ('${platformAdminId}', 'global-admin@deskcomm.test'),
        ('${tenantAdminId}', 'tenant-admin@deskcomm.test'),
        ('${targetId}', 'member-target@deskcomm.test'),
        ('${otherAdminId}', 'member-other-admin@deskcomm.test');
      insert into public.organizations (id, slug, display_name, legal_name)
      values ('${organizationId}', 'platform-member-invariant', 'Platform Member Test', 'Platform Member Test');
      insert into public.user_organizations (organization_id, user_id, role, accepted_at) values
        ('${organizationId}', '${targetId}', 'admin', clock_timestamp()),
        ('${organizationId}', '${otherAdminId}', 'admin', clock_timestamp()),
        ('${organizationId}', '${tenantAdminId}', 'agent', clock_timestamp());
      insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason)
      values ('${platformAdminId}', '${platformAdminId}', 'full', false, 'fixture de invariante');
      select public.fn_platform_manage_org_member(
        '${platformAdminId}', '${organizationId}', '${targetId}', 'change_role', 'viewer',
        '00000000-0000-4000-8000-000000000002'
      )->>'role';
      select public.fn_platform_manage_org_member(
        '${platformAdminId}', '${organizationId}', '${targetId}', 'revoke', null,
        '00000000-0000-4000-8000-000000000003'
      )->>'revoked_at' is not null;
      do $test$
      begin
        perform public.fn_platform_manage_org_member(
          '${platformAdminId}', '${organizationId}', '${otherAdminId}', 'revoke', null,
          '00000000-0000-4000-8000-000000000004'
        );
        raise exception 'last organization admin revocation was accepted';
      exception when check_violation then
        null;
      end
      $test$;
      do $test$
      begin
        perform public.fn_platform_manage_org_member(
          '${tenantAdminId}', '${organizationId}', '${otherAdminId}', 'change_role', 'viewer',
          '00000000-0000-4000-8000-000000000005'
        );
        raise exception 'tenant admin was accepted as global actor';
      exception when insufficient_privilege then
        null;
      end
      $test$;
      select (role = 'admin' and revoked_at is null)::text
        from public.user_organizations
       where organization_id = '${organizationId}' and user_id = '${otherAdminId}';
      select count(*) = 2
        from public.api_audit_log
       where organization_id = '${organizationId}'
         and action in ('platform_admin.member_role_changed', 'platform_admin.member_revoked');
      rollback;
    `);
    const values = result.trim().split(/\r?\n/);
    expect(values).toContain("viewer");
    expect(values).toContain("true");
  });

  it("finaliza owner e auditoria na mesma transação e protege o último owner ativo", () => {
    const userId = randomUUID();
    const claimId = randomUUID();
    const outcome = sql(`
      begin;
      update public.platform_settings
         set initialized_at = null, initialized_by = null,
             setup_claim_id = null, setup_claimed_at = null
       where id = 1;
      delete from public.platform_admins where platform_role <> 'owner';
      delete from auth.users where id = '${userId}';
      insert into auth.users (id, email)
      values ('${userId}', 'platform-owner-invariant@deskcomm.test');
      select public.fn_reserve_platform_setup('${claimId}'::uuid);
      select public.fn_finalize_platform_setup('${claimId}'::uuid, '${userId}'::uuid, 'Teste', '00000000-0000-4000-8000-000000000001');
      select pa.platform_role || '|' || (s.initialized_by = pa.user_id)::text || '|' ||
             (select count(*) = 1 from public.api_audit_log where action = 'platform_initialized' and resource_id = pa.user_id)::text
        from public.platform_admins pa
        join public.platform_settings s on s.id = 1
       where pa.user_id = '${userId}' and pa.revoked_at is null;
      do $test$
      begin
        update public.platform_admins set platform_role = 'admin' where user_id = '${userId}';
        raise exception 'last owner demotion was accepted';
      exception when check_violation then
        null;
      end
      $test$;
      do $test$
      begin
        update auth.users set banned_until = clock_timestamp() + interval '1 day' where id = '${userId}';
        raise exception 'last owner ban was accepted';
      exception when check_violation then
        null;
      end
      $test$;
      do $test$
      begin
        delete from auth.users where id = '${userId}';
        raise exception 'last owner deletion was accepted';
      exception when check_violation then
        null;
      end
      $test$;
      select (platform_role = 'owner' and revoked_at is null)::text
        from public.platform_admins where user_id = '${userId}';
      rollback;
    `);
    expect(outcome).toContain("owner|true|true");
    const booleans = outcome.trim().split(/\r?\n/).filter((line) => line === "true" || line === "false");
    expect(booleans.at(-1)).toBe("true");
  });

  it("owner concede e revoga admin global com escopo auditado; admin delegado não concede grants", () => {
    const ownerId = randomUUID();
    const delegatedAdminId = randomUUID();
    const targetId = randomUUID();
    const result = sql(`
      begin;
      insert into auth.users (id, email) values
        ('${ownerId}', 'owner-grants@deskcomm.test'),
        ('${delegatedAdminId}', 'delegated-grants@deskcomm.test'),
        ('${targetId}', 'target-grants@deskcomm.test');
      insert into public.platform_admins (user_id, granted_by, scope, mfa_required, reason, platform_role) values
        ('${ownerId}', '${ownerId}', 'full', false, 'owner fixture', 'owner'),
        ('${delegatedAdminId}', '${ownerId}', 'full', true, 'admin fixture', 'admin');
      select public.fn_platform_manage_global_admin(
        '${ownerId}', '${targetId}', 'grant', 'support_readonly', true,
        'Apoio operacional', '00000000-0000-4000-8000-000000000006'
      )->>'scope';
      do $test$
      begin
        perform public.fn_platform_manage_global_admin(
          '${delegatedAdminId}', '${targetId}', 'revoke', null, true, null,
          '00000000-0000-4000-8000-000000000007'
        );
        raise exception 'delegated platform admin was accepted as owner';
      exception when insufficient_privilege then
        null;
      end
      $test$;
      select public.fn_platform_manage_global_admin(
        '${ownerId}', '${targetId}', 'revoke', null, true, 'Encerramento',
        '00000000-0000-4000-8000-000000000008'
      )->>'revoked_at' is not null;
      select count(*) = 2
        from public.api_audit_log
       where resource_id = '${targetId}'
         and action in ('platform_admin.global_admin_granted', 'platform_admin.global_admin_revoked');
      select (platform_role = 'admin' and scope = 'support_readonly' and revoked_at is not null)::text
        from public.platform_admins where user_id = '${targetId}';
      rollback;
    `);
    expect(result).toContain("support_readonly");
    const values = result.trim().split(/\r?\n/);
    expect(values).toContain("true");
  });
});
