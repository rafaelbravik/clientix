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

const createCustomerSchema = z.object({
  name: z.string().min(1, "Name is required"),
  legal_name: z.string().optional().nullable(),
  billing_email: z.string().email("Invalid billing email"),
  country: z
    .string()
    .length(2, "Country must be a 2-letter uppercase ISO code")
    .regex(/^[A-Za-z]{2}$/, "Country must be alphabetic")
    .optional()
    .nullable(),
});

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const searchParams = req.nextUrl.searchParams;
  const search = searchParams.get("search") || undefined;
  const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : 50;
  const offset = searchParams.get("offset") ? Number(searchParams.get("offset")) : 0;

  try {
    const adminService = getControlPlaneAdminService();
    const customers = await adminService.listCustomers({ search, limit, offset });
    return ok(customers, { requestId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error listing customers";
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

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("invalid_request", "Invalid JSON payload", 400, { requestId });
  }

  const parsed = createCustomerSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "Validation error", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    const adminService = getControlPlaneAdminService();
    const actor = adminCtx.user.email || adminCtx.user.id;
    const customer = await adminService.createCustomer(parsed.data, actor);
    return ok(customer, { status: 201, requestId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error creating customer";
    return fail("invalid_request", message, 400, { requestId });
  }
}
