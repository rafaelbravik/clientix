export type LicenseType = "internal" | "partner" | "enterprise";

export type LicenseState =
  | "VALID"
  | "NOT_YET_VALID"
  | "GRACE"
  | "EXPIRED"
  | "INVALID_SIGNATURE"
  | "INSTALLATION_MISMATCH"
  | "UNSUPPORTED_LICENSE_VERSION"
  | "UNKNOWN_KEY"
  | "MALFORMED_DOCUMENT";

export type LicenseErrorCode =
  | "LICENSE_MALFORMED"
  | "LICENSE_PAYLOAD_TOO_LARGE"
  | "LICENSE_VERSION_UNSUPPORTED"
  | "LICENSE_UNKNOWN_KEY"
  | "LICENSE_INVALID_SIGNATURE"
  | "LICENSE_INSTALLATION_MISMATCH"
  | "LICENSE_NOT_YET_VALID"
  | "LICENSE_EXPIRED"
  | "LICENSE_CLOCK_SKEW";

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
  license_id: string;
  customer: LicenseCustomer;
  license_type: LicenseType;
  installation_id: string;
  entitlements: LicenseEntitlements;
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
}

export interface InstallationIdStorage {
  read(): Promise<string | null>;
  write(id: string): Promise<void>;
}
