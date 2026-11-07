import { requireSupportWrite } from "@/lib/impersonate/support";
import type { NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import {
  requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin,
} from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";
import { hasSameOrigin } from "@/control-plane/src/http-input";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  if (!hasSameOrigin(req))
    return fail("forbidden", "Same-origin request required.", 403, { requestId });
  let adminCtx: Awaited<ReturnType<typeof requirePlatformAdminEscrita>>;
  try {
    adminCtx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { id } = await params;
  if (!z.string().uuid().safeParse(id).success)
    return fail("invalid_request", "Invalid license identifier.", 400, { requestId });
  try {
    const adminService = getControlPlaneAdminService();
    const actor = adminCtx.user.email || adminCtx.user.id;
    const license = await adminService.reactivateLicense(id, actor, requestId);
    return ok(license, { requestId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error reactivating license";
    return fail("invalid_request", message, 400, { requestId });
  }
}
