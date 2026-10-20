import type { LicenseState } from "@/lib/licensing/types";
import {
  rescheduleJob,
  type JobRow,
  type QueueSettlementReporting,
  type Queryable,
} from "@/lib/agent-engine/queue/queue";

/** Recheck an installation license at a deliberate pace without consuming a job attempt. */
export const LICENSE_RECHECK_DELAY_MS = 60_000;

export type UnusableLicenseState = Exclude<LicenseState, "VALID" | "GRACE">;

export function licenseRejectionDiagnostic(state: UnusableLicenseState): string {
  return `LICENSE_REJECTED:${state}`;
}

export function deferJobForLicenseRejection(
  db: Queryable,
  input: {
    job: Pick<JobRow, "id">;
    workerId: string;
    acquiredAt: string;
    state: UnusableLicenseState;
    reporting?: QueueSettlementReporting;
  },
): Promise<JobRow | null> {
  return rescheduleJob(db, input.job.id, input.workerId, {
    delayMs: LICENSE_RECHECK_DELAY_MS,
    reason: licenseRejectionDiagnostic(input.state),
    acquiredAt: input.acquiredAt,
    ...input.reporting,
  });
}
