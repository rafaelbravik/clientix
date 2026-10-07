import type { LicenseState, LicenseErrorCode } from "./types";
import { DEFAULT_GRACE_PERIOD_DAYS } from "./schema";

export interface ComputeLicenseStateParams {
  validFrom: string; // ISO-8601 UTC
  expiresAt: string; // ISO-8601 UTC
  now?: Date;
  gracePeriodDays?: number;
}

export interface ComputedStateResult {
  state: LicenseState;
  reason: string;
  errorCode?: LicenseErrorCode;
  expires_at: string;
  grace_until: string;
}

/**
 * Pure temporal state calculation:
 * - [valid_from, expires_at): VALID
 * - now < valid_from: NOT_YET_VALID
 * - [expires_at, grace_until): GRACE
 * - now >= grace_until: EXPIRED
 */
export function computeTemporalLicenseState(params: ComputeLicenseStateParams): ComputedStateResult {
  const nowMs = (params.now ?? new Date()).getTime();
  const validFromMs = Date.parse(params.validFrom);
  const expiresAtMs = Date.parse(params.expiresAt);

  const graceDays = params.gracePeriodDays ?? DEFAULT_GRACE_PERIOD_DAYS;
  const gracePeriodMs = graceDays * 24 * 60 * 60 * 1000;
  const graceUntilMs = expiresAtMs + gracePeriodMs;

  const expiresAtIso = new Date(expiresAtMs).toISOString();
  const graceUntilIso = new Date(graceUntilMs).toISOString();

  if (nowMs < validFromMs) {
    return {
      state: "NOT_YET_VALID",
      reason: `Licença ainda não é válida (válida a partir de ${params.validFrom})`,
      errorCode: "LICENSE_NOT_YET_VALID",
      expires_at: expiresAtIso,
      grace_until: graceUntilIso,
    };
  }

  if (nowMs < expiresAtMs) {
    return {
      state: "VALID",
      reason: "Licença ativa e dentro do período de vigência",
      expires_at: expiresAtIso,
      grace_until: graceUntilIso,
    };
  }

  if (nowMs < graceUntilMs) {
    return {
      state: "GRACE",
      reason: `Licença expirou em ${params.expiresAt}, em período de carência (grace period) até ${graceUntilIso}`,
      errorCode: "LICENSE_EXPIRED",
      expires_at: expiresAtIso,
      grace_until: graceUntilIso,
    };
  }

  return {
    state: "EXPIRED",
    reason: `Licença expirada (vigência encerrou em ${params.expiresAt} e tolerância em ${graceUntilIso})`,
    errorCode: "LICENSE_EXPIRED",
    expires_at: expiresAtIso,
    grace_until: graceUntilIso,
  };
}
