import { randomUUID } from "node:crypto";

import { Redis } from "@upstash/redis";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  __setSignatureRateLimitClockForTest,
  __setSignatureRateLimitRedisFactoryForTest,
  peekSignatureFailureLimitReached,
  recordSignatureFailureAtomic,
  setAtomicSignatureFailureDriverForTest,
} from "@/lib/channels/webhook-signature-rate-limit";

const redisUrl = process.env.WEBHOOK_RATE_LIMIT_TEST_REDIS_URL;
const redisToken = process.env.WEBHOOK_RATE_LIMIT_TEST_REDIS_TOKEN;
const canRunRedisIntegration = Boolean(redisUrl && redisToken);

describe.skipIf(!canRunRedisIntegration)("rate limit de webhook contra Redis REST real", () => {
  let clients: Redis[] = [];
  let nextClient = 0;

  beforeAll(() => {
    clients = [
      new Redis({ url: redisUrl!, token: redisToken!, retry: false }),
      new Redis({ url: redisUrl!, token: redisToken!, retry: false }),
    ];
    setAtomicSignatureFailureDriverForTest(null, null);
    __setSignatureRateLimitClockForTest(null);
    __setSignatureRateLimitRedisFactoryForTest(() => {
      const client = clients[nextClient % clients.length]!;
      nextClient++;
      return client;
    });
  });

  afterAll(() => {
    __setSignatureRateLimitRedisFactoryForTest(null);
    __setSignatureRateLimitClockForTest(null);
    setAtomicSignatureFailureDriverForTest(null, null);
  });

  it("duas instâncias concorrentes compartilham o teto atômico de 10 falhas", async () => {
    const token = `redis-integration-${randomUUID()}`;
    const results = await Promise.all(
      Array.from({ length: 20 }, () =>
        recordSignatureFailureAtomic(token, { limit: 10, windowSec: 600 }),
      ),
    );

    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    expect(results.filter((result) => !result.allowed)).toHaveLength(10);
    await expect(peekSignatureFailureLimitReached(token, { limit: 10, windowSec: 600 })).resolves.toMatchObject({
      limited: true,
      count: 10,
      redisUnavailable: false,
    });
  });

  it("expira a contagem exatamente na fronteira de 600 segundos", async () => {
    const token = `redis-boundary-${randomUUID()}`;
    const t0 = 1_800_000_000_000;
    __setSignatureRateLimitClockForTest(t0);

    for (let i = 0; i < 10; i++) {
      await expect(recordSignatureFailureAtomic(token, { limit: 10, windowSec: 600 })).resolves.toMatchObject({
        allowed: true,
      });
    }

    __setSignatureRateLimitClockForTest(t0 + 600_000 - 1);
    await expect(peekSignatureFailureLimitReached(token, { limit: 10, windowSec: 600 })).resolves.toMatchObject({
      limited: true,
      count: 10,
    });

    __setSignatureRateLimitClockForTest(t0 + 600_000);
    await expect(peekSignatureFailureLimitReached(token, { limit: 10, windowSec: 600 })).resolves.toMatchObject({
      limited: false,
      count: 0,
      redisUnavailable: false,
    });
    await expect(recordSignatureFailureAtomic(token, { limit: 10, windowSec: 600 })).resolves.toMatchObject({
      allowed: true,
      count: 1,
    });
  });
});
