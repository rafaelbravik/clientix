import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { fail, ok } from "@/lib/api/wrappers";
import {
  requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin,
} from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";
import { hasSameOrigin, readJsonBodyLimited } from "@/control-plane/src/http-input";

const schema = z
  .object({ reason: z.string().trim().min(3).max(500), confirm: z.literal(true) })
  .strict();

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  const requestId = randomUUID();
  if (!hasSameOrigin(request))
    return fail("forbidden", "Same-origin request required.", 403, { requestId });
  let admin: Awaited<ReturnType<typeof requirePlatformAdminEscrita>>;
  try {
    admin = await requirePlatformAdminEscrita();
  } catch (error) {
    return falhaDaEscritaDePlatformAdmin(error, requestId);
  }
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const { id } = await params;
  if (!/^inst_[0-9a-f-]{36}$/i.test(id))
    return fail("invalid_request", "Instalação inválida.", 400, { requestId });
  let body: unknown;
  try {
    body = await readJsonBodyLimited(request, 4_096);
  } catch {
    return fail(
      "invalid_request",
      "Informe motivo e confirmação para autorizar a recuperação.",
      400,
      { requestId },
    );
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return fail(
      "invalid_request",
      "Informe motivo e confirmação para autorizar a recuperação.",
      400,
      { requestId },
    );
  try {
    const result = await getControlPlaneAdminService().authorizeInstallationRecovery({
      installation_id: id,
      reason: parsed.data.reason,
      actor: admin.user.id,
      request_id: requestId,
    });
    return ok(result, { requestId, headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch {
    return fail(
      "invalid_request",
      "Não foi possível autorizar a recuperação desta instalação.",
      409,
      { requestId },
    );
  }
}
