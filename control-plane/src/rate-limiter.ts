export interface RateLimiter {
  checkLimit(key: string, maxHits: number, windowSeconds: number): Promise<{ allowed: boolean; retryAfterSeconds?: number }>;
}

export class MemoryRateLimiter implements RateLimiter {
  private hits = new Map<string, { count: number; resetAt: number }>();

  async checkLimit(
    key: string,
    maxHits: number,
    windowSeconds: number
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
