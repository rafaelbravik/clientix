/**
 * Clientix L8.1G.3 — Minimal Injectable Redis Client Abstraction
 *
 * Decouples the Control Plane from any specific Redis library (ioredis, node-redis, @upstash/redis).
 * Provides raw commands required for grant management and atomic Lua script execution.
 */

export interface IRedisClient {
  /**
   * Sets a key with string value and optional TTL in seconds.
   */
  set(key: string, value: string, options?: { ex?: number }): Promise<void | string | null>;

  /**
   * Gets string value of key. Returns null if missing.
   */
  get(key: string): Promise<string | null>;

  /**
   * Deletes one or more keys.
   */
  del(...keys: string[]): Promise<number>;

  /**
   * Executes a Lua script with given KEYS and ARGV.
   */
  eval<T = unknown>(script: string, keys: string[], args: (string | number)[]): Promise<T>;

  /**
   * Ping server to check liveness.
   */
  ping(): Promise<string>;
}
