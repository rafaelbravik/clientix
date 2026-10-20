import { randomUUID } from "node:crypto";

import pg from "pg";
import { afterAll, describe, expect, it } from "vitest";

import {
  claimJobs,
  enqueueJob,
  failJob,
  reapExpiredJobs,
  settleUnexpectedClaimExit,
} from "@/lib/agent-engine/queue/queue";
import { deferJobForLicenseRejection } from "@/workers/agent-worker/license-settlement";

const container = process.env.TEST_DB_CONTAINER;
if (!container) throw new Error("TEST_DB_CONTAINER not set — rode via `pnpm test:db`");
const port = Number(process.env.TEST_DB_PORT ?? 54329);
const workerPassword = process.env.TEST_AGENT_WORKER_PASSWORD;
if (!workerPassword) throw new Error("TEST_AGENT_WORKER_PASSWORD not set — rode via `pnpm test:db`");

const adminPool = new pg.Pool({
  connectionString: `postgresql://postgres:postgres@127.0.0.1:${port}/postgres`,
  max: 4,
});
const workerPool = new pg.Pool({
  connectionString: `postgresql://agent_worker:${encodeURIComponent(workerPassword)}@127.0.0.1:${port}/postgres`,
  max: 4,
});

async function createLaneFixture(): Promise<{ organizationId: string; contactId: string }> {
  const organizationId = randomUUID();
  const contactId = randomUUID();
  const suffix = randomUUID();
  await adminPool.query(
    `insert into public.organizations (id, slug, legal_name, display_name)
     values ($1, $2, 'Worker settlement fixture', 'Worker settlement fixture')`,
    [organizationId, `worker-settlement-${suffix}`],
  );
  await adminPool.query(
    `insert into public.contacts (id, organization_id, name, display_name)
     values ($1, $2, 'Worker settlement contact', 'Worker settlement contact')`,
    [contactId, organizationId],
  );
  return { organizationId, contactId };
}

afterAll(async () => {
  await Promise.all([adminPool.end(), workerPool.end()]);
});

