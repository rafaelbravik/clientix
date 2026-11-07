import { z } from "zod";
import type { SignedLicenseDocument, LicensePayload } from "./types";

/**
 * Maximum document byte length to guard against resource exhaustion / DoS.
 * 64 KB is vastly larger than any legitimate license JSON (< 4 KB).
 */
export const MAX_LICENSE_DOCUMENT_BYTES = 64 * 1024;

/**
 * Default grace period in days.
 */
export const DEFAULT_GRACE_PERIOD_DAYS = 7;

/**
 * Supported Ed25519 signature algorithm identifier.
 */
export const SUPPORTED_ALGORITHM = "Ed25519" as const;

/**
 * Supported license schema version.
 */
export const CURRENT_LICENSE_VERSION = 1 as const;

/**
 * Regex for ISO-8601 UTC timestamp ending in Z.
 * Example: 2026-10-07T12:00:00Z or with millis 2026-10-07T12:00:00.000Z
 */
const ISO_8601_UTC_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

const IsoUtcStringSchema = z
  .string()
  .regex(ISO_8601_UTC_REGEX, "Data deve estar no formato ISO-8601 UTC (ex: 2026-10-07T00:00:00Z)")
  .refine((val) => {
    const timestamp = Date.parse(val);
    if (Number.isNaN(timestamp)) return false;
    const normalized = val.replace(/(?:\.(\d{1,3}))?Z$/, (_match, fraction?: string) => {
      return `.${(fraction ?? "").padEnd(3, "0")}Z`;
    });
    return new Date(timestamp).toISOString() === normalized;
  }, "Data inválida");

export const LicenseCustomerSchema = z
  .object({
    id: z.string().min(1, "Customer id é obrigatório").max(100),
    name: z.string().min(1, "Customer name é obrigatório").max(200),
    email: z.string().email("Email inválido").max(200).optional(),
    country: z
      .string()
      .length(2, "Country deve ser código ISO-3166-1 alpha-2 de 2 letras")
      .toUpperCase()
      .optional(),
  })
  .strict();

export const LicenseEntitlementsSchema = z
  .object({
    max_installations: z.number().int().min(1, "max_installations deve ser >= 1"),
    max_tenants: z.number().int().min(1, "max_tenants deve ser >= 1").nullable(), // null = unlimited
    resale_allowed: z.boolean(),
    white_label: z.boolean(),
    features: z.array(z.string().min(1).max(50)).max(100),
  })
  .strict();

export const LicensePayloadSchema = z
  .object({
    license_version: z.literal(1),
    license_revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
    license_id: z.string().min(1, "license_id é obrigatório").max(100),
    serial: z
      .string()
      .min(8)
      .max(64)
      .regex(/^[A-Z0-9-]+$/)
      .optional(),
    customer: LicenseCustomerSchema,
    license_type: z.enum(["internal", "partner", "enterprise"]),
    plan: z.enum(["standard", "pro", "enterprise"]).optional(),
    product: z.string().min(1).max(80).optional(),
    deployment: z.string().min(1).max(80).optional(),
    status: z.enum(["ACTIVE", "SUSPENDED", "EXPIRED", "REVOKED"]).optional(),
    installation_id: z.string().min(1, "installation_id é obrigatório").max(100),
    entitlements: LicenseEntitlementsSchema,
    grace_period_days: z.number().int().min(0).max(90).optional(),
    issued_at: IsoUtcStringSchema,
    valid_from: IsoUtcStringSchema,
    expires_at: IsoUtcStringSchema,
    maintenance_until: IsoUtcStringSchema.optional(),
  })
  .strict()
  .refine(
    (data) => {
      const from = Date.parse(data.valid_from);
      const to = Date.parse(data.expires_at);
      return from < to;
    },
    {
      message: "valid_from deve ser estritamente anterior a expires_at",
      path: ["expires_at"],
    },
  );

export const SignedLicenseDocumentSchema = z
  .object({
    payload: LicensePayloadSchema,
    signature: z
      .string()
      .min(1, "signature é obrigatória")
      .regex(/^[A-Za-z0-9_-]+$/, "Assinatura deve ser codificada em base64url"),
    algorithm: z.literal(SUPPORTED_ALGORITHM),
    key_id: z.string().min(1, "key_id é obrigatório").max(100),
  })
  .strict();

export function parseSignedLicenseDocument(input: unknown): SignedLicenseDocument {
  return SignedLicenseDocumentSchema.parse(input) as SignedLicenseDocument;
}

export function parseLicensePayload(input: unknown): LicensePayload {
  return LicensePayloadSchema.parse(input) as LicensePayload;
}
