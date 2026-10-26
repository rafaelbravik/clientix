import { describe, expect, it, vi } from "vitest";

import { runFollowupTick, type AdminClient } from "@/lib/followup/engine";
import type { EnrollmentRow } from "@/lib/followup/node-handlers";

describe("runFollowupTick — proteção contra snapshot terminal", () => {
  it.each(["completed", "cancelled", "dead"] as const)("não reabre enrollment %s devolvido pelo claim", async (status) => {
    const enrollment = {
      id: "11111111-1111-4111-8111-111111111111",
      organization_id: "22222222-2222-4222-8222-222222222222",
      pointer_id: "33333333-3333-4333-8333-333333333333",
      version_id: "44444444-4444-4444-8444-444444444444",
      contact_id: "55555555-5555-4555-8555-555555555555",
      conversation_id: null,
      current_node_id: "wait-1",
      status,
      next_eval_at: null,
      claimed_until: null,
      attempts: 0,
      max_attempts: 5,
      last_error: null,
      steps_taken: 1,
      outcome: null,
      cancel_reason: "manual",
      started_at: "2026-10-24T12:00:00.000Z",
      completed_at: "2026-10-24T12:01:00.000Z",
      updated_at: "2026-10-24T12:01:00.000Z",
    } satisfies EnrollmentRow;
    const loadFlowGraph = vi.fn();
    const updateEnrollment = vi.fn();
    const db = {
      claimDueEnrollments: vi.fn().mockResolvedValue([enrollment]),
      loadFlowGraph,
      updateEnrollment,
    } as unknown as AdminClient;

    const summary = await runFollowupTick({ db, clock: () => new Date(), enqueueJob: vi.fn() });

    expect(summary.claimed).toBe(1);
    expect(loadFlowGraph).not.toHaveBeenCalled();
    expect(updateEnrollment).not.toHaveBeenCalled();
  });
});
