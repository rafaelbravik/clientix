import { requireSupportWrite } from "@/lib/impersonate/support";
import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import {
  requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin,
} from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = randomUUID();
  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdminEscrita>>;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { id } = await params;
  try {
    const adminService = getControlPlaneAdminService();
    const actor = adminCtx.user.email || adminCtx.user.id;
    const license = await adminService.revokeLicense(id, actor);
    return ok(license, { requestId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error revoking license";
    return fail("invalid_request", message, 400, { requestId });
  }
}
