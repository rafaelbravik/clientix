import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneBillingService } from "@/control-plane/src/billing-service-provider";

export const dynamic = "force-dynamic";

export async function GET() {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required.", 403, { requestId });
  }
  try {
    const [summary, settings, notifications] = await Promise.all([
      getControlPlaneBillingService().getDashboard(),
      getControlPlaneBillingService().getSettings(),
      getControlPlaneBillingService().listEvents({ limit: 8 }),
    ]);
    return ok(
      { ...summary, settings, recent_events: notifications.items },
      {
        requestId,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return fail("database_error", "Billing dashboard is unavailable.", 500, { requestId });
  }
}
