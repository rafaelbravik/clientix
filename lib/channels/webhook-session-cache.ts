/**
 * Resolução limitada de sessão para webhooks.
 *
 * Credenciais e estado de arquivamento vêm do Postgres em cada requisição:
 * não há cache positivo nem negativo local. Assim, uma rotação de segredo,
 * revogação ou arquivamento passa a valer em todas as réplicas assim que a
 * alteração do banco for confirmada, sem depender de broadcast ou TTL.
 *
 * Requisições simultâneas pelo mesmo token compartilham somente a consulta que
 * já está em voo. O resultado não é retido depois dela. Semáforo, fila e mutex
 * por token têm limites rígidos para manter memória e concorrência delimitadas.
 */
import { ARCHIVED_AT, queryTolerantToMissingArchived } from "@/lib/channels/archived";
import { createAdminClient } from "@/lib/supabase/admin";
import { decryptWebhookSecret } from "@/lib/webhooks/secrets";

export interface CachedWebhookSession {
  sessao: {
    id: string;
    organization_id: string;
    provider: string;
    display_name: string | null;
    phone_number: string | null;
    webhook_secret_encrypted?: unknown;
    archived_at?: string | null;
  } | null;
  secret: string | null;
}

export interface ResolveWebhookSessionOptions {
  includeSecret?: boolean;
}

const MAX_IN_FLIGHT_RESOLUTIONS = 100;
const MAX_RESOLUTION_WAITERS = 200;
const MAX_CONCURRENT_TOKEN_LOCKS = 500;
const MAX_TOKEN_LOCK_WAITERS = 200;

const _inFlightResolutions = new Map<string, Promise<CachedWebhookSession>>();
const _tokenLocks = new Map<string, { queue: Array<() => void> }>();
const _resolutionWaitQueue: Array<() => void> = [];

let _activeResolutions = 0;
let _tokenLockWaiters = 0;

function acquireResolutionSlot(): Promise<void> {
  if (_activeResolutions < MAX_IN_FLIGHT_RESOLUTIONS) {
    _activeResolutions++;
    return Promise.resolve();
  }
  if (_resolutionWaitQueue.length >= MAX_RESOLUTION_WAITERS) {
    return Promise.reject(new Error("webhook_session_cache_overloaded"));
  }
  return new Promise<void>((resolve) => {
    _resolutionWaitQueue.push(() => {
      // O slot passa diretamente para o próximo waiter; o total ativo não muda.
      resolve();
    });
  });
}

function releaseResolutionSlot(): void {
  const next = _resolutionWaitQueue.shift();
  if (next) {
    next();
    return;
  }
  _activeResolutions = Math.max(0, _activeResolutions - 1);
}

/**
 * Serializa eventos do mesmo token dentro desta instância. Redis continua
 * sendo a autoridade do limite de falhas entre instâncias; a fila local é
 * limitada e não é usada para alegar coordenação distribuída.
 */
export async function withTokenLock<T>(token: string, fn: () => Promise<T>): Promise<T> {
  let state = _tokenLocks.get(token);
  if (!state) {
    if (_tokenLocks.size >= MAX_CONCURRENT_TOKEN_LOCKS) {
      throw new Error("webhook_session_cache_overloaded");
    }
    state = { queue: [] };
    _tokenLocks.set(token, state);
  } else {
    if (_tokenLockWaiters >= MAX_TOKEN_LOCK_WAITERS) {
      throw new Error("webhook_session_cache_overloaded");
    }
    _tokenLockWaiters++;
    try {
      await new Promise<void>((resolve) => state!.queue.push(resolve));
    } finally {
      _tokenLockWaiters--;
    }
  }

  try {
    return await fn();
  } finally {
    const next = state.queue.shift();
    if (next) next();
    else _tokenLocks.delete(token);
  }
}

/** Compatibilidade para chamadores existentes; não há sessão em cache a invalidar. */
export function invalidateWebhookSessionCache(_token: string): void {}

/** Compatibilidade para chamadores existentes; cada resolução consulta o banco. */
export function invalidateWebhookCacheBySessionId(_sessionId: string): void {}

export function _clearWebhookSessionCacheForTest(): void {
  _inFlightResolutions.clear();
  _tokenLocks.clear();
  _resolutionWaitQueue.length = 0;
  _activeResolutions = 0;
  _tokenLockWaiters = 0;
}

/** Mantidos para testes/consumidores antigos; ambos os caches persistentes foram removidos. */
export function _getWebhookSessionCacheSizeForTest(): number { return 0; }
export function _getWebhookInFlightSizeForTest(): number { return _inFlightResolutions.size; }
export function _getActiveResolutionsForTest(): number { return _activeResolutions; }
export function _getWaitQueueLengthForTest(): number { return _resolutionWaitQueue.length; }
export function _getTokenEpochForTest(_token: string): number { return 0; }
export function _getSessionToTokenSizeForTest(): number { return 0; }
export function _getTokenEpochsSizeForTest(): number { return 0; }

/** Resolve sessão e segredo sem reter credenciais em memória entre requisições. */
export async function resolveSessionForToken(
  token: string,
  options: ResolveWebhookSessionOptions = {},
): Promise<CachedWebhookSession> {
  const includeSecret = options.includeSecret !== false;
  const resolutionKey = `${token}\u0000${includeSecret ? "secret" : "metadata"}`;
  const existingInFlight = _inFlightResolutions.get(resolutionKey);
  if (existingInFlight) return existingInFlight;

  if (_inFlightResolutions.size >= MAX_IN_FLIGHT_RESOLUTIONS + MAX_RESOLUTION_WAITERS) {
    throw new Error("webhook_session_cache_overloaded");
  }

  const resolutionPromise = Promise.resolve().then(async () => {
    let slotAcquired = false;
    try {
      await acquireResolutionSlot();
      slotAcquired = true;

      const admin = createAdminClient();
      const { data, error } = await queryTolerantToMissingArchived(
        () =>
          admin
            .from("channel_sessions")
            .select(`id, organization_id, provider, display_name, phone_number${includeSecret ? ", webhook_secret_encrypted" : ""}, ${ARCHIVED_AT}`)
            .eq("webhook_path_token", token)
            .maybeSingle(),
        () =>
          admin
            .from("channel_sessions")
            .select(`id, organization_id, provider, display_name, phone_number${includeSecret ? ", webhook_secret_encrypted" : ""}`)
            .eq("webhook_path_token", token)
            .maybeSingle(),
      );

      if (error) throw new Error("webhook_session_lookup_failed");

      const sessao = data as CachedWebhookSession["sessao"];
      const cifrado = sessao?.webhook_secret_encrypted;
      const secret = includeSecret && cifrado ? await decryptWebhookSecret(admin, cifrado as string) : null;
      return { sessao, secret };
    } finally {
      if (slotAcquired) releaseResolutionSlot();
      if (_inFlightResolutions.get(resolutionKey) === resolutionPromise) {
        _inFlightResolutions.delete(resolutionKey);
      }
    }
  });

  _inFlightResolutions.set(resolutionKey, resolutionPromise);
  return resolutionPromise;
}
