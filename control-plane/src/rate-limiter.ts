import crypto from "node:crypto";

import type { DatabaseClient } from "../scripts/migrator";

export interface RateLimiter {
  checkLimit(
    key: string,
    maxHits: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
}

/** Distributed fixed-window limiter. Only an HMAC digest is persisted. */
export class PostgresRateLimiter implements RateLimiter {
  private lastCleanupAt = 0;

  constructor(
    private readonly db: DatabaseClient,
    private readonly pepper: string,
    private readonly clockNow: () => Date = () => new Date(),
  ) {
    if (pepper.length < 32)
      throw new Error("Control Plane rate-limit pepper must contain at least 32 characters.");
  }

  async checkLimit(
    key: string,
    maxHits: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
    if (
      !Number.isInteger(maxHits) ||
      maxHits < 1 ||
      !Number.isInteger(windowSeconds) ||
      windowSeconds < 1
    ) {
      throw new Error("Invalid rate-limit policy.");
    }
    const now = this.clockNow();
    if (now.getTime() - this.lastCleanupAt >= 60_000) {
      this.lastCleanupAt = now.getTime();
      await this.db.query(
        `delete from control_plane.licensing_rate_limit_buckets where window_start < $1;`,
        [new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()],
      );
    }
    const epoch = Math.floor(now.getTime() / 1000);
    const windowEpoch = Math.floor(epoch / windowSeconds) * windowSeconds;
    const windowStart = new Date(windowEpoch * 1000).toISOString();
    const keyDigest = crypto
      .createHmac("sha256", this.pepper)
      .update(`${windowSeconds}:${windowEpoch}:${key}`, "utf8")
      .digest("hex");
    const result = await this.db.query<{ request_count: number | string }>(
      `insert into control_plane.licensing_rate_limit_buckets (key_digest, window_start, request_count, updated_at)
       values ($1, $2, 1, now())
       on conflict (key_digest, window_start)
       do update set request_count = control_plane.licensing_rate_limit_buckets.request_count + 1,
                     updated_at = now()
       returning request_count;`,
      [keyDigest, windowStart],
    );
    const count = Number(result.rows[0]?.request_count ?? maxHits + 1);
    return count <= maxHits
      ? { allowed: true }
      : { allowed: false, retryAfterSeconds: Math.max(1, windowEpoch + windowSeconds - epoch) };
  }
}

export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  async checkLimit(
    key: string,
    maxHits: number,
    windowSeconds: number,
  ): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
    const now = Math.floor(Date.now() / 1000);
    const entry = this.hits.get(key);

    if (!entry || entry.resetAt <= now) {
      this.hits.set(key, { count: 1, resetAt: now + windowSeconds });
      return { allowed: true };
    }

    if (entry.count >= maxHits) {
      return { allowed: false, retryAfterSeconds: entry.resetAt - now };
    }

    entry.count += 1;
    return { allowed: true };
  }
}
