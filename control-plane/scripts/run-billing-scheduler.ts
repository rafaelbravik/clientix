import { randomUUID } from "node:crypto";

import { withControlPlaneBillingSchedulerLock } from "../src/admin-service-provider";
import { BillingScheduler, resolveBillingSchedulerInterval } from "../src/billing-scheduler";
import { getControlPlaneBillingService } from "../src/billing-service-provider";

const scheduler = new BillingScheduler({
  intervalMs: resolveBillingSchedulerInterval(process.env),
  withLock: withControlPlaneBillingSchedulerLock,
  runCycle: () => getControlPlaneBillingService().runMaintenance(randomUUID()),
  onResult: (result) => {
    const summary =
      result.status === "COMPLETED"
        ? {
            status: result.status,
            signed_artifacts_created: result.value.license_artifacts?.issued ?? 0,
            signed_artifacts_pending: result.value.license_artifacts?.pending ?? 0,
          }
        : { status: result.status };
    process.stdout.write(
      `${JSON.stringify({ event: "vendor_billing_scheduler_cycle", ...summary })}\n`,
    );
  },
  onError: () => {
    process.stderr.write(
      "Vendor billing scheduler cycle failed; the next scheduled cycle will retry.\n",
    );
  },
});

process.once("SIGINT", () => scheduler.stop());
process.once("SIGTERM", () => scheduler.stop());
scheduler.start();
