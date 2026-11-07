import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";

export async function GET() {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required.", 403, { requestId });
  }
  try {
    const summary = await getControlPlaneAdminService().getCommercialDashboardSummary();
    return ok(summary, { requestId, headers: { "Cache-Control": "no-store" } });
  } catch {
    return fail("database_error", "Commercial dashboard is unavailable.", 500, { requestId });
  }
}
