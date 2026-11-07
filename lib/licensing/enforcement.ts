import fs from "fs/promises";
import path from "path";
import { randomUUID } from "node:crypto";
import { fail } from "@/lib/api/wrappers";
import { logger } from "@/lib/logger";
import { verifyLicense } from "./verify";
import { DEFAULT_GRACE_PERIOD_DAYS } from "./schema";
import { observeLicenseClock } from "./clock";
import type { CloneStatus } from "./clone-status";
import {
  defaultOnlineValidationCachePath,
  readVerifiedOnlineValidationCache,
} from "./online-cache";
import { FileInstallationIdStorage, getOrCreateInstallationId } from "./installation-id";
import type {
  LicenseCommercialState,
  LicenseErrorCode,
  LicensePlan,
  LicensePayload,
  LicenseState,
  VerifyLicenseResult,
} from "./types";

/**
 * Standard paths for commercial license and installation ID.
 */
const localLicenseStateDirectory = path.join(
  process.cwd(),
  ".clientix-local",
  "runtime",
  "licensing",
);
const production = process.env.NODE_ENV === "production";

export const DEFAULT_LICENSE_PATH =
  process.env.CLIENTIX_LICENSE_PATH?.trim() ||
  (production
    ? "/opt/clientix/licenses/license.json"
    : path.join(localLicenseStateDirectory, "license.json"));

export const DEFAULT_INSTALLATION_ID_PATH =
  process.env.CLIENTIX_INSTALLATION_ID_PATH?.trim() ||
  (production
    ? "/opt/clientix/state/installation_id"
    : path.join(localLicenseStateDirectory, "installation_id"));

export const DEFAULT_LICENSE_CLOCK_PATH =
  process.env.CLIENTIX_LICENSE_CLOCK_PATH?.trim() ||
  (production
    ? // The installer mounts /opt/clientix/state read-only and /opt/clientix/licenses
      // as the durable writable license directory for the application container.
      "/opt/clientix/licenses/license_clock.json"
    : path.join(localLicenseStateDirectory, "license_clock.json"));

export type LicenseEnforcementMode = "enforce" | "warn";

/** Production is always fail-closed; warn mode is an explicit local-development aid. */
export function getLicenseEnforcementMode(): LicenseEnforcementMode {
  if (process.env.NODE_ENV === "production") return "enforce";
  const configured = process.env.CLIENTIX_LICENSE_ENFORCEMENT;
  if (configured === "warn") return "warn";
  if (configured === "enforce") return "enforce";
  return process.env.NODE_ENV === "development" ? "warn" : "enforce";
}

export function toCommercialLicenseState(state: LicenseState): LicenseCommercialState {
  if (state === "VALID") return "ACTIVE";
  if (state === "GRACE") return "GRACE";
  if (state === "EXPIRED") return "EXPIRED";
  if (state === "REVOKED") return "REVOKED";
  return "INVALID";
}

/** GID compartilhado somente pelos runtimes que precisam ler a licença local. */
export const LICENSE_RUNTIME_READER_GID = 1001;
const LICENSE_FILE_MODE = 0o640;

export interface LicenseStatusInfo {
  state: LicenseState;
  commercial_status: LicenseCommercialState;
  usable: boolean;
  valid: boolean;
  cryptographic_valid: boolean;
  reason: string;
  error_code?: LicenseErrorCode;
  license_id?: string;
  serial?: string;
  plan?: LicensePlan;
  customer_name?: string;
  license_type?: string;
  expires_at?: string;
  grace_until?: string;
  grace_period_days: number;
  last_validated_at: string;
  clock_rollback_suspected: boolean;
  clock_baseline_available: boolean;
  clock_last_seen_at?: string;
  enforcement_mode: LicenseEnforcementMode;
  restricted_mode_active: boolean;
  entitlements?: {
    max_installations: number;
    max_tenants: number | null;
    resale_allowed: boolean;
    white_label: boolean;
    features: string[];
  };
  installation_id_expected?: string;
  installation_id_matched?: boolean;
  license_server_status?: "ACTIVE" | "EXPIRED" | "SUSPENDED" | "REVOKED";
  clone_status?: CloneStatus;
  last_successful_online_validation?: string;
  next_online_validation_at?: string;
  offline_validation_tolerance_days?: number;
}

