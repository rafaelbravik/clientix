import { requireSupportWrite } from "@/lib/impersonate/support";
import { randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import {
  requirePlatformAdminEscrita,
  falhaDaEscritaDePlatformAdmin,
} from "@/lib/auth/requirePlatformAdmin";
import { getControlPlaneAdminService } from "@/control-plane/src/admin-service-provider";
import { hasSameOrigin } from "@/control-plane/src/http-input";

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; sessionId: string }> },
) {
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
  const { id, sessionId } = await params;
  if (!/^inst_[0-9a-f-]{36}$/i.test(id) || !/^sess_[0-9a-f-]{36}$/i.test(sessionId)) {
    return fail("invalid_request", "Sessão inválida.", 400, { requestId });
  }
  try {
    const ended = await getControlPlaneAdminService().endInstallationSession(
      id,
      sessionId,
      admin.user.id,
      requestId,
    );
    if (!ended) return fail("not_found", "Sessão ativa não encontrada.", 404, { requestId });
    return ok({ ended: true }, { requestId, headers: { "Cache-Control": "no-store, max-age=0" } });
  } catch {
    return fail("database_error", "Não foi possível encerrar a sessão.", 500, { requestId });
  }
}
