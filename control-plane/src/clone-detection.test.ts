import { describe, expect, it } from "vitest";

import { hasConcurrentSessionEvidence, transitionCloneStatus } from "@/lib/licensing/clone-status";

describe("clone overlap state machine", () => {
  it("does not call a stopped session plus a fast legitimate restart a clone", () => {
    expect(
      hasConcurrentSessionEvidence([
        {
          session_id: "sess_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
          started_at: "2026-11-06T12:00:00.000Z",
          last_heartbeat_at: "2026-11-06T12:01:00.000Z",
        },
        {
          session_id: "sess_11111111-2222-4333-8444-555555555555",
          started_at: "2026-11-06T12:01:01.000Z",
          last_heartbeat_at: "2026-11-06T12:01:02.000Z",
        },
      ]),
    ).toBe(false);
  });

  it("requires reports from both sessions after they overlap to detect a real clone", () => {
    const overlapping = [
      {
        session_id: "sess_aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
        started_at: "2026-11-06T12:00:00.000Z",
        last_heartbeat_at: "2026-11-06T12:02:00.000Z",
      },
      {
        session_id: "sess_11111111-2222-4333-8444-555555555555",
        started_at: "2026-11-06T12:01:00.000Z",
        last_heartbeat_at: "2026-11-06T12:03:00.000Z",
      },
    ];
    expect(hasConcurrentSessionEvidence(overlapping)).toBe(true);
    expect(transitionCloneStatus("NORMAL", 2, 0)).toEqual({
      status: "SUSPECTED_CLONE",
      event: "CLONE_SUSPECTED",
    });
  });

  it("marks the first overlap suspected and confirms a persistent second overlap", () => {
    const suspected = transitionCloneStatus("NORMAL", 2, 0);
    expect(suspected).toEqual({ status: "SUSPECTED_CLONE", event: "CLONE_SUSPECTED" });

    const confirmed = transitionCloneStatus(suspected.status, 2, 1, true);
    expect(confirmed).toEqual({ status: "CLONE_CONFIRMED", event: "CLONE_CONFIRMED" });
  });

  it("does not confirm a stale boot session when only the new boot keeps heartbeating", () => {
    const suspected = transitionCloneStatus("NORMAL", 2, 0);
    expect(transitionCloneStatus(suspected.status, 2, 1, false)).toEqual({
      status: "SUSPECTED_CLONE",
    });
  });

  it("does not classify one fresh session or a missing heartbeat as a clone", () => {
    expect(transitionCloneStatus("NORMAL", 1, 0)).toEqual({ status: "NORMAL" });
    expect(transitionCloneStatus("SUSPECTED_CLONE", 1, 1)).toEqual({
      status: "NORMAL",
      event: "CLONE_CLEARED",
    });
  });

  it("never auto-clears a confirmed conflict and preserves vendor recovery pending", () => {
    expect(transitionCloneStatus("CLONE_CONFIRMED", 1, 9)).toEqual({
      status: "CLONE_CONFIRMED",
    });
    expect(transitionCloneStatus("TRANSFER_PENDING", 2, 0)).toEqual({
      status: "TRANSFER_PENDING",
    });
  });
});