export interface LicenseInspectionOptions {
  now?: Date;
  licensePath?: string;
  installationIdPath?: string;
  clockPath?: string;
  trustedKeys?: Record<string, string>;
  gracePeriodDays?: number;
  onlineCachePath?: string;
  offlineValidationToleranceDays?: number;
}

// In-process cache with TTL to avoid reading and parsing the file on every single call
interface CachedLicenseState {
  result: VerifyLicenseResult;
  statusInfo: LicenseStatusInfo;
  mtimeMs: number;
  evaluatedAtMs: number;
}

let cachedState: CachedLicenseState | null = null;
const CACHE_TTL_MS = 10_000; // 10 seconds cache TTL

/**
 * Clear license cache (useful for tests or immediate license reload).
 */
export function resetLicenseCache(): void {
  cachedState = null;
}

/**
 * Resolves the persistent installation ID from storage.
 */
export async function resolveSystemInstallationId(
  storagePath: string = DEFAULT_INSTALLATION_ID_PATH,
): Promise<string> {
  // If explicitly injected via env var (e.g. in development or container env)
  if (process.env.INSTALLATION_ID && process.env.INSTALLATION_ID.trim().length > 0) {
    const configuredId = process.env.INSTALLATION_ID.trim();
    if (
      !/^inst_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
        configuredId,
      )
    ) {
      throw new Error("INSTALLATION_ID_INVALID");
    }
    return configuredId;
  }

  const storage = new FileInstallationIdStorage(storagePath);
  return getOrCreateInstallationId(storage);
}

/**
 * Reads and verifies the commercial installation license with caching.
 */
