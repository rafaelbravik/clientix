import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getControlPlaneBillingService } from "@/control-plane/src/billing-service-provider";
import { hasSameOrigin } from "@/control-plane/src/http-input";

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
  try {
    return ok(await getControlPlaneBillingService().reconcileOnly(requestId, admin.user.id), {
      requestId,
    });
  } catch {
    return fail("database_error", "Billing reconciliation did not complete.", 500, { requestId });
  }
}
