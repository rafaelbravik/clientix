import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ok, fail } from "@/lib/api/wrappers";
import {
  requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";
import { hasSameOrigin, readJsonBodyLimited } from "@/control-plane/src/http-input";

const revokeSchema = z
  .object({ reason: z.string().trim().min(1).max(500), confirm: z.literal(true) })
  .strict();
const licenseIdSchema = z.string().uuid();

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
  let body: unknown;
  try {
    body = await readJsonBodyLimited(request, 4_096);
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
    const { id } = await params;
    const parsedId = licenseIdSchema.safeParse(id);
    if (!parsedId.success)
      return fail("invalid_request", "Invalid license identifier.", 400, { requestId });
    const license = await getControlPlaneAdminService().revokeLicense(
      parsedId.data,
      admin.user.id,
      parsed.data.reason,
      requestId,
    );
    return ok(license, { requestId });
  } catch {
    return fail("invalid_request", "License could not be revoked.", 400, { requestId });
  }
}
