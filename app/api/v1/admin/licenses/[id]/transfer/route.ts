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

const transferSchema = z
  .object({
    from_installation_id: z
      .string()
      .regex(/^inst_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    to_installation_id: z
      .string()
      .regex(/^inst_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    to_public_key: z.string().min(64).max(2048),
    clientix_version: z.string().max(80).optional(),
    reason: z.string().trim().min(1).max(500),
    confirm: z.literal(true),
  })
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
    const raw = await request.text();
    if (raw.length > 8_192) throw new Error("oversized");
    body = JSON.parse(raw);
  } catch {
    return fail(
      "invalid_request",
      "A valid transfer request and explicit confirmation are required.",
      400,
      { requestId },
    );
  }
  const parsed = transferSchema.safeParse(body);
  if (!parsed.success)
    return fail(
      "invalid_request",
      "A valid transfer request and explicit confirmation are required.",
      400,
      { requestId },
    );
  try {
    const { id } = await params;
    const parsedLicenseId = licenseIdSchema.safeParse(id);
    if (!parsedLicenseId.success)
      return fail("invalid_request", "Invalid license identifier.", 400, { requestId });
    const result = await getControlPlaneAdminService().transferInstallation({
      ...parsed.data,
      license_id: parsedLicenseId.data,
      actor: admin.user.id,
      request_id: requestId,
    });
    return ok(result, { requestId });
  } catch {
    return fail("invalid_request", "Installation transfer could not be completed.", 409, {
      requestId,
    });
  }
}
