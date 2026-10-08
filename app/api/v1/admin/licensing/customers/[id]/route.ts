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

const updateCustomerSchema = z.object({
  name: z.string().min(1).optional(),
  legal_name: z.string().optional().nullable(),
  billing_email: z.string().email().optional(),
  country: z
    .string()
    .length(2, "Country must be a 2-letter uppercase ISO code")
    .regex(/^[A-Za-z]{2}$/, "Country must be alphabetic")
    .optional()
    .nullable(),
});

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
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
    return ok(result, { requestId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error retrieving customer";
    return fail("database_error", message, 500, { requestId });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = randomUUID();
  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdminEscrita>>;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
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
    const actor = adminCtx.user.email || adminCtx.user.id;
    const customer = await adminService.updateCustomer(id, parsed.data, actor);
    return ok(customer, { requestId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error updating customer";
    return fail("invalid_request", message, 400, { requestId });
  }
}
