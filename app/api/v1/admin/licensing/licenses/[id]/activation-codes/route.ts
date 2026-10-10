import { requireSupportWrite } from "@/lib/impersonate/support";
import type { NextRequest } from "next/server";
import { z } from "zod";
import { randomUUID } from "node:crypto";
import { ok, fail } from "@/lib/api/wrappers";
import {
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin,
} from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";

const createCodeSchema = z.object({
  max_uses: z.number().int().min(1).default(1),
  expires_at: z.string().datetime("Valid ISO-8601 expiration date required"),
});

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
    const codes = await adminService.listActivationCodes(id);
    return ok(codes, { requestId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error listing activation codes";
    return fail("database_error", message, 500, { requestId });
  }
}

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
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const { id } = await params;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("invalid_request", "Invalid JSON payload", 400, { requestId });
  }

  const parsed = createCodeSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "Validation error", 400, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    const adminService = getControlPlaneAdminService();
    const actor = adminCtx.user.email || adminCtx.user.id;
    const result = await adminService.createActivationCode({
      license_id: id,
      max_uses: parsed.data.max_uses,
      expires_at: parsed.data.expires_at,
      actor,
    });
    return ok(result, { status: 201, requestId });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : "Error creating activation code";
    return fail("invalid_request", message, 400, { requestId });
  }
}
