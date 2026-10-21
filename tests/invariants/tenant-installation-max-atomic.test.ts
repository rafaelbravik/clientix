import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { sql } from "./gov-helpers";

const container = process.env.TEST_DB_CONTAINER;
if (!container) {
  throw new Error("TEST_DB_CONTAINER ausente — rode este invariante por `pnpm test:db`.");
}

const INSTALLATION_ID = "inst_00000000-0000-4000-8000-000000000001";

type ResultadoRpc = { codigo: number; stdout: string; stderr: string };

function rpcSignup(userId: string, slug: string, maxTenants: number): Promise<ResultadoRpc> {
  const script = [
    "begin;",
    "set local role service_role;",
    `select public.fn_provision_signup_tenant_limited('${userId}', '${slug}', 'Tenant ${slug}', '${INSTALLATION_ID}', ${maxTenants});`,
    "commit;",
  ].join("\n");

  return new Promise((resolve, reject) => {
    const child = spawn(
      "docker",
      ["exec", "-i", container!, "psql", "-X", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-q", "-tA", "-f", "-"],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (codigo) => resolve({ codigo: codigo ?? 1, stdout, stderr }));
    child.stdin.end(script);
  });
}

function inserirUsuarios(ids: string[]) {
  const values = ids
    .map((id, index) => `('${id}', 'r2-atomic-${index}-${id.slice(0, 8)}@invariant.test')`)
    .join(",\n");
  sql(`insert into auth.users(id, email) values ${values} on conflict (id) do nothing;`);
}

describe("enforcement atômico do limite max_tenants da instalação", () => {
  it("fecha INSERT direto e expõe apenas as RPCs limitadas ao service_role", () => {
    expect(
      sql(`
        select (
          not has_table_privilege('anon', 'public.organizations', 'INSERT')
          and not has_table_privilege('authenticated', 'public.organizations', 'INSERT')
          and not has_table_privilege('service_role', 'public.organizations', 'INSERT')
          and has_function_privilege('service_role', 'public.fn_provision_signup_tenant_limited(uuid,text,text,text,bigint)', 'EXECUTE')
          and has_function_privilege('service_role', 'public.fn_provision_external_tenant_limited(uuid,text,text,text,text,text,bigint)', 'EXECUTE')
          and has_function_privilege('service_role', 'public.fn_create_tenant_with_owner_limited(uuid,uuid,jsonb,text,text,bigint)', 'EXECUTE')
          and not has_function_privilege('service_role', 'public.fn_lock_installation_tenant_creation(text)', 'EXECUTE')
          and not has_function_privilege('service_role', 'public.fn_assert_installation_tenant_capacity(bigint)', 'EXECUTE')
          and not has_function_privilege('service_role', 'public.fn_create_tenant_with_owner(uuid,uuid,jsonb,text)', 'EXECUTE')
        );
      `),
    ).toBe("t");

    expect(
      sql(`
        begin;
        set local role service_role;
        do $$ begin
          begin
            insert into public.organizations(slug, display_name, legal_name)
            values ('r2-direct-insert-denied', 'Denied', 'Denied');
            raise exception 'DIRECT_ORGANIZATION_INSERT_WAS_ALLOWED';
          exception when insufficient_privilege then
            if sqlerrm = 'DIRECT_ORGANIZATION_INSERT_WAS_ALLOWED' then raise; end if;
          end;
        end $$;
        rollback;
        select 'direct-insert-denied';
      `),
    ).toContain("direct-insert-denied");
  });

  it("usa todas as linhas de organizations e respeita o limite exato, downgrade e upgrade", () => {
    const ownerA = randomUUID();
    const ownerB = randomUUID();
    inserirUsuarios([ownerA, ownerB]);

    expect(
      sql(`
        begin;
        insert into public.organizations(slug, display_name, legal_name, status, redacted_at)
        values ('r2-archived-counts', 'Archived', 'Archived', 'archived', now());
        set local role service_role;
        do $$ declare actual text; begin
          begin
            perform public.fn_provision_signup_tenant_limited(
              '${ownerA}', 'r2-exact-limit-denied', 'Denied', '${INSTALLATION_ID}', 1
            );
            raise exception 'LIMIT_WAS_EXCEEDED';
          exception when sqlstate 'P0001' then
            get stacked diagnostics actual = message_text;
            if actual <> 'GLOBAL_TENANT_LIMIT_REACHED' then raise; end if;
          end;
        end $$;
        rollback;
        select 'exact-limit-and-archived-count';
      `),
    ).toContain("exact-limit-and-archived-count");

    expect(
      sql(`
        begin;
        insert into public.organizations(slug, display_name, legal_name)
        values ('r2-one-existing', 'Existing', 'Existing');
        set local role service_role;
        select public.fn_provision_signup_tenant_limited(
          '${ownerA}', 'r2-second-at-limit', 'Second', '${INSTALLATION_ID}', 2
        );
        do $$ declare actual text; begin
          begin
            perform public.fn_provision_signup_tenant_limited(
              '${ownerB}', 'r2-third-at-limit', 'Third', '${INSTALLATION_ID}', 2
            );
            raise exception 'LIMIT_WAS_EXCEEDED';
          exception when sqlstate 'P0001' then
            get stacked diagnostics actual = message_text;
            if actual <> 'GLOBAL_TENANT_LIMIT_REACHED' then raise; end if;
          end;
          if (select count(*) from public.organizations) <> 2 then raise exception 'COUNT_NOT_AT_LIMIT'; end if;
        end $$;
        rollback;
        select 'below-limit-upgrade-and-downgrade';
      `),
    ).toContain("below-limit-upgrade-and-downgrade");
  });

  it("trata null como ilimitado e rejeita limite zero", () => {
    const users = [randomUUID(), randomUUID()];
    inserirUsuarios(users);
    expect(
      sql(`
        begin;
        set local role service_role;
        select public.fn_provision_signup_tenant_limited('${users[0]}', 'r2-unlimited-a', 'A', '${INSTALLATION_ID}', null);
        select public.fn_provision_signup_tenant_limited('${users[1]}', 'r2-unlimited-b', 'B', '${INSTALLATION_ID}', null);
        do $$ begin
          begin
            perform public.fn_provision_signup_tenant_limited('${randomUUID()}', 'r2-zero', 'Zero', '${INSTALLATION_ID}', 0);
            raise exception 'ZERO_LIMIT_WAS_ALLOWED';
          exception when invalid_parameter_value then null;
          end;
          if (select count(*) from public.organizations) <> 2 then raise exception 'UNLIMITED_COUNT_MISMATCH'; end if;
        end $$;
        rollback;
        select 'null-unlimited-zero-invalid';
      `),
    ).toContain("null-unlimited-zero-invalid");
  });

  it("reverte organização se o vínculo falhar dentro da criação transacional", () => {
    const owner = randomUUID();
    const slug = `r2-atomic-rollback-${owner.slice(0, 8)}`;
    inserirUsuarios([owner]);

    expect(
      sql(`
        begin;
        create function public.r2_test_fail_tenant_membership() returns trigger
        language plpgsql as $$
        begin
          if new.user_id = '${owner}'::uuid then
            raise exception 'R2_TEST_MEMBERSHIP_FAILURE' using errcode = '23514';
          end if;
          return new;
        end $$;
        create trigger r2_test_fail_tenant_membership
          before insert on public.user_organizations
          for each row execute function public.r2_test_fail_tenant_membership();
        set local role service_role;
        do $$ declare actual text; begin
          begin
            perform public.fn_provision_signup_tenant_limited(
              '${owner}', '${slug}', 'Rollback', '${INSTALLATION_ID}', null
            );
            raise exception 'EXPECTED_MEMBERSHIP_FAILURE_NOT_RAISED';
          exception when sqlstate '23514' then
            get stacked diagnostics actual = message_text;
            if actual <> 'R2_TEST_MEMBERSHIP_FAILURE' then raise; end if;
          end;
        end $$;
        reset role;
        do $$ begin
          if exists (select 1 from public.organizations where slug = '${slug}') then
            raise exception 'PARTIAL_ORGANIZATION_SURVIVED_MEMBERSHIP_FAILURE';
          end if;
          if exists (
            select 1 from public.user_organizations where user_id = '${owner}'::uuid
          ) then raise exception 'PARTIAL_MEMBERSHIP_SURVIVED'; end if;
        end $$;
        rollback;
        select 'membership-failure-rolls-back-tenant';
      `),
    ).toContain("membership-failure-rolls-back-tenant");
  });

  it("em 20 rodadas paralelas de 10 chamadas nunca excede o limite", async () => {
    const initial = Number(sql("select count(*) from public.organizations;"));
    const attempts = 10;
    const rounds = 20;
    const ids = Array.from({ length: attempts * rounds }, () => randomUUID());
    inserirUsuarios(ids);

    let expectedCount = initial;
    for (let round = 0; round < rounds; round += 1) {
      const maxTenants = expectedCount + 1;
      const batch = await Promise.all(
        ids.slice(round * attempts, (round + 1) * attempts).map((userId, index) =>
          rpcSignup(userId!, `r2-atomic-${round}-${index}-${userId!.slice(0, 8)}`, maxTenants),
        ),
      );
      const succeeded = batch.filter((result) => result.codigo === 0);
      const denied = batch.filter(
        (result) => result.codigo !== 0 && result.stderr.includes("GLOBAL_TENANT_LIMIT_REACHED"),
      );
      expect(succeeded, `round ${round + 1}: devia haver uma criação vencedora`).toHaveLength(1);
      expect(denied, `round ${round + 1}: as demais chamadas devem receber erro canônico`).toHaveLength(9);
      expect(batch.filter((result) => result.codigo !== 0 && !result.stderr.includes("GLOBAL_TENANT_LIMIT_REACHED")))
        .toEqual([]);
      expectedCount += 1;
      expect(Number(sql("select count(*) from public.organizations;"))).toBe(expectedCount);
    }

    expect(Number(sql("select count(*) from public.organizations;"))).toBe(initial + rounds);
  }, 180_000);
});
