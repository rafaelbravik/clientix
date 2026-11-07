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

const revokeSchema = z
  .object({ reason: z.string().trim().min(1).max(500), confirm: z.literal(true) })
  .strict();

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
  let body: unknown;
  try {
    const raw = await req.text();
    if (raw.length > 4_096) throw new Error("oversized");
    body = JSON.parse(raw);
  } catch {
    return fail("invalid_request", "A revocation reason and confirmation are required.", 400, {
      requestId,
    });
  }
  const parsed = revokeSchema.safeParse(body);
  if (!parsed.success)
    return fail("invalid_request", "A revocation reason and confirmation are required.", 400, {
      requestId,
    });
  try {
    const adminService = getControlPlaneAdminService();
    const license = await adminService.revokeLicense(
      id,
      adminCtx.user.id,
      parsed.data.reason,
      requestId,
    );
    return ok(license, { requestId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error revoking license";
    return fail("invalid_request", message, 400, { requestId });
  }
}
