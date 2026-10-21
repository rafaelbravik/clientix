import { fail } from "@/lib/api/wrappers";
import {
  getInstallationLicenseStatus,
  type LicenseInspectionOptions,
  type LicenseStatusInfo,
} from "./enforcement";
import { isValidInstallationId } from "./installation-id";
import { createAdminClient } from "@/lib/supabase/admin";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Standard commercial capabilities derived from the installation license.
 * Capabilities are strictly derived from signed entitlements (never inferred from license_type alone).
 */
export type InstallationCapability =
  | "can_resell_access"
  | "can_white_label"
  | "can_white_label_installation"
  | "can_white_label_tenant"
  | "can_manage_multiple_tenants";

export interface InstallationCapabilitiesInfo {
  license_type: "internal" | "partner" | "enterprise";
  usable: boolean;
  can_resell_access: boolean;
  can_white_label: boolean;
  can_white_label_installation: boolean;
  can_white_label_tenant: boolean;
  can_manage_multiple_tenants: boolean;
  max_tenants: number | null; // null = unlimited
  features: string[];
}

/**
 * Resolves the effective commercial capabilities of the installation.
 * Fail-closed: missing, malformed, or expired licenses return false for all capabilities.
 */
export async function getInstallationCapabilities(
  options: LicenseInspectionOptions = {}
): Promise<InstallationCapabilitiesInfo> {
  const status = await getInstallationLicenseStatus(options);
  const entitlements = status.entitlements;
  const isUsable = status.usable;

  // If license is not usable (expired, invalid signature, mismatched, missing) -> all false
  if (!isUsable || !entitlements) {
    return {
      license_type: (status.license_type as "internal" | "partner" | "enterprise") || "internal",
      usable: false,
      can_resell_access: false,
      can_white_label: false,
      can_white_label_installation: false,
      can_white_label_tenant: false,
      can_manage_multiple_tenants: false,
      max_tenants: 1,
      features: [],
    };
  }

  const whiteLabelAllowed = Boolean(entitlements.white_label);
  const resaleAllowed = Boolean(entitlements.resale_allowed);
  const maxTenants = entitlements.max_tenants; // null means unlimited, or positive integer
  const canMultiTenant = maxTenants === null || maxTenants > 1;

  return {
    license_type: (status.license_type as "internal" | "partner" | "enterprise") || "internal",
    usable: true,
    can_resell_access: resaleAllowed,
    can_white_label: whiteLabelAllowed,
    can_white_label_installation: whiteLabelAllowed,
    can_white_label_tenant: whiteLabelAllowed,
    can_manage_multiple_tenants: canMultiTenant,
    max_tenants: maxTenants,
    features: entitlements.features || [],
  };
}

/**
 * Checks whether the installation holds a specific capability.
 */
export async function hasInstallationCapability(
  capability: InstallationCapability,
  options: LicenseInspectionOptions = {}
): Promise<boolean> {
  const caps = await getInstallationCapabilities(options);
  switch (capability) {
    case "can_resell_access":
      return caps.can_resell_access;
    case "can_white_label":
    case "can_white_label_installation":
      return caps.can_white_label_installation;
    case "can_white_label_tenant":
      return caps.can_white_label_tenant;
    case "can_manage_multiple_tenants":
      return caps.can_manage_multiple_tenants;
    default:
      return false;
  }
}

/**
 * Guard function for Route Handlers & Server Actions requiring a specific installation capability.
 * Returns null if allowed, or a 403 Response if denied.
 */