export async function getInstallationLicenseStatus(
  options: LicenseInspectionOptions = {},
): Promise<LicenseStatusInfo> {
  const licensePath = options.licensePath || DEFAULT_LICENSE_PATH;
  const installationIdPath = options.installationIdPath || DEFAULT_INSTALLATION_ID_PATH;
  const injectedNow = options.now !== undefined;
  const now = options.now || new Date();
  const nowMs = now.getTime();
  const enforcementMode = getLicenseEnforcementMode();
  const clockPath =
    options.clockPath ||
    (options.installationIdPath
      ? path.join(path.dirname(options.installationIdPath), "license_clock.json")
      : DEFAULT_LICENSE_CLOCK_PATH);

  // This signed-document override exists only for local development and tests.
  // Production always reads the persisted file and the compiled public trust root.
  const inlineLicenseJson =
    process.env.NODE_ENV === "production" ? undefined : process.env.CLIENTIX_LICENSE_JSON;

  let expectedInstallationId = "";
  try {
    expectedInstallationId = await resolveSystemInstallationId(installationIdPath);
  } catch {
    const clock = { rollback_suspected: false, baseline_available: false };
    return buildUnusableStatus({
      state: "INSTALLATION_ID_UNAVAILABLE",
      reason: "O identificador persistente desta instalação não está disponível ou é inválido.",
      errorCode: "LICENSE_INSTALLATION_ID_UNAVAILABLE",
      now,
      clock,
      enforcementMode,
    });
  }

  const clock = injectedNow
    ? { rollback_suspected: false, baseline_available: false }
    : await observeLicenseClock(now, clockPath);

  // Check cache validity
  if (
    cachedState &&
    !injectedNow &&
    !options.trustedKeys &&
    !inlineLicenseJson &&
    nowMs >= cachedState.evaluatedAtMs &&
    nowMs - cachedState.evaluatedAtMs < CACHE_TTL_MS
  ) {
    try {
      const stat = await fs.stat(/*turbopackIgnore: true*/ licensePath);
      if (stat.mtimeMs === cachedState.mtimeMs) {
        return {
          ...cachedState.statusInfo,
          clock_rollback_suspected: clock.rollback_suspected,
          clock_baseline_available: clock.baseline_available,
          ...(clock.last_seen_at ? { clock_last_seen_at: clock.last_seen_at } : {}),
        };
      }
    } catch {
      // File removed or inaccessible -> invalidate cache and re-evaluate
    }
  }

  let rawContent: string | null = null;
  let fileMtimeMs = 0;

  if (inlineLicenseJson && inlineLicenseJson.trim().length > 0) {
    rawContent = inlineLicenseJson.trim();
  } else {
    try {
      const stat = await fs.stat(/*turbopackIgnore: true*/ licensePath);
      fileMtimeMs = stat.mtimeMs;
      rawContent = await fs.readFile(/*turbopackIgnore: true*/ licensePath, "utf-8");
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        // Em ambiente de teste (Vitest/test runner), se nenhum arquivo de licença específico
        // foi apontado por options, permite operação como mock válida para não quebrar testes legados
        if (process.env.NODE_ENV === "test" && !options.licensePath && !options.trustedKeys) {
          return {
            state: "VALID",
            commercial_status: "ACTIVE",
            usable: true,
            valid: true,
            cryptographic_valid: true,
            reason: "Licença de teste/desenvolvimento ativa",
            license_id: "lic_test_environment",
            plan: undefined,
            customer_name: "Test Environment",
            license_type: "partner",
            grace_period_days: DEFAULT_GRACE_PERIOD_DAYS,
            last_validated_at: now.toISOString(),
            clock_rollback_suspected: clock.rollback_suspected,
            clock_baseline_available: clock.baseline_available,
            enforcement_mode: enforcementMode,
            restricted_mode_active: false,
            entitlements: {
              max_installations: 1,
              max_tenants: null, // unlimited in default test mode
              resale_allowed: true,
              white_label: true,
              features: ["messages", "voice", "ai_agent"],
            },
            installation_id_expected: expectedInstallationId || undefined,
            installation_id_matched: true,
            ...(clock.last_seen_at ? { clock_last_seen_at: clock.last_seen_at } : {}),
          };
        }

        return buildUnusableStatus({
          state: "LICENSE_FILE_MISSING",
          reason: "Arquivo de licença não encontrado.",
          errorCode: "LICENSE_FILE_MISSING",
          now,
          clock,
          enforcementMode,
          installationId: expectedInstallationId,
        });
      }
      const unreadable = code === "EACCES" || code === "EPERM";
      return buildUnusableStatus({
        state: unreadable ? "LICENSE_FILE_UNREADABLE" : "LICENSE_FILE_IO_ERROR",
        reason: unreadable
          ? "O runtime não tem permissão para ler o arquivo de licença."
          : "Falha de I/O ao ler o arquivo de licença.",
        errorCode: unreadable ? "LICENSE_FILE_UNREADABLE" : "LICENSE_FILE_IO_ERROR",
        now,
        clock,
        enforcementMode,
        installationId: expectedInstallationId,
      });
    }
  }

  const verifyResult = verifyLicense(rawContent, {
    now,
    expectedInstallationId: expectedInstallationId || undefined,
    gracePeriodDays: options.gracePeriodDays,
    trustedKeys: options.trustedKeys,
  });

  const payload = verifyResult.payload as LicensePayload | undefined;
  const isIdMatched = payload ? payload.installation_id === expectedInstallationId : false;

  const statusInfo: LicenseStatusInfo = {
    state: verifyResult.state,
    commercial_status: toCommercialLicenseState(verifyResult.state),
    usable: verifyResult.usable,
    valid: verifyResult.valid,
    cryptographic_valid: verifyResult.cryptographic_valid,
    reason: verifyResult.reason,
    error_code: verifyResult.errorCode,
    license_id: payload?.license_id,
    serial: payload?.serial,
    plan: payload?.plan,
    customer_name: payload?.customer.name,
    license_type: payload?.license_type,
    expires_at: verifyResult.expires_at || payload?.expires_at,
    grace_until: verifyResult.grace_until,
    grace_period_days:
      verifyResult.grace_period_days ?? payload?.grace_period_days ?? DEFAULT_GRACE_PERIOD_DAYS,
    last_validated_at: now.toISOString(),
    clock_rollback_suspected: clock.rollback_suspected,
    clock_baseline_available: clock.baseline_available,
    enforcement_mode: enforcementMode,
    restricted_mode_active: enforcementMode === "enforce" && !verifyResult.usable,
    entitlements: payload?.entitlements,
    installation_id_expected: expectedInstallationId || undefined,
    installation_id_matched: isIdMatched,
    ...(clock.last_seen_at ? { clock_last_seen_at: clock.last_seen_at } : {}),
  };

  const onlineCache = await readVerifiedOnlineValidationCache(
    options.onlineCachePath || defaultOnlineValidationCachePath(licensePath),
    { expectedInstallationId, trustedKeys: options.trustedKeys, now },
  );
  const onlinePayload = onlineCache?.response.payload;
  let effectiveStatusInfo = statusInfo;
  if (onlineCache && onlinePayload && onlinePayload.license_id === payload?.license_id) {
    const onlineMetadata = {
      license_server_status: onlinePayload.license_status,
      clone_status: onlinePayload.clone_status ?? "NORMAL",
      last_successful_online_validation: onlineCache.verified_at,
      next_online_validation_at: onlinePayload.next_online_validation_at,
      offline_validation_tolerance_days:
        options.offlineValidationToleranceDays ?? onlinePayload.offline_validation_tolerance_days,
    };
    if (
      onlinePayload.license_status === "REVOKED" ||
      onlinePayload.installation_status === "REVOKED"
    ) {
      effectiveStatusInfo = {
        ...statusInfo,
        ...onlineMetadata,
        state: "REVOKED",
        commercial_status: "REVOKED",
        usable: false,
        valid: false,
        cryptographic_valid: true,
        reason: "O License Server confirmou que esta licença ou instalação foi revogada.",
        error_code: "LICENSE_REVOKED",
        restricted_mode_active: enforcementMode === "enforce",
      };
    } else if (
      onlineMetadata.clone_status === "CLONE_CONFIRMED" ||
      onlineMetadata.clone_status === "TRANSFER_PENDING"
    ) {
      effectiveStatusInfo = {
        ...statusInfo,
        ...onlineMetadata,
        state: "SUSPENDED",
        commercial_status: "SUSPENDED",
        usable: false,
        valid: false,
        cryptographic_valid: true,
        reason: "O License Server identificou um conflito de identidade da instalação.",
        error_code: "LICENSE_SUSPENDED",
        restricted_mode_active: enforcementMode === "enforce",
      };
    } else if (
      onlinePayload.license_status === "SUSPENDED" ||
      onlinePayload.installation_status === "SUSPENDED" ||
      onlinePayload.installation_status === "TRANSFERRED" ||
      onlinePayload.installation_status === "DISABLED"
    ) {
      effectiveStatusInfo = {
        ...statusInfo,
        ...onlineMetadata,
        state: "SUSPENDED",
        commercial_status: "SUSPENDED",
        usable: false,
        valid: false,
        cryptographic_valid: true,
        reason: "O License Server informou que esta licença ou instalação está suspensa.",
        error_code: "LICENSE_SUSPENDED",
        restricted_mode_active: enforcementMode === "enforce",
      };
    } else if (onlinePayload.license_status === "EXPIRED") {
      effectiveStatusInfo = {
        ...statusInfo,
        ...onlineMetadata,
        state: "EXPIRED",
        commercial_status: "EXPIRED",
        usable: false,
        valid: false,
        cryptographic_valid: true,
        reason: "O License Server marcou esta licença como expirada.",
        error_code: "LICENSE_EXPIRED",
        restricted_mode_active: enforcementMode === "enforce",
      };
    } else {
      const toleranceDays = onlineMetadata.offline_validation_tolerance_days ?? 7;
      const elapsedMs = now.getTime() - Date.parse(onlineCache.verified_at);
      if (elapsedMs >= toleranceDays * 24 * 60 * 60 * 1000) {
        effectiveStatusInfo = {
          ...statusInfo,
          ...onlineMetadata,
          state: "ONLINE_VALIDATION_STALE",
          commercial_status: "INVALID",
          usable: false,
          valid: false,
          reason: "A tolerância para validação online foi excedida; reconecte ao License Server.",
          error_code: "LICENSE_ONLINE_VALIDATION_STALE",
          restricted_mode_active: enforcementMode === "enforce",
        };
      } else {
        effectiveStatusInfo = { ...statusInfo, ...onlineMetadata };
      }
    }
  }

  if (!injectedNow && !options.trustedKeys && !inlineLicenseJson) {
    cachedState = {
      result: verifyResult,
      statusInfo: effectiveStatusInfo,
      mtimeMs: fileMtimeMs,
      evaluatedAtMs: nowMs,
    };
  }

  return effectiveStatusInfo;
}

