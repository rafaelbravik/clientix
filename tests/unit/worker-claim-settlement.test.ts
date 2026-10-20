import { describe, expect, it, vi } from "vitest";

import type { JobRow, Queryable } from "@/lib/agent-engine/queue/queue";
import { failJob, settleUnexpectedClaimExit } from "@/lib/agent-engine/queue/queue";
import {
  deferJobForLicenseRejection,
  LICENSE_RECHECK_DELAY_MS,
  licenseRejectionDiagnostic,
} from "@/workers/agent-worker/license-settlement";

const CLAIMED_JOB: JobRow = {
  id: "f8bc2be8-614a-4bad-a22a-d377ebbe8530",
  organization_id: "9b5af013-1fad-4e6d-a090-cfc69fc41f70",
  contact_id: "5c71e990-5f92-4e57-9f26-7e96b20fb2a7",
  kind: "inbound_turn",
  source_event_id: null,
  payload: {},
  status: "running",
  priority: 100,
  run_after: new Date("2026-10-20T00:00:00.000Z"),
  attempts: 1,
  max_attempts: 5,
  last_error: null,
  locked_by: "worker-a",
  locked_at: new Date("2026-10-20T12:00:00.123Z"),
  claim_acquired_at: "2026-10-20 12:00:00.123456+00",
  created_at: new Date("2026-10-20T12:00:00.000Z"),
};

function queryable(results: unknown[], failures: unknown[] = []): Queryable {
  const query = vi.fn(async () => {
    if (results.length) return results.shift() as never;
    const failure = failures.shift();
    if (failure !== undefined) throw failure;
    return { rows: [], rowCount: 0 } as never;
  });
  return { query } as unknown as Queryable;
}

describe("settlement defensivo do claim do worker", () => {
  it.each([
    "UNKNOWN_KEY",
    "EXPIRED",
    "INVALID_SIGNATURE",
    "INSTALLATION_MISMATCH",
    "NOT_YET_VALID",
    "MALFORMED_DOCUMENT",
    "UNSUPPORTED_LICENSE_VERSION",
  ] as const)("adiar a licença %s libera o claim sem gastar tentativa", async (state) => {
    const returned = {
      ...CLAIMED_JOB,
      status: "pending" as const,
      attempts: 0,
      locked_by: null,
      locked_at: null,
    };
    const db = queryable([{ rows: [returned], rowCount: 1 }, { rows: [], rowCount: 1 }]);

    const settled = await deferJobForLicenseRejection(db, {
      job: CLAIMED_JOB,
      workerId: "worker-a",
      acquiredAt: CLAIMED_JOB.claim_acquired_at!,
      state,
    });

    expect(settled).toMatchObject({ status: "pending", attempts: 0, locked_by: null, locked_at: null });
    const firstCall = vi.mocked(db.query).mock.calls[0];
    expect(firstCall?.[0]).toContain("set status = 'pending'");
    expect(firstCall?.[0]).toContain("locked_by = null, locked_at = null");
    expect(firstCall?.[1]).toEqual([
      CLAIMED_JOB.id,
      "worker-a",
      LICENSE_RECHECK_DELAY_MS,
      CLAIMED_JOB.claim_acquired_at,
    ]);
    expect(licenseRejectionDiagnostic(state)).toBe(`LICENSE_REJECTED:${state}`);
  });

  it("não liquida duas vezes quando outro caminho já concluiu ou re-claimou", async () => {
    const db = queryable([{ rows: [], rowCount: 0 }]);

    await expect(
      settleUnexpectedClaimExit(db, {
        jobId: CLAIMED_JOB.id,
        workerId: "worker-a",
        acquiredAt: CLAIMED_JOB.claim_acquired_at,
        reason: new Error("WORKER_CLAIM_RETURNED_UNSETTLED"),
      }),
    ).resolves.toBe("already-settled-or-reclaimed");
    expect(vi.mocked(db.query)).toHaveBeenCalledTimes(1);
    expect(vi.mocked(db.query).mock.calls[0]?.[0]).toContain(
      "locked_by = $2 and ($3::timestamptz is null or locked_at=$3)",
    );
  });

  it("recusa fallback sem token de aquisição em vez de liquidar por worker id", async () => {
    const db = queryable([]);

    await expect(
      settleUnexpectedClaimExit(db, {
        jobId: CLAIMED_JOB.id,
        workerId: "worker-a",
        reason: new Error("WORKER_CLAIM_RETURNED_UNSETTLED"),
      }),
    ).resolves.toBe("claim-identity-missing");
    expect(vi.mocked(db.query)).not.toHaveBeenCalled();
  });

  it("o erro de escrita do diagnóstico ou do alerta não desfaz job já liberado", async () => {
    const dead = { ...CLAIMED_JOB, status: "dead" as const };
    const diagnosticError = new Error("diagnostic unavailable");
    const alertError = new Error("alert unavailable");
    const onDiagnosticFailure = vi.fn();
    const onAlertFailure = vi.fn();
    const db = queryable(
      [{ rows: [dead], rowCount: 1 }],
      [diagnosticError, alertError],
    );

    await expect(
      failJob(db, CLAIMED_JOB.id, "worker-a", new Error("safe failure"), CLAIMED_JOB.claim_acquired_at, {
        onDiagnosticFailure,
        onAlertFailure,
      }),
    ).resolves.toMatchObject({ status: "dead" });

    expect(onDiagnosticFailure).toHaveBeenCalledWith(diagnosticError);
    expect(onAlertFailure).toHaveBeenCalledWith(alertError);
    expect(vi.mocked(db.query)).toHaveBeenCalledTimes(3);
  });
});
