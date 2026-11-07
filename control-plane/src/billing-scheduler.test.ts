import { describe, expect, it, vi } from "vitest";

import {
  BillingScheduler,
  resolveBillingSchedulerInterval,
  type BillingSchedulerLock,
} from "./billing-scheduler";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe("Vendor billing scheduler", () => {
  it("defaults to 15 minutes and validates configured bounds", () => {
    expect(resolveBillingSchedulerInterval({})).toBe(900_000);
    expect(
      resolveBillingSchedulerInterval({ CONTROL_PLANE_BILLING_SCHEDULER_INTERVAL_MS: "60000" }),
    ).toBe(60_000);
    expect(() =>
      resolveBillingSchedulerInterval({ CONTROL_PLANE_BILLING_SCHEDULER_INTERVAL_MS: "59999" }),
    ).toThrow();
  });

  it("skips a cycle when another Vendor scheduler owns the advisory lock", async () => {
    const runCycle = vi.fn(async () => "done");
    const scheduler = new BillingScheduler({
      intervalMs: 900_000,
      withLock: async () => ({ acquired: false }),
      runCycle,
    });
    await expect(scheduler.runOnce()).resolves.toEqual({ status: "SKIPPED_LOCKED" });
    expect(runCycle).not.toHaveBeenCalled();
  });

  it("prevents overlapping work in one process", async () => {
    const gate = deferred<string>();
    const scheduler = new BillingScheduler({
      intervalMs: 900_000,
      withLock: async (operation) => ({ acquired: true, value: await operation() }),
      runCycle: () => gate.promise,
    });
    const first = scheduler.runOnce();
    await expect(scheduler.runOnce()).resolves.toEqual({ status: "SKIPPED_OVERLAP" });
    gate.resolve("completed");
    await expect(first).resolves.toEqual({ status: "COMPLETED", value: "completed" });
  });

  it("uses one shared lock across two scheduler instances", async () => {
    let held = false;
    const withLock: BillingSchedulerLock<string> = async (operation) => {
      if (held) return { acquired: false };
      held = true;
      try {
        return { acquired: true, value: await operation() };
      } finally {
        held = false;
      }
    };
    const gate = deferred<string>();
    const first = new BillingScheduler({
      intervalMs: 900_000,
      withLock,
      runCycle: () => gate.promise,
    });
    const second = new BillingScheduler({
      intervalMs: 900_000,
      withLock,
      runCycle: async () => "should-not-run",
    });
    const active = first.runOnce();
    await expect(second.runOnce()).resolves.toEqual({ status: "SKIPPED_LOCKED" });
    gate.resolve("done");
    await active;
  });
});
