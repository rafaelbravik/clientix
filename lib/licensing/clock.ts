import fs from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";

export const CLOCK_ROLLBACK_TOLERANCE_MS = 5 * 60 * 1000;
const CLOCK_WRITE_INTERVAL_MS = 60 * 1000;

export interface LicenseClockObservation {
  rollback_suspected: boolean;
  baseline_available: boolean;
  last_seen_at?: string;
}

/**
 * Records the highest locally observed wall-clock timestamp. It is a warning
 * signal only: a local file is not a tamper-proof clock and never blocks use.
 */
export async function observeLicenseClock(
  now: Date,
  baselinePath: string,
): Promise<LicenseClockObservation> {
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) {
    return { rollback_suspected: true, baseline_available: false };
  }

  let lastSeenMs: number | null = null;
  try {
    const raw = await fs.readFile(baselinePath, "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as { last_seen_at?: unknown }).last_seen_at !== "string"
    ) {
      return { rollback_suspected: true, baseline_available: false };
    }
    lastSeenMs = Date.parse((parsed as { last_seen_at: string }).last_seen_at);
    if (!Number.isFinite(lastSeenMs)) {
      return { rollback_suspected: true, baseline_available: false };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      return { rollback_suspected: true, baseline_available: false };
    }
  }

  if (lastSeenMs !== null && nowMs < lastSeenMs - CLOCK_ROLLBACK_TOLERANCE_MS) {
    return {
      rollback_suspected: true,
      baseline_available: true,
      last_seen_at: new Date(lastSeenMs).toISOString(),
    };
  }

  if (lastSeenMs === null || nowMs - lastSeenMs >= CLOCK_WRITE_INTERVAL_MS) {
    const nextMs = Math.max(nowMs, lastSeenMs ?? nowMs);
    try {
      await atomicWriteClockBaseline(baselinePath, new Date(nextMs).toISOString());
      lastSeenMs = nextMs;
    } catch {
      return {
        rollback_suspected: false,
        baseline_available: false,
        ...(lastSeenMs === null ? {} : { last_seen_at: new Date(lastSeenMs).toISOString() }),
      };
    }
  }

  return {
    rollback_suspected: false,
    baseline_available: true,
    ...(lastSeenMs === null ? {} : { last_seen_at: new Date(lastSeenMs).toISOString() }),
  };
}

async function atomicWriteClockBaseline(targetPath: string, lastSeenAt: string): Promise<void> {
  const directory = path.dirname(targetPath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify({ version: 1, last_seen_at: lastSeenAt }), {
      encoding: "utf-8",
      flag: "wx",
      mode: 0o600,
    });
    await fs.rename(temporaryPath, targetPath);
  } finally {
    await fs.unlink(temporaryPath).catch(() => {});
  }
}
