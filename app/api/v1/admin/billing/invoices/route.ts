import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import {
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getControlPlaneBillingService } from "@/control-plane/src/billing-service-provider";
import { hasSameOrigin, readJsonBodyLimited } from "@/control-plane/src/http-input";

const querySchema = z
  .object({
    status: z.enum(["OPEN", "PAID", "OVERDUE", "CANCELLED", "REFUNDED"]).optional(),
    provider: z.enum(["MANUAL", "STRIPE", "MERCADO_PAGO"]).optional(),
    customer_id: z.string().uuid().optional(),
    search: z.string().trim().max(100).optional(),
    due_before: z.string().datetime({ offset: true }).optional(),
    due_after: z.string().datetime({ offset: true }).optional(),
    sort: z.enum(["due_at", "created_at", "amount_cents", "status"]).default("due_at"),
    direction: z.enum(["asc", "desc"]).default("asc"),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();
const createSchema = z
  .object({ subscription_id: z.string().uuid(), due_at: z.string().datetime({ offset: true }) })
  .strict();

export async function GET(request: Request) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required.", 403, { requestId });
  }
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) return fail("invalid_request", "Invalid invoice query.", 400, { requestId });
  try {
    const result = await getControlPlaneBillingService().listInvoices(parsed.data);
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
    return fail("database_error", "Invoices could not be loaded.", 500, { requestId });
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
  if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 200)
    return fail("invalid_request", "A valid Idempotency-Key header is required.", 400, {
      requestId,
    });
  let body: unknown;
  try {
    body = await readJsonBodyLimited(request, 4_096);
  } catch {
    return fail("invalid_request", "Invalid invoice input.", 400, { requestId });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success)
    return fail("validation_failed", "Invalid invoice input.", 400, { requestId });
  try {
    const invoice = await getControlPlaneBillingService().createInvoice({
      ...parsed.data,
      idempotency_key: idempotencyKey,
      actor_id: admin.user.id,
      request_id: requestId,
    });
    return ok(invoice, { status: 201, requestId });
  } catch {
    return fail("conflict", "Invoice could not be created.", 409, { requestId });
  }
}
