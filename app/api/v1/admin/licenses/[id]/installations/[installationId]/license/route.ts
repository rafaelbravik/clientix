import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { fail } from "@/lib/api/wrappers";
import {
  requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { withControlPlaneLicenseService } from "@/control-plane/src/license-server-provider";
import { hasSameOrigin } from "@/control-plane/src/http-input";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; installationId: string }> },
) {
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
  const { id, installationId } = await params;
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id) ||
    !/^inst_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
      installationId,
    )
  ) {
    return fail("invalid_request", "Invalid license installation.", 400, { requestId });
  }
  try {
    const signed = await withControlPlaneLicenseService((service) =>
      service.issueAdminLicenseDocument({
        licenseId: id,
        installationId,
        actorId: admin.user.id,
        requestId,
      }),
    );
    return new NextResponse(JSON.stringify(signed, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": 'attachment; filename="license.json"',
        "Cache-Control": "no-store",
        "X-Request-Id": requestId,
      },
    });
  } catch {
    return fail(
      "conflict",
      "Signed license artifact could not be issued for this installation.",
      409,
      { requestId },
    );
  }
}
