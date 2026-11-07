export const CLONE_STATUSES = [
  "NORMAL",
  "SUSPECTED_CLONE",
  "CLONE_CONFIRMED",
  "TRANSFER_PENDING",
] as const;

export type CloneStatus = (typeof CLONE_STATUSES)[number];

export interface CloneStatusTransition {
  status: CloneStatus;
  event?: "CLONE_SUSPECTED" | "CLONE_CONFIRMED" | "CLONE_CLEARED";
}

export interface InstanceSessionHeartbeat {
  session_id: string;
  started_at: string;
  last_heartbeat_at: string;
}

/**
 * Requires both sessions to report after the other session was registered.
 * A stopped process followed by a legitimate restart therefore does not count
 * as overlap just because its final heartbeat is still inside the freshness window.
 */
export function hasConcurrentSessionEvidence(
  sessions: readonly InstanceSessionHeartbeat[],
): boolean {
  for (let firstIndex = 0; firstIndex < sessions.length; firstIndex += 1) {
    const first = sessions[firstIndex];
    if (!first) continue;
    const firstStartedAt = Date.parse(first.started_at);
    const firstHeartbeatAt = Date.parse(first.last_heartbeat_at);
    if (!Number.isFinite(firstStartedAt) || !Number.isFinite(firstHeartbeatAt)) continue;

    for (let secondIndex = firstIndex + 1; secondIndex < sessions.length; secondIndex += 1) {
      const second = sessions[secondIndex];
      if (!second || first.session_id === second.session_id) continue;
      const secondStartedAt = Date.parse(second.started_at);
      const secondHeartbeatAt = Date.parse(second.last_heartbeat_at);
      if (
        Number.isFinite(secondStartedAt) &&
        Number.isFinite(secondHeartbeatAt) &&
        firstHeartbeatAt > secondStartedAt &&
        secondHeartbeatAt > firstStartedAt
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Classifies overlapping fresh sessions only. A missing heartbeat is handled by
 * the server freshness window and never increments this conflict count.
 */
export function transitionCloneStatus(
  current: CloneStatus,
  freshSessionCount: number,
  previousConflictCount: number,
  anotherSessionReportedSinceConflict = false,
): CloneStatusTransition {
  if (current === "TRANSFER_PENDING" || current === "CLONE_CONFIRMED") {
    return { status: current };
  }
  if (freshSessionCount >= 2) {
    if (
      current === "SUSPECTED_CLONE" &&
      previousConflictCount >= 1 &&
      anotherSessionReportedSinceConflict
    ) {
      return { status: "CLONE_CONFIRMED", event: "CLONE_CONFIRMED" };
    }
    return current === "SUSPECTED_CLONE"
      ? { status: current }
      : { status: "SUSPECTED_CLONE", event: "CLONE_SUSPECTED" };
  }
  return current === "SUSPECTED_CLONE"
    ? { status: "NORMAL", event: "CLONE_CLEARED" }
    : { status: current };
}
