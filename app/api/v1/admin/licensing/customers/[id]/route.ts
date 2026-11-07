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
import { hasSameOrigin, readJsonBodyLimited } from "@/control-plane/src/http-input";

const updateCustomerSchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  legal_name: z.string().trim().max(240).optional().nullable(),
  billing_email: z.string().trim().email().max(254).optional(),
  document: z.string().trim().max(64).optional().nullable(),
  phone: z.string().trim().max(40).optional().nullable(),
  internal_notes: z.string().trim().max(2000).optional().nullable(),
  country: z
    .string()
    .length(2, "Country must be a 2-letter uppercase ISO code")
    .regex(/^[A-Za-z]{2}$/, "Country must be alphabetic")
    .optional()
    .nullable(),
});

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const { id } = await params;
  try {
    const adminService = getControlPlaneAdminService();
    const result = await adminService.getCustomer(id);
    if (!result) {
      return fail("not_found", "Customer not found", 404, { requestId });
    }
    return ok(result, { requestId, headers: { "Cache-Control": "no-store" } });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error retrieving customer";
    return fail("database_error", message, 500, { requestId });
  }
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  if (!hasSameOrigin(req))
    return fail("forbidden", "Same-origin request required.", 403, { requestId });
  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdminEscrita>>;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "Invalid customer identifier.", 400, { requestId });

  let body: unknown;
  try {
    body = await readJsonBodyLimited(req, 8_192);
  } catch {
    return fail("invalid_request", "Invalid JSON payload", 400, { requestId });
  }

  const parsed = updateCustomerSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "Validation error", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    const adminService = getControlPlaneAdminService();
    const customer = await adminService.updateCustomer(
      id,
      parsed.data,
      adminCtx.user.id,
      requestId,
    );
    return ok(customer, { requestId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error updating customer";
    return fail("invalid_request", message, 400, { requestId });
  }
}
