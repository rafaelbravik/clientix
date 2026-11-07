import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneBillingService } from "@/control-plane/src/billing-service-provider";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required.", 403, { requestId });
  }
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "Invalid invoice identifier.", 400, { requestId });
  try {
    const detail = await getControlPlaneBillingService().getInvoice(id);
    if (!detail) return fail("not_found", "Invoice not found.", 404, { requestId });
    return ok(detail, { requestId, headers: { "Cache-Control": "no-store" } });
  } catch {
    return fail("database_error", "Invoice details are unavailable.", 500, { requestId });
  }
}
