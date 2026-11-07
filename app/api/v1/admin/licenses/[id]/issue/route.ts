import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import {
  requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";
import { hasSameOrigin } from "@/control-plane/src/http-input";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  if (!hasSameOrigin(request))
    return fail("forbidden", "Same-origin request required.", 403, { requestId });
  let admin;
  try {
    admin = await requirePlatformAdminEscrita();
  } catch (error) {
    return falhaDaEscritaDePlatformAdmin(error, requestId);
  }
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  try {
    const { id } = await params;
    if (!z.string().uuid().safeParse(id).success)
      return fail("invalid_request", "Invalid license identifier.", 400, { requestId });
    const license = await getControlPlaneAdminService().issueLicense(id, admin.user.id, requestId);
    return ok(license, { requestId });
  } catch {
    return fail("invalid_request", "License could not be issued.", 400, { requestId });
  }
}
