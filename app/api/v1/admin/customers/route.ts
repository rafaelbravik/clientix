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
  search: z.string().trim().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});
const createSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    legal_name: z.string().trim().max(250).optional().nullable(),
    document: z.string().max(64).optional().nullable(),
    billing_email: z.string().email().max(254),
    country: z
      .string()
      .regex(/^[A-Za-z]{2}$/)
      .optional()
      .nullable(),
  })
  .strict();

export async function GET(request: Request) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "License Server administrator required.", 403, { requestId });
  }
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success)
    return fail("invalid_request", "Invalid customer query.", 400, { requestId });
  try {
    const customers = await getControlPlaneAdminService().listCustomers(parsed.data);
    return ok(customers, { requestId, headers: { "Cache-Control": "no-store" } });
  } catch {
    return fail("database_error", "Customers could not be loaded.", 500, { requestId });
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
  let body: unknown;
  try {
    body = await readJsonBodyLimited(request, 8_192);
  } catch {
    return fail("invalid_request", "Invalid customer input.", 400, { requestId });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success)
    return fail("validation_failed", "Invalid customer input.", 400, { requestId });
  try {
    const customer = await getControlPlaneAdminService().createCustomer(parsed.data, admin.user.id);
    return ok(customer, { status: 201, requestId });
  } catch {
    return fail("invalid_request", "Customer could not be created.", 400, { requestId });
  }
}
