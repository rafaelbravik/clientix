import { randomUUID } from "node:crypto";

export interface InstanceSession {
  instance_session_id: string;
  boot_started_at: string;
}

const INSTANCE_SESSION_KEY = Symbol.for("clientix.licensing.instance-session");
type ProcessSessionStore = typeof globalThis & { [key: symbol]: InstanceSession | undefined };

function processSessionStore(): ProcessSessionStore {
  return globalThis as ProcessSessionStore;
}

/** One ephemeral identity per Node.js process, shared across independently bundled route modules. */
export function getInstanceSession(now = new Date()): InstanceSession {
  const store = processSessionStore();
  store[INSTANCE_SESSION_KEY] ??= {
    instance_session_id: `sess_${randomUUID()}`,
    boot_started_at: now.toISOString(),
  };
  return store[INSTANCE_SESSION_KEY]!;
}

/** Rotates the process session after an explicitly authorized installation recovery. */
export function rotateInstanceSessionAfterRecovery(now = new Date()): InstanceSession {
  delete processSessionStore()[INSTANCE_SESSION_KEY];
  return getInstanceSession(now);
}

/** Rotates only the server-confirmed ended session; concurrent callers converge on one new ID. */
export function rotateInstanceSessionAfterServerTermination(
  endedSessionId: string,
  now = new Date(),
): InstanceSession {
  const current = getInstanceSession();
  if (current.instance_session_id !== endedSessionId) return current;
  return rotateInstanceSessionAfterRecovery(now);
}

export function resetInstanceSessionForTests(): void {
  delete processSessionStore()[INSTANCE_SESSION_KEY];
}

export function resolveLicenseHeartbeatIntervalSeconds(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 300;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 60 || parsed > 3600) return 300;
  return parsed;
}
