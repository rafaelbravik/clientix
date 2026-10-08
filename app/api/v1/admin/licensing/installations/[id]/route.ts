import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const { id } = await params;
  try {
    const adminService = getControlPlaneAdminService();
    const result = await adminService.getInstallationDetail(id);
    if (!result) {
      return fail("not_found", "Installation not found", 404, { requestId });
    }
    return ok(result, { requestId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error retrieving installation detail";
    return fail("database_error", message, 500, { requestId });
  }
}