describe("claim do worker: settlement e liberação da lane", () => {
  it("rejeição de licença libera a lane sem consumir tentativa", async () => {
    const { organizationId, contactId } = await createLaneFixture();
    const workerId = `license-${randomUUID()}`;
    const jobIds: string[] = [];

    try {
      const first = await enqueueJob(workerPool, organizationId, {
        kind: "inbound_turn",
        leadId: contactId,
        payload: { test_fixture: "license-rejection-settlement" },
      });
      jobIds.push(first.job.id);

      const [claimed] = await claimJobs(workerPool, { workerId, maxConcurrency: 10_000, batchSize: 1 });
      expect(claimed?.id).toBe(first.job.id);
      if (!claimed?.claim_acquired_at) throw new Error("claim sem timestamp de aquisição");

      const settled = await deferJobForLicenseRejection(workerPool, {
        job: claimed,
        workerId,
        acquiredAt: claimed.claim_acquired_at,
        state: "UNKNOWN_KEY",
      });
      expect(settled).toMatchObject({ status: "pending", attempts: 0, locked_by: null, locked_at: null });

      const stored = await adminPool.query<{
        status: string;
        attempts: number;
        last_error: string | null;
        lease_active: boolean;
        recheck_delay_ms: number;
      }>(
        `select status, attempts, last_error,
                (locked_by is not null or locked_at is not null) as lease_active,
                extract(epoch from (run_after - now()))::int * 1000 as recheck_delay_ms
           from public.job_queue where id = $1`,
        [first.job.id],
      );
      expect(stored.rows[0]).toMatchObject({
        status: "pending",
        attempts: 0,
        last_error: "LICENSE_REJECTED:UNKNOWN_KEY",
        lease_active: false,
      });
      expect(stored.rows[0]!.recheck_delay_ms).toBeGreaterThan(55_000);
      expect(stored.rows[0]!.recheck_delay_ms).toBeLessThanOrEqual(60_000);

      const next = await enqueueJob(workerPool, organizationId, {
        kind: "inbound_turn",
        leadId: contactId,
        payload: { test_fixture: "same-lane-after-license-rejection" },
      });
      jobIds.push(next.job.id);
      const [nextClaim] = await claimJobs(workerPool, {
        workerId: `${workerId}-next`,
        maxConcurrency: 10_000,
        batchSize: 1,
      });
      expect(nextClaim?.id).toBe(next.job.id);
      expect(nextClaim?.locked_by).toBe(`${workerId}-next`);
    } finally {
      if (jobIds.length) await adminPool.query("delete from public.job_queue where id = any($1::uuid[])", [jobIds]);
      await adminPool.query("delete from public.organizations where id = $1", [organizationId]);
    }
  }, 30_000);

  it("falha transitória ao ler a licença usa retry com backoff e também libera a lane", async () => {
    const { organizationId, contactId } = await createLaneFixture();
    const workerId = `license-transient-${randomUUID()}`;
    const jobIds: string[] = [];

    try {
      const first = await enqueueJob(workerPool, organizationId, {
        kind: "inbound_turn",
        leadId: contactId,
        payload: { test_fixture: "transient-license-check" },
      });
      jobIds.push(first.job.id);

      const [claimed] = await claimJobs(workerPool, { workerId, maxConcurrency: 10_000, batchSize: 1 });
      expect(claimed?.id).toBe(first.job.id);
      if (!claimed?.claim_acquired_at) throw new Error("claim sem timestamp de aquisição");

      const settled = await failJob(
        workerPool,
        claimed.id,
        workerId,
        new Error("LICENSE_AUTHORITY_UNAVAILABLE"),
        claimed.claim_acquired_at,
      );
      expect(settled).toMatchObject({ status: "pending", attempts: 1, locked_by: null, locked_at: null });

      const stored = await adminPool.query<{
        status: string;
        attempts: number;
        last_error: string | null;
        lease_active: boolean;
        retry_delay_ms: number;
      }>(
        `select status, attempts, last_error,
                (locked_by is not null or locked_at is not null) as lease_active,
                extract(epoch from (run_after - now()))::int * 1000 as retry_delay_ms
           from public.job_queue where id = $1`,
        [claimed.id],
      );
      expect(stored.rows[0]).toMatchObject({
        status: "pending",
        attempts: 1,
        last_error: "LICENSE_AUTHORITY_UNAVAILABLE",
        lease_active: false,
      });
      expect(stored.rows[0]!.retry_delay_ms).toBeGreaterThan(9_000);
      expect(stored.rows[0]!.retry_delay_ms).toBeLessThanOrEqual(10_000);

      const next = await enqueueJob(workerPool, organizationId, {
        kind: "inbound_turn",
        leadId: contactId,
        payload: { test_fixture: "same-lane-after-transient-license-failure" },
      });
      jobIds.push(next.job.id);
      const [nextClaim] = await claimJobs(workerPool, {
        workerId: `${workerId}-next`,
        maxConcurrency: 10_000,
        batchSize: 1,
      });
      expect(nextClaim?.id).toBe(next.job.id);
    } finally {
      if (jobIds.length) await adminPool.query("delete from public.job_queue where id = any($1::uuid[])", [jobIds]);
      await adminPool.query("delete from public.organizations where id = $1", [organizationId]);
    }
  }, 30_000);

  it("worker antigo não liquida o claim que o reaper entregou a outro worker", async () => {
    const { organizationId, contactId } = await createLaneFixture();
    const originalWorker = `old-${randomUUID()}`;
    const newWorker = `new-${randomUUID()}`;
    let jobId: string | undefined;

    try {
      const { job } = await enqueueJob(workerPool, organizationId, {
        kind: "inbound_turn",
        leadId: contactId,
        payload: { test_fixture: "stale-claim-settlement" },
      });
      jobId = job.id;
      const [originalClaim] = await claimJobs(workerPool, {
        workerId: originalWorker,
        maxConcurrency: 10_000,
        batchSize: 1,
      });
      expect(originalClaim?.id).toBe(job.id);
      if (!originalClaim?.claim_acquired_at) throw new Error("claim original sem timestamp de aquisição");

      await adminPool.query(
        `update public.job_queue set locked_at = now() - interval '2 minutes' where id = $1`,
        [job.id],
      );
      await expect(reapExpiredJobs(adminPool, { visibilityTimeoutMs: 1 })).resolves.toMatchObject({ revived: 1 });

      const [newClaim] = await claimJobs(workerPool, {
        workerId: newWorker,
        maxConcurrency: 10_000,
        batchSize: 1,
      });
      expect(newClaim?.id).toBe(job.id);
      expect(newClaim?.locked_by).toBe(newWorker);

      await expect(
        settleUnexpectedClaimExit(workerPool, {
          jobId: job.id,
          workerId: originalWorker,
          acquiredAt: originalClaim.claim_acquired_at,
          reason: new Error("late completion from stale worker"),
        }),
      ).resolves.toBe("already-settled-or-reclaimed");

      const current = await adminPool.query(
        "select status, locked_by, attempts from public.job_queue where id = $1",
        [job.id],
      );
      expect(current.rows[0]).toMatchObject({ status: "running", locked_by: newWorker, attempts: 2 });
    } finally {
      if (jobId) await adminPool.query("delete from public.job_queue where id = $1", [jobId]);
      await adminPool.query("delete from public.organizations where id = $1", [organizationId]);
    }
  }, 30_000);
});
