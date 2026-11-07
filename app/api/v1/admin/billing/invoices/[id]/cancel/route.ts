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
  .object({ confirm: z.literal(true), reason: z.string().trim().min(1).max(500) })
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
  let body: unknown;
  try {
    body = await readJsonBodyLimited(request, 4_096);
  } catch {
    return fail("invalid_request", "Invalid invoice action.", 400, { requestId });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return fail(
      "validation_failed",
      "Invoice cancellation requires a reason and confirmation.",
      400,
      { requestId },
    );
  try {
    return ok(
      await getControlPlaneBillingService().cancelInvoice(
        id,
        parsed.data.reason,
        admin.user.id,
        requestId,
      ),
      { requestId },
    );
  } catch {
    return fail("conflict", "Invoice could not be cancelled.", 409, { requestId });
  }
}
