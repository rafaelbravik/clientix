import type { LicenseStatusInfo } from "./enforcement";

const DAY_MS = 24 * 60 * 60 * 1000;

export interface LicenseAdminSummary {
  status: LicenseStatusInfo["commercial_status"];
  usable: boolean;
  restricted_mode_active: boolean;
  serial_masked: string | null;
  plan: LicenseStatusInfo["plan"] | null;
  expires_at: string | null;
  days_remaining: number | null;
  grace_until: string | null;
  grace_period_days: number;
  installation_id_masked: string | null;
  last_validated_at: string;
  enforcement_mode: LicenseStatusInfo["enforcement_mode"];
  clock_rollback_suspected: boolean;
  clock_baseline_available: boolean;
  error_code: LicenseStatusInfo["error_code"] | null;
  license_server_status: LicenseStatusInfo["license_server_status"] | null;
  clone_status: LicenseStatusInfo["clone_status"] | null;
  last_successful_online_validation: string | null;
  next_online_validation_at: string | null;
  offline_validation_tolerance_days: number | null;
}

function maskSerial(serial: string | undefined): string | null {
  if (!serial) return null;
  if (serial.length < 8) return "••••";
  const tail = serial.slice(-4);
  const prefix = serial.startsWith("CLX-") ? "CLX-" : "";
  return `${prefix}••••-••••-${tail}`;
}

function maskInstallationId(id: string | undefined): string | null {
  if (!id) return null;
  const prefix = id.startsWith("inst_") ? "inst_" : "";
  const value = prefix ? id.slice(prefix.length) : id;
  return `${prefix}${value.slice(0, 4)}…${value.slice(-4)}`;
}

export function createLicenseAdminSummary(
  status: LicenseStatusInfo,
  now: Date = new Date(),
): LicenseAdminSummary {
  const expiresAtMs = status.expires_at ? Date.parse(status.expires_at) : Number.NaN;
  const daysRemaining = Number.isFinite(expiresAtMs)
    ? Math.max(0, Math.ceil((expiresAtMs - now.getTime()) / DAY_MS))
    : null;

  return {
    status: status.commercial_status,
    usable: status.usable,
    restricted_mode_active: status.restricted_mode_active,
    serial_masked: maskSerial(status.serial ?? status.license_id),
    plan: status.plan ?? null,
    expires_at: status.expires_at ?? null,
    days_remaining: daysRemaining,
    grace_until: status.grace_until ?? null,
    grace_period_days: status.grace_period_days,
    installation_id_masked: maskInstallationId(status.installation_id_expected),
    last_validated_at: status.last_validated_at,
    enforcement_mode: status.enforcement_mode,
    clock_rollback_suspected: status.clock_rollback_suspected,
    clock_baseline_available: status.clock_baseline_available,
    error_code: status.error_code ?? null,
    license_server_status: status.license_server_status ?? null,
    clone_status: status.clone_status ?? null,
    last_successful_online_validation: status.last_successful_online_validation ?? null,
    next_online_validation_at: status.next_online_validation_at ?? null,
    offline_validation_tolerance_days: status.offline_validation_tolerance_days ?? null,
  };
}
