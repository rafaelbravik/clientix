import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getControlPlaneBillingService } from "@/control-plane/src/billing-service-provider";
import { hasSameOrigin, readJsonBodyLimited } from "@/control-plane/src/http-input";

const schema = z
  .object({
    billing_grace_days: z.number().int().min(0).max(90),
    nonpayment_policy: z.enum(["SUSPEND_AFTER_GRACE", "ALLOW_NATURAL_EXPIRATION"]),
    invoice_lead_days: z.number().int().min(0).max(90),
  })
  .strict();

export async function GET() {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required.", 403, { requestId });
  }
  try {
    return ok(await getControlPlaneBillingService().getSettings(), {
      requestId,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return fail("database_error", "Billing settings are unavailable.", 500, { requestId });
  }
}

export async function PUT(request: Request) {
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
    body = await readJsonBodyLimited(request, 4_096);
  } catch {
    return fail("invalid_request", "Invalid billing settings.", 400, { requestId });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return fail("validation_failed", "Invalid billing settings.", 400, { requestId });
  try {
    return ok(
      await getControlPlaneBillingService().updateSettings({
        ...parsed.data,
        actor_id: admin.user.id,
        request_id: requestId,
      }),
      { requestId },
    );
  } catch {
    return fail("conflict", "Billing settings could not be updated.", 409, { requestId });
  }
}
