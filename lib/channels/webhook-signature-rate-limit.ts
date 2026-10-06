/**
 * Limitador distribuído de falhas de assinatura de webhooks.
 *
 * A janela é aplicada por scripts Lua atômicos no Redis. O relógio também vem
 * do Redis dentro do script, para que réplicas da aplicação não divirjam por
 * relógios locais. Se a leitura ou gravação distribuída falhar, a rota deve
 * recusar a requisição com 503 antes de ler o corpo ou consultar o Postgres.
 */
import { createHash, randomUUID } from "node:crypto";

import { Redis } from "@upstash/redis";
import { env } from "@/lib/env";
import { logger } from "@/lib/logger";
import { validarConfigRedisRest } from "@/lib/redis-config";

export interface SignatureFailureResult {
  allowed: boolean;
  count: number;
  limit: number;
  redisUnavailable?: boolean;
  reason?: string;
}

export interface SignatureFailurePeekResult {
  limited: boolean;
  count: number;
  limit: number;
  redisUnavailable: boolean;
}

export type AtomicSignatureDriver = (
  key: string,
  limit: number,
  windowSec: number,
  nowMs?: number,
) => Promise<number>;

type SignatureRedisFactory = () => Redis | null;

let _testDriver: AtomicSignatureDriver | null = null;
let _testPeekDriver: ((key: string, windowSec: number, nowMs?: number) => Promise<number>) | null = null;
let _testRedisFactory: SignatureRedisFactory | null = null;
let _testClockMs: number | null = null;
let _redisInstance: Redis | null = null;
let _fallbackWarned = false;

function getRedis(): Redis | null {
  if (_testRedisFactory) return _testRedisFactory();
  if (_redisInstance) return _redisInstance;

  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  const config = validarConfigRedisRest(url, token);
  if (!config.ok) {
    if (!_fallbackWarned) {
      logger.warn(
        `[webhook-signature-rate-limit] Redis ${config.reason} — fail-closed para limitar falhas de assinatura`,
      );
      _fallbackWarned = true;
    }
    return null;
  }

  _redisInstance = new Redis({ url, token, retry: false });
  return _redisInstance;
}

function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

function redisKey(token: string): string {
  // Tokens de path são credenciais. Nunca os coloque em claro em chaves Redis,
  // que podem aparecer em ferramentas operacionais e diagnósticos do servidor.
  return `webhook_sig_fail_zset:${createHash("sha256").update(token).digest("hex")}`;
}

function reportRedisFailure(operation: string, token: string, err: unknown): void {
  const rawError = err instanceof Error ? err.message : String(err);
  const sanitizedError = token
    ? rawError.split(token).join(`[TOKEN_HASH:${tokenHash(token)}]`)
    : rawError;
  logger.error(`[webhook-signature-rate-limit] Redis ${operation} falhou; fail-closed ativo`, {
    error: sanitizedError,
    token_hash: tokenHash(token),
  });
}

/** ZSET sliding window. Score e tempo de corte usam o relógio do servidor Redis. */
const LUA_RECORD_FAILURE = `
local key = KEYS[1]
local now
if ARGV[1] ~= '' then
  now = tonumber(ARGV[1])
else
  local server_time = redis.call('TIME')
  now = tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
end
local window = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = tostring(now) .. ':' .. ARGV[4]
local cutoff = now - window

-- Limite inferior inclusivo: uma falha com idade exatamente igual à janela vence.
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
local count = redis.call('ZCARD', key)
if count < limit then
  redis.call('ZADD', key, now, member)
  redis.call('EXPIRE', key, math.ceil(window / 1000) + 10)
  return {count + 1, 1}
end
return {count, 0}
`;

const LUA_PEEK_FAILURES = `
local key = KEYS[1]
local now
if ARGV[1] ~= '' then
  now = tonumber(ARGV[1])
else
  local server_time = redis.call('TIME')
  now = tonumber(server_time[1]) * 1000 + math.floor(tonumber(server_time[2]) / 1000)
end
local window = tonumber(ARGV[2])
local cutoff = now - window
redis.call('ZREMRANGEBYSCORE', key, '-inf', cutoff)
return redis.call('ZCARD', key)
`;

function nowArgumentForTest(): string {
  return _testClockMs === null ? "" : String(_testClockMs);
}