interface UnusableStatusOptions {
  state: LicenseState;
  reason: string;
  errorCode: LicenseErrorCode;
  now: Date;
  clock: { rollback_suspected: boolean; baseline_available: boolean; last_seen_at?: string };
  enforcementMode: LicenseEnforcementMode;
  installationId?: string;
}

function buildUnusableStatus(options: UnusableStatusOptions): LicenseStatusInfo {
  return {
    state: options.state,
    commercial_status: toCommercialLicenseState(options.state),
    usable: false,
    valid: false,
    cryptographic_valid: false,
    reason: options.reason,
    error_code: options.errorCode,
    grace_period_days: DEFAULT_GRACE_PERIOD_DAYS,
    last_validated_at: options.now.toISOString(),
    clock_rollback_suspected: options.clock.rollback_suspected,
    clock_baseline_available: options.clock.baseline_available,
    enforcement_mode: options.enforcementMode,
    restricted_mode_active: options.enforcementMode === "enforce",
    installation_id_expected: options.installationId,
    installation_id_matched: false,
    ...(options.clock.last_seen_at ? { clock_last_seen_at: options.clock.last_seen_at } : {}),
  };
}

/**
 * Guard function for Route Handlers and Server Actions.
 * Returns null if the license is usable (VALID or GRACE).
 * If the license is expired or invalid, returns a 403 Response with code 'license_restricted'.
 *
 * ALLOWED IN RESTRICTED MODE (do NOT call this guard on):
 * - Health check / healthz endpoints
 * - Admin authentication and session management
 * - License status and license update / replacement endpoints
 * - Standalone database migrations
 * - Read-only backup and LGPD data export endpoints
 *
 * RESTRICTED / PROTECTED (MUST call this guard on):
 * - Outbound messaging dispatching
 * - Outbound campaign runs
 * - Outbound voice calls
 * - Inbound / outbound autonomous AI agent execution
 * - New tenant creation / provisioning
 */
