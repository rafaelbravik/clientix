import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { describe, expect, it } from "vitest";

function exigirContainer(): string {
  const container = process.env.TEST_DB_CONTAINER;
  if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
  return container;
}

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", exigirContainer(), "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

describe("SEC-01 — ACL de códigos de recuperação MFA", () => {
  it("anon e authenticated não podem ler hashes nem fazer INSERT/UPDATE/DELETE", () => {
    const privileges = sql(`
      select
        has_table_privilege('anon', 'public.user_recovery_codes', 'SELECT')::text || ',' ||
        has_column_privilege('anon', 'public.user_recovery_codes', 'code_hash', 'SELECT')::text || ',' ||
        has_table_privilege('anon', 'public.user_recovery_codes', 'INSERT')::text || ',' ||
        has_table_privilege('anon', 'public.user_recovery_codes', 'UPDATE')::text || ',' ||
        has_table_privilege('anon', 'public.user_recovery_codes', 'DELETE')::text || '|' ||
        has_table_privilege('authenticated', 'public.user_recovery_codes', 'SELECT')::text || ',' ||
        has_column_privilege('authenticated', 'public.user_recovery_codes', 'code_hash', 'SELECT')::text || ',' ||
        has_table_privilege('authenticated', 'public.user_recovery_codes', 'INSERT')::text || ',' ||
        has_table_privilege('authenticated', 'public.user_recovery_codes', 'UPDATE')::text || ',' ||
        has_table_privilege('authenticated', 'public.user_recovery_codes', 'DELETE')::text;
    `);

    expect(privileges).toBe("false,false,false,false,false|false,false,false,false,false");
  });

  it("service_role consegue inserir, ler, consumir e apagar o código pelo servidor", () => {
    const userId = randomUUID();
    const email = `recovery-acl-${userId}@invariant.test`;
    const resultado = sql(`
      begin;
      insert into auth.users (id, email) values ('${userId}', '${email}') on conflict (id) do nothing;
      set local role service_role;
      insert into public.user_recovery_codes (user_id, code_hash)
      values ('${userId}', decode(repeat('ab', 32), 'hex'));
      select 'READ=' || count(*)::text from public.user_recovery_codes
       where user_id = '${userId}' and code_hash = decode(repeat('ab', 32), 'hex');
      update public.user_recovery_codes set used_at = now() where user_id = '${userId}';
      select 'UPDATED=' || bool_and(used_at is not null)::text
        from public.user_recovery_codes where user_id = '${userId}';
      delete from public.user_recovery_codes where user_id = '${userId}';
      select 'DELETED=' || count(*)::text from public.user_recovery_codes where user_id = '${userId}';
      rollback;
    `);

    expect(resultado).toContain("READ=1");
    expect(resultado).toContain("UPDATED=true");
    expect(resultado).toContain("DELETED=0");
  });
});
