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
    status: z.enum(["TRIAL", "ACTIVE", "PAST_DUE", "SUSPENDED", "CANCELLED", "EXPIRED"]).optional(),
    provider: z.enum(["MANUAL", "STRIPE", "MERCADO_PAGO"]).optional(),
    customer_id: z.string().uuid().optional(),
    search: z.string().trim().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    offset: z.coerce.number().int().min(0).max(100_000).default(0),
  })
  .strict();

const createSchema = z
  .object({
    customer_id: z.string().uuid(),
    license_id: z.string().uuid(),
    provider: z.literal("MANUAL").default("MANUAL"),
    billing_cycle: z
      .enum(["MONTHLY", "QUARTERLY", "SEMIANNUAL", "ANNUAL", "CUSTOM"])
      .default("ANNUAL"),
    amount_cents: z.number().int().min(0).max(100_000_000_000),
    currency: z
      .string()
      .regex(/^[A-Za-z]{3}$/)
      .default("BRL"),
    current_period_start: z.string().datetime({ offset: true }),
    current_period_end: z.string().datetime({ offset: true }),
    auto_renew: z.boolean().default(true),
  })
  .strict();

export async function GET(request: Request) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required.", 403, { requestId });
  }
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success)
    return fail("invalid_request", "Invalid subscription query.", 400, { requestId });
  try {
    const result = await getControlPlaneBillingService().listSubscriptions(parsed.data);
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
    return fail("database_error", "Subscriptions could not be loaded.", 500, { requestId });
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
    body = await readJsonBodyLimited(request, 8_192);
  } catch {
    return fail("invalid_request", "Invalid subscription input.", 400, { requestId });
  }
  const parsed = createSchema.safeParse(body);
  if (
    !parsed.success ||
    new Date(parsed.data.current_period_end).getTime() <=
      new Date(parsed.data.current_period_start).getTime()
  )
    return fail("validation_failed", "Invalid subscription input.", 400, { requestId });
  try {
    const subscription = await getControlPlaneBillingService().createSubscription({
      ...parsed.data,
      idempotency_key: idempotencyKey,
      actor_id: admin.user.id,
      request_id: requestId,
    });
    return ok(subscription, { status: 201, requestId });
  } catch {
    return fail(
      "invalid_request",
      "Subscription could not be created. Check that the license has no open billing subscription.",
      409,
      { requestId },
    );
  }
}
