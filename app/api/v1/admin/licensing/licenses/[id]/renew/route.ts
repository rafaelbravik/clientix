import type { NextRequest } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import {
  requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin,
} from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";

const renewSchema = z.object({
  new_expires_at: z.string().datetime().optional(),
  new_maintenance_until: z.string().datetime().optional().nullable(),
});

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const requestId = randomUUID();
  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdminEscrita>>;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }

  const { id } = await params;

  let body: unknown = {};
  try {
    const text = await req.text();
    if (text) body = JSON.parse(text);
  } catch {
    return fail("invalid_request", "Invalid JSON payload", 400, { requestId });
  }

  const parsed = renewSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "Validation error", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    const adminService = getControlPlaneAdminService();
    const actor = adminCtx.user.email || adminCtx.user.id;
    const license = await adminService.renewLicense({
      license_id: id,
      new_expires_at: parsed.data.new_expires_at,
      new_maintenance_until: parsed.data.new_maintenance_until,
      actor,
    });
    return ok(license, { requestId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error renewing license";
    return fail("invalid_request", message, 400, { requestId });
  }
}
