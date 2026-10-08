import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import { requirePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";

export async function GET(req: NextRequest) {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }

  const searchParams = req.nextUrl.searchParams;
  const license_id = searchParams.get("license_id") || undefined;
  const status = searchParams.get("status") || undefined;
  const search = searchParams.get("search") || undefined;
  const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : 50;
  const offset = searchParams.get("offset") ? Number(searchParams.get("offset")) : 0;

  try {
    const adminService = getControlPlaneAdminService();
    const installations = await adminService.listInstallations({
      license_id,
      status,
      search,
      limit,
      offset,
    });
    return ok(installations, { requestId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error listing installations";
    return fail("database_error", message, 500, { requestId });
  }
}
