import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getControlPlaneBillingService } from "@/control-plane/src/billing-service-provider";
import { hasSameOrigin, readJsonBodyLimited } from "@/control-plane/src/http-input";

const schema = z
  .object({ confirm: z.literal(true), reason: z.string().trim().max(500).optional() })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
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
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "Invalid invoice.", 400, { requestId });
  const idempotencyKey = request.headers.get("idempotency-key")?.trim();
  if (!idempotencyKey || idempotencyKey.length < 16 || idempotencyKey.length > 200)
    return fail("invalid_request", "A valid Idempotency-Key header is required.", 400, {
      requestId,
    });
  let body: unknown;
  try {
    body = await readJsonBodyLimited(request, 4_096);
  } catch {
    return fail("invalid_request", "Invalid payment confirmation.", 400, { requestId });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return fail("validation_failed", "Payment confirmation must be explicit.", 400, { requestId });
  try {
    const result = await getControlPlaneBillingService().confirmManualPayment({
      invoice_id: id,
      idempotency_key: idempotencyKey,
      actor_id: admin.user.id,
      request_id: requestId,
      reason: parsed.data.reason,
    });
    return ok(result, { requestId });
  } catch {
    return fail("conflict", "Manual payment could not be confirmed.", 409, { requestId });
  }
}