export async function requireInstallationCapability(
  capability: InstallationCapability,
  options: LicenseInspectionOptions = {}
): Promise<Response | null> {
  const status = await getInstallationLicenseStatus(options);
  if (!status.usable) {
    return fail(
      "license_restricted",
      `Operação não permitida pela licença da instalação: ${status.reason} (Estado: ${status.state})`,
      403,
      {
        details: {
          capability,
          state: status.state,
          usable: false,
        },
      }
    );
  }

  const allowed = await hasInstallationCapability(capability, options);
  if (!allowed) {
    const isWhiteLabel =
      capability === "can_white_label" ||
      capability === "can_white_label_installation" ||
      capability === "can_white_label_tenant";

    const errCode = isWhiteLabel ? "WHITE_LABEL_NOT_LICENSED" : "CAPABILITY_NOT_LICENSED";
    const msg = isWhiteLabel
      ? "Personalização de marca (white-label) não autorizada pela licença desta instalação."
      : `Funcionalidade '${capability}' não autorizada pela licença desta instalação.`;

    return fail(errCode, msg, 403, {
      details: {
        capability,
        license_type: status.license_type,
        state: status.state,
      },
    });
  }

  return null;
}

/**
 * Returns the maximum number of organizations permitted by the installation license.
 * Returns null for unlimited, or a positive integer.
 */
export async function getInstallationTenantLimit(
  options: LicenseInspectionOptions = {}
): Promise<{ max_tenants: number | null; usable: boolean; installation_id?: string }> {
  const status = await getInstallationLicenseStatus(options);
  const maxTenants = status.entitlements?.max_tenants;
  const validLimit =
    maxTenants === null ||
    (typeof maxTenants === "number" && Number.isSafeInteger(maxTenants) && maxTenants >= 1);
  const installationId = status.installation_id_expected;
  const trustedInstallation =
    typeof installationId === "string" &&
    isValidInstallationId(installationId) &&
    status.installation_id_matched === true;
  const usable = status.usable && validLimit && trustedInstallation;
  return {
    max_tenants: validLimit && maxTenants !== undefined ? maxTenants : 1,
    usable,
    ...(usable && installationId ? { installation_id: installationId } : {}),
  };
}

export const INSTALLATION_TENANT_LIMIT_ERROR = "GLOBAL_TENANT_LIMIT_REACHED";

export class InstallationTenantLimitReachedError extends Error {
  readonly code = INSTALLATION_TENANT_LIMIT_ERROR;

  constructor() {
    super(INSTALLATION_TENANT_LIMIT_ERROR);
    this.name = "InstallationTenantLimitReachedError";
  }
}

/** Recognizes the exact PostgreSQL error emitted by the atomic creation RPC. */
export function isInstallationTenantLimitError(error: unknown): boolean {
  if (error instanceof InstallationTenantLimitReachedError) return true;
  if (typeof error !== "object" || error === null) return false;
  const record = error as { code?: unknown; message?: unknown };
  return (
    record.code === "P0001" &&
    typeof record.message === "string" &&
    record.message.trim() === INSTALLATION_TENANT_LIMIT_ERROR
  );
}

/**
 * Read-only preflight for user-facing details. Creation must still use one of
 * the limited database RPCs; this count is deliberately not an atomic guarantee.
 */
export async function assertCanCreateTenant(
  admin?: SupabaseClient,
  options: LicenseInspectionOptions = {}
): Promise<{ allowed: boolean; current: number; max: number | null; reason?: string }> {
  const { max_tenants, usable } = await getInstallationTenantLimit(options);

  if (!usable) {
    return {
      allowed: false,
      current: 0,
      max: max_tenants,
      reason: "Licença da instalação inválida ou expirada.",
    };
  }

  // If unlimited, allowed immediately
  if (max_tenants === null) {
    return { allowed: true, current: 0, max: null };
  }

  const client = admin || createAdminClient();

  // Keep the existing contract: every organization row occupies a licensed slot.
  const { count, error } = await client
    .from("organizations")
    .select("*", { count: "exact", head: true });

  if (error) {
    throw new Error(`Falha ao verificar contagem de organizações: ${error.message}`);
  }

  const currentCount = count ?? 0;
  if (currentCount >= max_tenants) {
    return {
      allowed: false,
      current: currentCount,
      max: max_tenants,
      reason: `Limite global de organizações atingido (${currentCount}/${max_tenants}). Atualize a licença da instalação para adicionar mais empresas.`,
    };
  }

  return {
    allowed: true,
    current: currentCount,
    max: max_tenants,
  };
}
