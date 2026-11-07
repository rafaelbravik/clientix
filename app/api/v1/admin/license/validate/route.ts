import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createLicenseAdminSummary } from "@/lib/licensing/admin-view";
import { getInstallationLicenseStatus, resetLicenseCache } from "@/lib/licensing/enforcement";
import { onlineValidate, LicenseServerClientError } from "@/lib/licensing/license-server-client";

export const dynamic = "force-dynamic";

export async function POST(): Promise<Response> {
  const requestId = randomUUID();
  try {
    await requirePlatformAdminEscrita();
  } catch (error) {
    return falhaDaEscritaDePlatformAdmin(error, requestId);
  }
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  let status: Awaited<ReturnType<typeof getInstallationLicenseStatus>>;
  let onlineValidation: { status: "VALIDATED" | "NOT_CONFIGURED" | "UNAVAILABLE" };
  try {
    const result = await onlineValidate();
    status = result.status;
    onlineValidation = { status: "VALIDATED" };
  } catch (error) {
    if (error instanceof LicenseServerClientError && error.code === "REJECTED") {
      return fail("license_validation_rejected", error.message, 403, { requestId });
    }
    resetLicenseCache();
    status = await getInstallationLicenseStatus();
    onlineValidation = {
      status:
        error instanceof LicenseServerClientError && error.code === "NOT_CONFIGURED"
          ? "NOT_CONFIGURED"
          : "UNAVAILABLE",
    };
  }
  return ok(
    { license: createLicenseAdminSummary(status), online_validation: onlineValidation },
    {
      requestId,
      headers: { "Cache-Control": "no-store" },
    },
  );
}
