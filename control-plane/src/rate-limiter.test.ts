import { describe, expect, it } from "vitest";

import type { DatabaseClient } from "../scripts/migrator";
import { PostgresRateLimiter } from "./rate-limiter";

class LimiterDatabase implements DatabaseClient {
  readonly calls: { sql: string; params: unknown[] }[] = [];
  private requestCount = 0;

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount?: number }> {
    this.calls.push({ sql, params });
    if (sql.includes("returning request_count")) {
      this.requestCount += 1;
      return { rows: [{ request_count: this.requestCount } as unknown as R], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
}

describe("distributed License Server rate limit", () => {
  it("stores only an HMAC digest and denies attempts after the fixed-window limit", async () => {
    const db = new LimiterDatabase();
    const limiter = new PostgresRateLimiter(
      db,
      "synthetic-test-pepper-with-at-least-32-characters",
      () => new Date("2026-11-05T12:00:00.000Z"),
    );
    const sensitiveKey = "activate:ip:192.0.2.55";

    expect(await limiter.checkLimit(sensitiveKey, 1, 60)).toEqual({ allowed: true });
    expect(await limiter.checkLimit(sensitiveKey, 1, 60)).toMatchObject({ allowed: false });

    const insert = db.calls.find((call) => call.sql.includes("returning request_count"));
    expect(insert?.params[0]).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(db.calls)).not.toContain("192.0.2.55");
  });
});
