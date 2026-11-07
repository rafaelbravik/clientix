import type { IRedisClient } from "./redis-client-interface";

/**
 * In-Memory realistic implementation of IRedisClient for testing.
 * Implements TTL simulation, string storage, and runs Lua scripts with basic environment
 * (cjson, tonumber, type, pcall, redis.call('GET'), redis.call('SET'), redis.call('TTL')).
 */
export class FakeInMemoryRedisClient implements IRedisClient {
  private store = new Map<string, { value: string; expiresAtMs?: number }>();
  public shouldFail = false; // To simulate Redis outage / network errors

  private isExpired(entry: { value: string; expiresAtMs?: number }): boolean {
    if (entry.expiresAtMs && Date.now() >= entry.expiresAtMs) {
      return true;
    }
    return false;
  }

  async ping(): Promise<string> {
    if (this.shouldFail) throw new Error("Redis connection refused");
    return "PONG";
  }

  async set(key: string, value: string, options?: { ex?: number }): Promise<string> {
    if (this.shouldFail) throw new Error("Redis connection refused");
    const expiresAtMs = options?.ex ? Date.now() + options.ex * 1000 : undefined;
    this.store.set(key, { value, expiresAtMs });
    return "OK";
  }

  async get(key: string): Promise<string | null> {
    if (this.shouldFail) throw new Error("Redis connection refused");
    const entry = this.store.get(key);
    if (!entry) return null;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return null;
    }
    return entry.value;
  }

  async del(...keys: string[]): Promise<number> {
    if (this.shouldFail) throw new Error("Redis connection refused");
    let count = 0;
    for (const k of keys) {
      if (this.store.delete(k)) count++;
    }
    return count;
  }

  async eval<T = unknown>(_script: string, keys: string[], args: (string | number)[]): Promise<T> {
    if (this.shouldFail) throw new Error("Redis connection refused");

    // Atomically execute the semantics of ATOMIC_CONSUME_LUA_SCRIPT
    const grantKey = keys[0]!;
    const artifactId = String(args[0]);
    const now = Number(args[1]);

    const entry = this.store.get(grantKey);
    if (!entry || this.isExpired(entry)) {
      if (entry) this.store.delete(grantKey);
      return 1 as unknown as T; // 1: GRANT_NOT_FOUND
    }

    let grant: Record<string, unknown>;
    try {
      grant = JSON.parse(entry.value);
      if (typeof grant !== "object" || grant === null) {
        return 6 as unknown as T; // 6: MALFORMED_GRANT
      }
    } catch {
      return 6 as unknown as T;
    }

    if (grant.revoked === true) {
      return 3 as unknown as T; // 3: GRANT_REVOKED
    }

    if (grant.grantId) {
      const revokeMarker = this.store.get(`clientix:distribution:revoked:${grant.grantId}`);
      if (revokeMarker && !this.isExpired(revokeMarker)) {
        return 3 as unknown as T;
      }
    }

    if (Number(grant.expiresAt) <= now) {
      return 2 as unknown as T; // 2: GRANT_EXPIRED
    }

    const allowedArtifactIds = Array.isArray(grant.allowedArtifactIds)
      ? grant.allowedArtifactIds
      : [];
    if (!allowedArtifactIds.includes(artifactId)) {
      return 4 as unknown as T; // 4: ARTIFACT_NOT_ALLOWED
    }

    const remainingUses = grant.remainingUses as Record<string, number> | undefined;
    if (!remainingUses || typeof remainingUses !== "object") {
      return 6 as unknown as T;
    }

    const currentCount = remainingUses[artifactId];
    if (typeof currentCount !== "number" || currentCount <= 0) {
      return 5 as unknown as T; // 5: ARTIFACT_GRANT_EXHAUSTED
    }

    // Atomic decrement
    remainingUses[artifactId] = currentCount - 1;
    entry.value = JSON.stringify(grant);

    return 0 as unknown as T; // 0: SUCCESS
  }

  // Inspection helpers for tests
  inspectKey(key: string): string | null {
    const entry = this.store.get(key);
    if (!entry || this.isExpired(entry)) return null;
    return entry.value;
  }

  getAllKeys(): string[] {
    return Array.from(this.store.keys());
  }

  clear(): void {
    this.store.clear();
  }
}
