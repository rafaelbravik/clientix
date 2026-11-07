import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import {
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";
import { hasSameOrigin, readJsonBodyLimited } from "@/control-plane/src/http-input";

const querySchema = z.object({
  status: z.enum(["DRAFT", "ACTIVE", "EXPIRED", "SUSPENDED", "REVOKED"]).optional(),
  plan: z.enum(["standard", "pro", "enterprise"]).optional(),
  license_type: z.enum(["internal", "partner", "enterprise"]).optional(),
  customer_id: z.string().uuid().optional(),
  expires_in_days: z.coerce.number().int().min(0).max(365).optional(),
  validity: z.enum(["VALID", "GRACE", "EXPIRED", "NOT_YET_VALID"]).optional(),
  installation_status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
  clone_status: z
    .enum(["NORMAL", "SUSPECTED_CLONE", "CLONE_CONFIRMED", "TRANSFER_PENDING"])
    .optional(),
  search: z.string().trim().max(100).optional(),
  sort: z
    .enum(["customer", "status", "expires_at", "created_at", "last_validation"])
    .default("created_at"),
  direction: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

const createSchema = z
  .object({
    customer_id: z.string().uuid(),
    license_type: z.enum(["internal", "partner", "enterprise"]),
    plan: z.enum(["standard", "pro", "enterprise"]).default("pro"),
    max_installations: z.number().int().min(1).max(10_000).default(1),
    max_tenants: z.number().int().min(1).max(1_000_000).optional().nullable(),
    resale_allowed: z.boolean().default(false),
    white_label: z.boolean().default(false),
    features: z.array(z.string().trim().min(1).max(100)).max(200).default([]),
    valid_from: z.string().datetime({ offset: true }).optional(),
    expires_at: z.string().datetime({ offset: true }),
    maintenance_until: z.string().datetime({ offset: true }).optional().nullable(),
    grace_days: z.number().int().min(0).max(90).default(7),
    offline_validation_tolerance_days: z.number().int().min(0).max(30).default(7),
    next_check_hours: z.number().int().min(1).max(720).default(24),
    signing_key_id: z.string().min(1).max(100).optional(),
  })
  .strict();

export async function GET(request: Request) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "License Server administrator required.", 403, { requestId });
  }
  const url = new URL(request.url);
  const parsed = querySchema.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return fail("invalid_request", "Invalid license query.", 400, { requestId });
  try {
    const result = await getControlPlaneAdminService().listCommercialLicenses(parsed.data);
    return ok(result.items, {
      requestId,
      meta: {
        total: result.total,
        limit: result.limit,
        offset: result.offset,
        has_more: result.offset + result.items.length < result.total,
      },
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return fail("database_error", "Licenses could not be loaded.", 500, { requestId });
  }
}

export async function POST(request: Request) {
  const requestId = randomUUID();
  if (!hasSameOrigin(request))
    return fail("forbidden", "Same-origin request required.", 403, { requestId });
  let admin;
  try {
    admin = await requirePlatformAdminEscrita();
  } catch (error) {
    return falhaDaEscritaDePlatformAdmin(error, requestId);
  }
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 200) {
    return fail("invalid_request", "A valid Idempotency-Key header is required.", 400, {
      requestId,
    });
  }
  let body: unknown;
  try {
    body = await readJsonBodyLimited(request, 16_384);
  } catch {
    return fail("invalid_request", "Invalid license input.", 400, { requestId });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success)
    return fail("validation_failed", "Invalid license input.", 400, { requestId });
  try {
    const license = await getControlPlaneAdminService().createLicense({
      ...parsed.data,
      idempotency_key: idempotencyKey,
      request_id: requestId,
      actor: admin.user.id,
    });
    return ok(license, { status: 201, requestId });
  } catch {
    return fail("invalid_request", "License draft could not be created.", 400, { requestId });
  }
}
