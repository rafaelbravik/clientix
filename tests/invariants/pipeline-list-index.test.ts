import { afterAll, expect, it } from "vitest";
import pg from "pg";

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db` (scripts/test-db.sh)");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 1,
});

afterAll(async () => pool.end());

it("o baseline inclui o índice ordenado da Lista do funil", async () => {
  const { rows } = await pool.query<{ indexdef: string; comment: string | null }>(`
    select pg_get_indexdef(indexrelid) as indexdef,
           obj_description(indexrelid, 'pg_class') as comment
      from pg_index
     where indexrelid = to_regclass('public.idx_crm_leads_org_pipeline_position_id')
  `);

  expect(rows, "índice da paginação não chegou ao baseline").toHaveLength(1);
  expect(rows[0]!.indexdef).toMatch(
    /\(organization_id, pipeline_id, position_in_stage, id\)$/,
  );
  expect(rows[0]!.comment).toContain("ordem da consulta");
});