function readScriptCount(result: unknown): number {
  if (!Array.isArray(result) || result.length < 1) {
    throw new Error("unexpected_redis_sliding_window_result");
  }
  const count = Number(result[0]);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error("invalid_redis_sliding_window_count");
  }
  return count;
}

/** Registra atomicamente uma falha e autoriza no máximo `limit` gravações de auditoria. */
export async function recordSignatureFailureAtomic(
  token: string,
  options?: { limit?: number; windowSec?: number },
): Promise<SignatureFailureResult> {
  const limit = options?.limit ?? 10;
  const windowSec = options?.windowSec ?? 600;
  const key = redisKey(token);

  if (_testDriver) {
    try {
      const count = await _testDriver(key, limit, windowSec, _testClockMs ?? undefined);
      return { allowed: count <= limit, count, limit };
    } catch (err) {
      reportRedisFailure("driver", token, err);
      return {
        allowed: false,
        count: -1,
        limit,
        redisUnavailable: true,
        reason: "redis_unavailable_fail_closed",
      };
    }
  }

  const redis = getRedis();
  if (!redis) {
    return {
      allowed: false,
      count: -1,
      limit,
      redisUnavailable: true,
      reason: "redis_unavailable_fail_closed",
    };
  }

  try {
    const result = await redis.eval<unknown[], unknown>(
      LUA_RECORD_FAILURE,
      [key],
      [nowArgumentForTest(), windowSec * 1000, limit, randomUUID()],
    );
    if (!Array.isArray(result) || result.length < 2) {
      throw new Error("unexpected_redis_sliding_window_result");
    }
    const count = readScriptCount(result);
    const allowed = Number(result[1]) === 1;
    if (!Number.isSafeInteger(count) || (Number(result[1]) !== 0 && Number(result[1]) !== 1)) {
      throw new Error("invalid_redis_sliding_window_decision");
    }
    return { allowed, count, limit };
  } catch (err) {
    reportRedisFailure("eval de registro", token, err);
    return {
      allowed: false,
      count: -1,
      limit,
      redisUnavailable: true,
      reason: "redis_call_failed_fail_closed",
    };
  }
}

/** Consulta o teto sem consumir uma tentativa; indisponibilidade é distinta de contador zerado. */
export async function peekSignatureFailureLimitReached(
  token: string,
  options?: { limit?: number; windowSec?: number },
): Promise<SignatureFailurePeekResult> {
  const limit = options?.limit ?? 10;
  const windowSec = options?.windowSec ?? 600;
  const key = redisKey(token);

  if (_testPeekDriver) {
    try {
      const count = await _testPeekDriver(key, windowSec, _testClockMs ?? undefined);
      return { limited: count >= limit, count, limit, redisUnavailable: false };
    } catch (err) {
      reportRedisFailure("driver de leitura", token, err);
      return { limited: false, count: -1, limit, redisUnavailable: true };
    }
  }

  const redis = getRedis();
  if (!redis) return { limited: false, count: -1, limit, redisUnavailable: true };

  try {
    const result = await redis.eval<unknown[], unknown>(
      LUA_PEEK_FAILURES,
      [key],
      [nowArgumentForTest(), windowSec * 1000],
    );
    const count = readScriptCount([result]);
    return { limited: count >= limit, count, limit, redisUnavailable: false };
  } catch (err) {
    reportRedisFailure("eval de leitura", token, err);
    return { limited: false, count: -1, limit, redisUnavailable: true };
  }
}

/** Drivers determinísticos usados por testes unitários; sem fallback para o Redis ambiente. */
export function setAtomicSignatureFailureDriverForTest(
  incrDriver: AtomicSignatureDriver | null,
  peekDriver?: ((key: string, windowSec: number, nowMs?: number) => Promise<number>) | null,
): void {
  _testDriver = incrDriver;
  _testPeekDriver = peekDriver ?? null;
}

/** Roteia testes de integração para Redis descartável sem ler `.env` ou credenciais da instalação. */
export function __setSignatureRateLimitRedisFactoryForTest(factory: SignatureRedisFactory | null): void {
  _testRedisFactory = factory;
}

/** Injeta um relógio sintético apenas nos testes que executam o próprio script Lua. */
export function __setSignatureRateLimitClockForTest(nowMs: number | null): void {
  _testClockMs = nowMs;
}
