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
  const installation_id = searchParams.get("installation_id") || undefined;
  const event_type = searchParams.get("event_type") || undefined;
  const from_date = searchParams.get("from_date") || undefined;
  const to_date = searchParams.get("to_date") || undefined;
  const limit = searchParams.get("limit") ? Number(searchParams.get("limit")) : 50;
  const offset = searchParams.get("offset") ? Number(searchParams.get("offset")) : 0;

  try {
    const adminService = getControlPlaneAdminService();
    const events = await adminService.listAuditEvents({
      license_id,
      installation_id,
      event_type,
      from_date,
      to_date,
      limit,
      offset,
    });
    return ok(events, { requestId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error listing audit events";
    return fail("database_error", message, 500, { requestId });
  }
}
