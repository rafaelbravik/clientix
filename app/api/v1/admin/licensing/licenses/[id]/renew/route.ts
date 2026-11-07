import { requireSupportWrite } from "@/lib/impersonate/support";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import {
  requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin,
} from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneBillingService } from "@/control-plane/src/billing-service-provider";
import { hasSameOrigin, readJsonBodyLimited } from "@/control-plane/src/http-input";

const renewSchema = z
  .object({
    duration_months: z.number().int().min(1).max(120).optional(),
    duration_days: z.union([z.literal(30), z.literal(90)]).optional(),
    renewal_basis: z.enum(["previous_expiration", "today"]).optional(),
    new_expires_at: z.string().datetime({ offset: true }).optional(),
    new_maintenance_until: z.string().datetime().optional().nullable(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict()
  .refine(
    (value) =>
      [value.duration_months, value.duration_days, value.new_expires_at].filter(
        (item) => item !== undefined,
      ).length <= 1,
  );

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
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
  const parsedId = z.string().uuid().safeParse(id);
  if (!parsedId.success)
    return fail("invalid_request", "Invalid license identifier.", 400, { requestId });
  const idempotencyKey = req.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 200) {
    return fail("invalid_request", "A valid Idempotency-Key header is required.", 400, {
      requestId,
    });
  }

  let body: unknown = {};
  try {
    if (req.body) body = await readJsonBodyLimited(req, 4_096);
  } catch {
    return fail("invalid_request", "Invalid JSON payload", 400, { requestId });
  }

  const parsed = renewSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "Validation error", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    const license = await getControlPlaneBillingService().renewWithoutBilling({
      license_id: parsedId.data,
      duration_months:
        parsed.data.duration_months ??
        (parsed.data.duration_days || parsed.data.new_expires_at ? undefined : 12),
      duration_days: parsed.data.duration_days,
      renewal_basis: parsed.data.renewal_basis,
      new_expires_at: parsed.data.new_expires_at,
      new_maintenance_until: parsed.data.new_maintenance_until,
      idempotency_key: idempotencyKey,
      reason: parsed.data.reason,
      actor_id: adminCtx.user.id,
      request_id: requestId,
    });
    return ok(license, { requestId });
  } catch {
    return fail(
      "conflict",
      "License could not be renewed without billing. Check subscription status and renewal eligibility.",
      409,
      { requestId },
    );
  }
}
