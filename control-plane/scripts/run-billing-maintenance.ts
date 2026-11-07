import { randomUUID } from "node:crypto";

import { getControlPlaneBillingService } from "../src/billing-service-provider";
import { withControlPlaneBillingSchedulerLock } from "../src/admin-service-provider";

/** One-shot Vendor job; schedule it only in the private Control Plane deployment. */
async function main(): Promise<void> {
  const lock = await withControlPlaneBillingSchedulerLock(() =>
    getControlPlaneBillingService().runMaintenance(randomUUID()),
  );
  if (!lock.acquired) {
    process.stdout.write(`${JSON.stringify({ ok: true, status: "skipped_locked" })}\n`);
    return;
  }
  const result = lock.value;
  process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
}

main().catch(() => {
  process.stderr.write("Vendor billing maintenance failed. Check private Control Plane logs.\n");
  process.exitCode = 1;
});
