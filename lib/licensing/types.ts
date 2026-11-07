export type LicenseType = "internal" | "partner" | "enterprise";
export type LicensePlan = "standard" | "pro" | "enterprise";
export type LicenseCommercialState =
  "ACTIVE" | "GRACE" | "EXPIRED" | "SUSPENDED" | "REVOKED" | "INVALID";

export type LicenseState =
  | "VALID"
  | "NOT_YET_VALID"
  | "GRACE"
  | "EXPIRED"
  | "SUSPENDED"
  | "REVOKED"
  | "INVALID_SIGNATURE"
  | "INSTALLATION_MISMATCH"
  | "UNSUPPORTED_LICENSE_VERSION"
  | "UNKNOWN_KEY"
  | "LICENSE_FILE_MISSING"
  | "LICENSE_FILE_UNREADABLE"
  | "LICENSE_FILE_IO_ERROR"
  | "LICENSE_SERVER_UNAVAILABLE"
  | "ONLINE_VALIDATION_STALE"
  | "MALFORMED_DOCUMENT"
  | "INSTALLATION_ID_UNAVAILABLE";

export type LicenseErrorCode =
  | "LICENSE_MALFORMED"
  | "LICENSE_PAYLOAD_TOO_LARGE"
  | "LICENSE_VERSION_UNSUPPORTED"
  | "LICENSE_UNKNOWN_KEY"
  | "LICENSE_FILE_MISSING"
  | "LICENSE_FILE_UNREADABLE"
  | "LICENSE_FILE_IO_ERROR"
  | "LICENSE_SERVER_UNAVAILABLE"
  | "LICENSE_INVALID_JSON"
  | "LICENSE_INVALID_SIGNATURE"
  | "LICENSE_INSTALLATION_MISMATCH"
  | "LICENSE_NOT_YET_VALID"
  | "LICENSE_EXPIRED"
  | "LICENSE_CLOCK_SKEW"
  | "LICENSE_REVOKED"
  | "LICENSE_SUSPENDED"
  | "LICENSE_ONLINE_VALIDATION_STALE"
  | "LICENSE_PRODUCT_MISMATCH"
  | "LICENSE_INSTALLATION_ID_UNAVAILABLE";

export interface LicenseCustomer {
  id: string;
  name: string;
  email?: string;
  country?: string;
}

export interface LicenseEntitlements {
  max_installations: number;
  max_tenants: number | null; // null = unlimited
  resale_allowed: boolean;
  white_label: boolean;
  features: string[];
}

export interface LicensePayload {
  license_version: 1;
  /** Monotonic signed-artifact revision; independent from the payload schema version above. */
  license_revision?: number;
  license_id: string;
  /** Serial comercial opcional para manter compatibilidade com documentos v1 já emitidos. */
  serial?: string;
  customer: LicenseCustomer;
  license_type: LicenseType;
  /** Plano comercial da instalação; não substitui o plano resolvido por organização. */
  plan?: LicensePlan;
  product?: string;
  deployment?: string;
  /** Campo assinado localmente; a revogação remota pertence a uma wave futura. */
  status?: "ACTIVE" | "SUSPENDED" | "EXPIRED" | "REVOKED";
  installation_id: string;
  entitlements: LicenseEntitlements;
  /** Ausente em documentos v1 antigos: aplica o default compatível de sete dias. */
  grace_period_days?: number;
  issued_at: string; // ISO-8601 UTC
  valid_from: string; // ISO-8601 UTC
  expires_at: string; // ISO-8601 UTC
  maintenance_until?: string; // ISO-8601 UTC
}

export interface SignedLicenseDocument {
  payload: LicensePayload;
  signature: string; // Base64url (RFC 4648)
  algorithm: "Ed25519";
  key_id: string;
}

export interface VerifyLicenseOptions {
  now?: Date;
  expectedInstallationId?: string;
  gracePeriodDays?: number;
  trustedKeys?: Record<string, string>; // key_id -> raw public key (hex/base64/base64url) or PEM
}

export interface VerifyLicenseResult {
  valid: boolean; // Retained for backward-compat (equals usable && cryptographic_valid)
  usable: boolean; // True if license permits current system operation (VALID or GRACE)
  cryptographic_valid: boolean; // True if digital signature is mathematically valid
  state: LicenseState;
  reason: string;
  errorCode?: LicenseErrorCode;
  payload?: LicensePayload;
  key_id?: string;
  license_id?: string;
  expires_at?: string;
  grace_until?: string;
  grace_period_days?: number;
}

export interface InstallationIdStorage {
  read(): Promise<string | null>;
  write(id: string): Promise<void>;
}