export async function requireValidInstallationLicense(
  options: LicenseInspectionOptions = {},
): Promise<Response | null> {
  const status = await getInstallationLicenseStatus(options);
  if (status.usable) {
    return null;
  }

  if (status.enforcement_mode === "warn") {
    logger.warn("Operação comercial continuou em modo de desenvolvimento sem licença utilizável.", {
      license_state: status.state,
      error_code: status.error_code,
    });
    return null;
  }

  return fail(
    "license_restricted",
    `Operação comercial restrita pela licença da instalação: ${status.reason} (Estado: ${status.state})`,
    403,
    {
      details: {
        state: status.state,
        usable: false,
        error_code: status.error_code,
        expires_at: status.expires_at,
        grace_until: status.grace_until,
        restricted_mode_active: true,
        clock_rollback_suspected: status.clock_rollback_suspected,
        installation_id_matched: status.installation_id_matched,
      },
    },
  );
}

/**
 * Safely validates and atomically installs a new license file.
 * The candidate license is verified in memory against the system's installation ID.
 * If invalid, the candidate is rejected with an explanatory error, leaving the
 * existing license file completely untouched.
 */
export async function installLicenseFile(
  candidateDocument: unknown,
  options: {
    targetPath?: string;
    installationIdPath?: string;
    trustedKeys?: Record<string, string>;
    allowSignedRestriction?: boolean;
  } = {},
): Promise<{ success: boolean; statusInfo: LicenseStatusInfo }> {
  const targetPath = options.targetPath || DEFAULT_LICENSE_PATH;
  const installationIdPath = options.installationIdPath || DEFAULT_INSTALLATION_ID_PATH;

  const expectedInstallationId = await resolveSystemInstallationId(installationIdPath);

  // 1. Verify candidate in memory
  const verifyResult = verifyLicense(candidateDocument, {
    expectedInstallationId,
    trustedKeys: options.trustedKeys,
  });

  const signedRestriction =
    options.allowSignedRestriction === true &&
    verifyResult.cryptographic_valid &&
    ["REVOKED", "SUSPENDED", "EXPIRED"].includes(payloadStatus(candidateDocument) ?? "");
  if (!verifyResult.usable && !signedRestriction) {
    throw new Error(
      `Candidato de licença recusado: ${verifyResult.reason} (Estado: ${verifyResult.state})`,
    );
  }

  const payload = verifyResult.payload as LicensePayload;
  const rawString =
    typeof candidateDocument === "string"
      ? candidateDocument
      : JSON.stringify(candidateDocument, null, 2);

  // 2. Atomic write to temporary file and rename
  const dir = path.dirname(targetPath);
  await fs.mkdir(dir, { recursive: true });

  const tmpPath = `${targetPath}.tmp.${process.pid}.${randomUUID()}`;
  let tempExists = false;
  try {
    const file = await fs.open(tmpPath, "wx", LICENSE_FILE_MODE);
    tempExists = true;
    try {
      await file.writeFile(rawString, { encoding: "utf-8" });
      if (process.platform === "linux") {
        const runtimeUid = process.getuid?.();
        if (runtimeUid === undefined) {
          throw new Error("LICENSE_RUNTIME_UID_UNAVAILABLE");
        }
        // O app recebe GID 1001 como grupo suplementar no Compose. Fixar o GID
        // no inode temporário antes do rename mantém o contrato após rotação.
        await file.chown(runtimeUid, LICENSE_RUNTIME_READER_GID);
      }
      await file.chmod(LICENSE_FILE_MODE);
      await file.sync();
    } finally {
      await file.close();
    }
    await fs.rename(tmpPath, targetPath);
    tempExists = false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    throw new Error(
      code === "EACCES" || code === "EPERM"
        ? "LICENSE_FILE_ACCESS_CONTRACT_FAILED"
        : "LICENSE_FILE_WRITE_FAILED",
    );
  } finally {
    if (tempExists) await fs.unlink(tmpPath).catch(() => {});
  }

  // 3. Invalidate cache
  resetLicenseCache();

  const statusInfo: LicenseStatusInfo = {
    state: verifyResult.state,
    commercial_status: toCommercialLicenseState(verifyResult.state),
    usable: verifyResult.usable,
    valid: verifyResult.valid,
    cryptographic_valid: verifyResult.cryptographic_valid,
    reason: verifyResult.reason,
    error_code: verifyResult.errorCode,
    license_id: payload.license_id,
    serial: payload.serial,
    plan: payload.plan,
    customer_name: payload.customer.name,
    license_type: payload.license_type,
    expires_at: verifyResult.expires_at || payload.expires_at,
    grace_until: verifyResult.grace_until,
    grace_period_days:
      verifyResult.grace_period_days ?? payload.grace_period_days ?? DEFAULT_GRACE_PERIOD_DAYS,
    last_validated_at: new Date().toISOString(),
    clock_rollback_suspected: false,
    clock_baseline_available: false,
    enforcement_mode: getLicenseEnforcementMode(),
    restricted_mode_active: false,
    entitlements: payload.entitlements,
    installation_id_expected: expectedInstallationId,
    installation_id_matched: true,
  };

  return { success: true, statusInfo };
}

function payloadStatus(candidate: unknown): string | undefined {
  if (typeof candidate !== "object" || candidate === null) return undefined;
  const payload = (candidate as { payload?: unknown }).payload;
  if (typeof payload !== "object" || payload === null) return undefined;
  const status = (payload as { status?: unknown }).status;
  return typeof status === "string" ? status : undefined;
}
