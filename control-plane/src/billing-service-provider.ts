import { BillingService } from "./billing-service";
import { getControlPlaneDatabaseClient } from "./admin-service-provider";
import { withControlPlaneLicenseService } from "./license-server-provider";

let service: BillingService | null = null;

export function getControlPlaneBillingService(): BillingService {
  service ??= new BillingService(
    getControlPlaneDatabaseClient(),
    () => new Date(),
    async ({ licenseId, limit }) =>
      withControlPlaneLicenseService((licenseService) =>
        licenseService.processPendingLicenseArtifacts({ licenseId, limit }),
      ),
  );
  return service;
}
