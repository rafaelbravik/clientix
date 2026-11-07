import { afterEach, describe, expect, it, vi } from "vitest";

import {
  getInstanceSession,
  rotateInstanceSessionAfterRecovery,
  resetInstanceSessionForTests,
  resolveLicenseHeartbeatIntervalSeconds,
} from "./instance-session";

afterEach(resetInstanceSessionForTests);

describe("ephemeral installation sessions", () => {
  it("creates one UUID session per process boot and does not persist it", () => {
    const first = getInstanceSession(new Date("2026-11-05T12:00:00.000Z"));
    const second = getInstanceSession(new Date("2026-11-05T12:05:00.000Z"));

    expect(first.instance_session_id).toMatch(/^sess_[0-9a-f-]{36}$/i);
    expect(second).toBe(first);
    expect(first.boot_started_at).toBe("2026-11-05T12:00:00.000Z");
  });

  it("shares one session across separately evaluated route bundles in one process", async () => {
    const first = getInstanceSession(new Date("2026-11-06T12:00:00.000Z"));
    vi.resetModules();
    const separatelyBundledModule = await import("./instance-session");
    const second = separatelyBundledModule.getInstanceSession(new Date("2026-11-06T12:01:00.000Z"));

    expect(second).toEqual(first);
    expect(second.instance_session_id).toBe(first.instance_session_id);
  });

  it("starts a fresh attestation session after an authorized recovery in the same process", () => {
    const beforeRecovery = getInstanceSession(new Date("2026-11-06T12:00:00.000Z"));
    const afterRecovery = rotateInstanceSessionAfterRecovery(new Date("2026-11-06T12:01:00.000Z"));

    expect(afterRecovery.instance_session_id).not.toBe(beforeRecovery.instance_session_id);
    expect(afterRecovery.boot_started_at).toBe("2026-11-06T12:01:00.000Z");
    expect(getInstanceSession()).toBe(afterRecovery);
  });

  it("uses a bounded five-minute heartbeat cadence", () => {
    expect(resolveLicenseHeartbeatIntervalSeconds(undefined)).toBe(300);
    expect(resolveLicenseHeartbeatIntervalSeconds("600")).toBe(600);
    expect(resolveLicenseHeartbeatIntervalSeconds("1")).toBe(300);
    expect(resolveLicenseHeartbeatIntervalSeconds("not-a-number")).toBe(300);
  });
});
