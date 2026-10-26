import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";

/**
 * Prova no banco de produto que o claim do scheduler não volta a acordar uma
 * inscrição cancelada manualmente enquanto esperava o próximo horário.
 */

if (!process.env.TEST_DB_CONTAINER) {
  throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
}

const PORT = Number(process.env.TEST_DB_PORT ?? 54329);
const pool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${PORT}/postgres`,
  max: 2,
});

const ORG = "a0a0a0a0-0000-4000-8000-000000000001";
let enrollmentId = "";

beforeAll(async () => {
  await pool.query(
    `insert into organizations (id, slug, legal_name, display_name)
     values ($1, 'followup-dormant-cancel', 'Follow-up Dormant Cancel', 'Follow-up Dormant Cancel')`,
    [ORG],
  );
  const { rows: contacts } = await pool.query<{ id: string }>(
    `insert into contacts (organization_id, display_name)
     values ($1, 'Contato de teste do follow-up') returning id`,
    [ORG],
  );
  const { rows: versions } = await pool.query<{ id: string }>(
    `insert into followup_flow_versions (organization_id, graph) values ($1, '{}'::jsonb) returning id`,
    [ORG],
  );
  const { rows: pointers } = await pool.query<{ id: string }>(
    `insert into followup_flow_pointers (organization_id, name, status, active_version_id)
     values ($1, 'Fluxo de retorno', 'active', $2) returning id`,
    [ORG, versions[0]!.id],
  );
  const { rows: enrollments } = await pool.query<{ id: string }>(
    `insert into followup_enrollments
       (organization_id, pointer_id, version_id, contact_id, current_node_id, status, next_eval_at)
     values ($1, $2, $3, $4, 'wait-return', 'active', now() - interval '1 second')
     returning id`,
    [ORG, pointers[0]!.id, versions[0]!.id, contacts[0]!.id],
  );
  enrollmentId = enrollments[0]!.id;
  await pool.query(
    `update followup_enrollments
        set status = 'cancelled', cancel_reason = 'manual', next_eval_at = null,
            claimed_until = null, completed_at = now(), updated_at = now()
      where id = $1 and organization_id = $2`,
    [enrollmentId, ORG],
  );
});

afterAll(async () => {
  await pool.end();
});

describe("follow-up dormente cancelado — claim do scheduler", () => {
  it("não reclama nem reativa a inscrição cancelada e mantém o relógio removido", async () => {
    const { rows: claimed } = await pool.query<{ id: string }>(
      `select id from fn_claim_due_followup_enrollments($1, $2)`,
      [5, 120],
    );
    const { rows } = await pool.query<{
      status: string;
      cancel_reason: string | null;
      next_eval_at: Date | null;
      claimed_until: Date | null;
    }>(
      `select status, cancel_reason, next_eval_at, claimed_until
         from followup_enrollments where id = $1 and organization_id = $2`,
      [enrollmentId, ORG],
    );

    expect(claimed.map(({ id }) => id)).not.toContain(enrollmentId);
    expect(rows[0]).toMatchObject({ status: "cancelled", cancel_reason: "manual" });
    expect(rows[0]?.next_eval_at).toBeNull();
    expect(rows[0]?.claimed_until).toBeNull();
  });
});
