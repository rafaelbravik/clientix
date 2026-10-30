import { ProspectingError } from "./provider";

export const LOCAL_HTTP_SEARCH_POLICY = {
  maxPerOrganizationPer24Hours: 20,
  minIntervalMs: 60_000,
  maxConcurrentPerOrganization: 1,
  maxConcurrentGlobal: 3,
} as const;

export interface LocalHttpSearchUsage {
  acceptedInLast24Hours: number;
  lastAcceptedAt: Date | null;
  activeForOrganization: number;
}

export function assertLocalHttpSearchCapacity(usage: LocalHttpSearchUsage, now = Date.now()): void {
  if (usage.acceptedInLast24Hours >= LOCAL_HTTP_SEARCH_POLICY.maxPerOrganizationPer24Hours)
    throw new ProspectingError(
      "O limite de 20 buscas por organização nas últimas 24 horas foi atingido.",
      429,
      "campanha",
      "prospecting_search_quota_exceeded",
    );
  if (usage.lastAcceptedAt && now - usage.lastAcceptedAt.getTime() < LOCAL_HTTP_SEARCH_POLICY.minIntervalMs)
    throw new ProspectingError(
      "Aguarde 60 segundos entre buscas desta organização.",
      429,
      "campanha",
      "prospecting_search_interval",
    );
  if (usage.activeForOrganization >= LOCAL_HTTP_SEARCH_POLICY.maxConcurrentPerOrganization)
    throw new ProspectingError(
      "Esta organização já tem uma busca local ativa ou aguardando vez.",
      409,
      "campanha",
      "prospecting_search_concurrency",
    );
}

export function localHttpGlobalSlots(activeGlobal: number): number {
  return Math.max(0, LOCAL_HTTP_SEARCH_POLICY.maxConcurrentGlobal - activeGlobal);
}
