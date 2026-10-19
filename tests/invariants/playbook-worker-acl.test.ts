import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

import { afterAll, describe, expect, it } from "vitest";
import pg from "pg";

import { loadPlaybook } from "@/lib/agent-engine/agent/playbook";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
const containerName: string = container;
const port = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
  max: 2,
});

function sql(script: string): string {
  return execFileSync(
    "docker",
    ["exec", "-i", containerName, "psql", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-tA", "-f", "-"],
    { input: script, encoding: "utf8" },
  ).trim();
}

afterAll(async () => {
  await pool.end();
});

describe("ACL do worker para playbooks", () => {
  it("service_role tem somente SELECT/INSERT nos objetos usados pelo worker", () => {
    const privileges = sql(`
      select
        has_table_privilege('service_role', 'public.playbook_versions', 'SELECT')::text || ',' ||
        has_table_privilege('service_role', 'public.playbook_versions', 'INSERT')::text || ',' ||
        has_table_privilege('service_role', 'public.playbook_versions', 'UPDATE')::text || ',' ||
        has_table_privilege('service_role', 'public.playbook_versions', 'DELETE')::text || ',' ||
        has_table_privilege('service_role', 'public.playbook_versions', 'TRUNCATE')::text || ',' ||
        has_table_privilege('service_role', 'public.playbook_pointers', 'SELECT')::text || ',' ||
        has_table_privilege('service_role', 'public.playbook_pointers', 'INSERT')::text || ',' ||
        has_table_privilege('service_role', 'public.playbook_pointers', 'UPDATE')::text || ',' ||
        has_table_privilege('service_role', 'public.playbook_pointers', 'DELETE')::text || ',' ||
        has_table_privilege('service_role', 'public.playbook_pointers', 'TRUNCATE')::text;
    `);

    expect(privileges).toBe("true,true,false,false,false,true,true,false,false,false");
  });

  it("worker escreve a versão/ponteiro necessários e o loader mantém o escopo do tenant", async () => {
    const client = await pool.connect();
    const orgA = randomUUID();
    const orgB = randomUUID();
    const orgWorker = randomUUID();
    const suffix = randomUUID();

    try {
      await client.query("begin");
      await client.query(
        `insert into public.organizations (id, slug, legal_name, display_name)
         values
           ($1, $4 || '-a', 'Playbook A', 'Playbook A'),
           ($2, $4 || '-b', 'Playbook B', 'Playbook B'),
           ($3, $4 || '-worker', 'Playbook Worker', 'Playbook Worker')`,
        [orgA, orgB, orgWorker, `playbook-worker-${suffix}`],
      );

      const platform = await client.query(
        `select 1 from public.playbook_pointers
          where organization_id is null and layer = 'platform' limit 1`,
      );
      if ((platform.rowCount ?? 0) === 0) {
        const version = await client.query<{ id: string }>(
          `insert into public.playbook_versions (organization_id, layer, content)
           values (null, 'platform', '## Platform ACL fixture') returning id`,
        );
        await client.query(
          `insert into public.playbook_pointers (organization_id, layer, version_id)
           values (null, 'platform', $1)`,
          [version.rows[0]?.id],
        );
      }

      for (const [organizationId, marker] of [
        [orgA, "TENANT_A_MARKER"],
        [orgB, "TENANT_B_MARKER"],
      ] as const) {
        const version = await client.query<{ id: string }>(
          `insert into public.playbook_versions (organization_id, layer, content)
           values ($1, 'tenant', $2) returning id`,
          [organizationId, `## ${marker}`],
        );
        await client.query(
          `insert into public.playbook_pointers (organization_id, layer, version_id)
           values ($1, 'tenant', $2)`,
          [organizationId, version.rows[0]?.id],
        );
      }

      await client.query("set local role service_role");
      const workerVersion = await client.query<{ id: string }>(
        `insert into public.playbook_versions (organization_id, layer, content)
         values ($1, 'tenant', '## WORKER_INSERT_MARKER') returning id`,
        [orgWorker],
      );
      await client.query(
        `insert into public.playbook_pointers (organization_id, layer, version_id)
         values ($1, 'tenant', $2)`,
        [orgWorker, workerVersion.rows[0]?.id],
      );

      const tenantA = await loadPlaybook(
        client as unknown as Parameters<typeof loadPlaybook>[0],
        orgA,
      );
      expect(tenantA.prompt).toContain("TENANT_A_MARKER");
      expect(tenantA.prompt).not.toContain("TENANT_B_MARKER");

      const worker = await loadPlaybook(
        client as unknown as Parameters<typeof loadPlaybook>[0],
        orgWorker,
      );
      expect(worker.prompt).toContain("WORKER_INSERT_MARKER");

      await client.query("savepoint deny_playbook_update");
      let updateError: unknown;
      try {
        await client.query("update public.playbook_versions set content = content where false");
      } catch (error) {
        updateError = error;
      }
      expect(updateError).toMatchObject({ code: "42501" });
      await client.query("rollback to savepoint deny_playbook_update");

      await client.query("savepoint deny_playbook_delete");
      let deleteError: unknown;
      try {
        await client.query("delete from public.playbook_versions where false");
      } catch (error) {
        deleteError = error;
      }
      expect(deleteError).toMatchObject({ code: "42501" });
      await client.query("rollback to savepoint deny_playbook_delete");
    } finally {
      await client.query("rollback").catch(() => undefined);
      client.release();
    }
  });
});
