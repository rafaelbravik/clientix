import { requireSupportWrite } from "@/lib/impersonate/support";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import {
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin,
} from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";

const createLicenseSchema = z.object({
  customer_id: z.string().uuid("Invalid customer ID"),
  license_type: z.enum(["internal", "partner", "enterprise"]),
  max_installations: z.number().int().min(1, "At least 1 installation required"),
  max_tenants: z.number().int().min(1).optional().nullable(),
  resale_allowed: z.boolean().default(false),
  white_label: z.boolean().default(false),
  features: z.array(z.string()).default([]),
  valid_from: z.string().datetime().optional(),
  expires_at: z.string().datetime("Valid ISO-8601 expiration date required"),
  maintenance_until: z.string().datetime().optional().nullable(),
  grace_days: z.number().int().min(0).max(90).default(7),
  signing_key_id: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const searchParams = req.nextUrl.searchParams;
  const status = searchParams.get("status") as "ACTIVE" | "SUSPENDED" | "REVOKED" | null;
  const license_type = searchParams.get("license_type") as ("enterprise" | "partner" | "internal") | null;
  const customer_id = searchParams.get("customer_id") || undefined;
  const search = searchParams.get("search") || undefined;
  const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : 50;
  const offset = searchParams.get("offset") ? Number(searchParams.get("offset")) : 0;

  try {
    const adminService = getControlPlaneAdminService();
    const licenses = await adminService.listLicenses({
      status: status || undefined,
      license_type: license_type || undefined,
      customer_id,
      search,
      limit,
      offset,
    });
    return ok(licenses, { requestId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error listing licenses";
    return fail("database_error", message, 500, { requestId });
  }
}

export async function POST(req: NextRequest) {
  const requestId = randomUUID();
  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdminEscrita>>;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("invalid_request", "Invalid JSON payload", 400, { requestId });
  }

  const parsed = createLicenseSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "Validation error", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    const adminService = getControlPlaneAdminService();
    const actor = adminCtx.user.email || adminCtx.user.id;
    const license = await adminService.createLicense({
      ...parsed.data,
      actor,
    });
    return ok(license, { status: 201, requestId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error creating license";
    return fail("invalid_request", message, 400, { requestId });
  }
}
