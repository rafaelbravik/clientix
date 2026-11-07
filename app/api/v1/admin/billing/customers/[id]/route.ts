import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneBillingService } from "@/control-plane/src/billing-service-provider";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required.", 403, { requestId });
  }
  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "Invalid customer.", 400, { requestId });
  try {
    return ok(await getControlPlaneBillingService().getCustomerSummary(id), {
      requestId,
      headers: { "Cache-Control": "no-store" },
    });
  } catch {
    return fail("database_error", "Customer billing summary is unavailable.", 500, { requestId });
  }
}
