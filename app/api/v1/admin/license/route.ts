import { randomUUID } from "node:crypto";

import { fail, ok } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { createLicenseAdminSummary } from "@/lib/licensing/admin-view";
import { getInstallationLicenseStatus } from "@/lib/licensing/enforcement";

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Requer administrador da plataforma.", 403, { requestId });
  }

  const status = await getInstallationLicenseStatus();
  return ok(createLicenseAdminSummary(status), {
    requestId,
    headers: { "Cache-Control": "no-store" },
  });
}
