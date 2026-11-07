import { z } from "zod";

const schedulerEnvironmentSchema = z.object({
  CONTROL_PLANE_BILLING_SCHEDULER_INTERVAL_MS: z.coerce
    .number()
    .int()
    .min(60_000)
    .max(86_400_000)
    .default(900_000),
});

export function resolveBillingSchedulerInterval(
  source: Record<string, string | undefined>,
): number {
  return schedulerEnvironmentSchema.parse(source).CONTROL_PLANE_BILLING_SCHEDULER_INTERVAL_MS;
}

export type BillingSchedulerLock<T> = (
  operation: () => Promise<T>,
) => Promise<{ acquired: false } | { acquired: true; value: T }>;

export type BillingSchedulerRunResult<T> =
  { status: "COMPLETED"; value: T } | { status: "SKIPPED_LOCKED" } | { status: "SKIPPED_OVERLAP" };

export class BillingScheduler<T> {
  private running = false;
  private stopped = true;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly options: {
      intervalMs: number;
      withLock: BillingSchedulerLock<T>;
      runCycle: () => Promise<T>;
      onResult?: (result: BillingSchedulerRunResult<T>) => void;
      onError?: () => void;
    },
  ) {
    if (!Number.isInteger(options.intervalMs) || options.intervalMs < 60_000) {
      throw new Error("Billing scheduler interval must be at least one minute.");
    }
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.schedule(0);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  async runOnce(): Promise<BillingSchedulerRunResult<T>> {
    if (this.running) return { status: "SKIPPED_OVERLAP" };
    this.running = true;
    try {
      const locked = await this.options.withLock(this.options.runCycle);
      const result: BillingSchedulerRunResult<T> = locked.acquired
        ? { status: "COMPLETED", value: locked.value }
        : { status: "SKIPPED_LOCKED" };
      this.options.onResult?.(result);
      return result;
    } catch {
      this.options.onError?.();
      throw new Error("Vendor billing scheduler cycle failed.");
    } finally {
      this.running = false;
    }
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runOnce()
        .catch(() => undefined)
        .finally(() => this.schedule(this.options.intervalMs));
    }, delayMs);
  }
}
