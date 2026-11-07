import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createLicenseAdminSummary } from "@/lib/licensing/admin-view";
import { resetLicenseCache, getInstallationLicenseStatus } from "@/lib/licensing/enforcement";
import {
  recoverInstallationIdentity,
  LicenseServerClientError,
} from "@/lib/licensing/license-server-client";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z.object({ recovery_code: z.string().regex(/^REC_[A-Za-z0-9_-]{40,48}$/) }).strict();

export async function POST(request: Request): Promise<Response> {
  const requestId = randomUUID();
  try {
    await requirePlatformAdminEscrita();
  } catch (error) {
    return falhaDaEscritaDePlatformAdmin(error, requestId);
  }
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  let body: unknown;
  try {
    const raw = await request.text();
    if (raw.length > 4096) throw new Error("oversized");
    body = JSON.parse(raw);
  } catch {
    return fail("invalid_request", "Código de recuperação inválido.", 400, { requestId });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    return fail("invalid_request", "Código de recuperação inválido.", 400, { requestId });
  try {
    await recoverInstallationIdentity({ recoveryCode: parsed.data.recovery_code });
    resetLicenseCache();
    return ok(
      { license: createLicenseAdminSummary(await getInstallationLicenseStatus()) },
      {
        requestId,
        headers: { "Cache-Control": "no-store, max-age=0" },
      },
    );
  } catch (error) {
    const message =
      error instanceof LicenseServerClientError && error.code === "NOT_CONFIGURED"
        ? "O serviço de licenças não está configurado nesta instalação."
        : "O fornecedor não autorizou a recuperação da instalação.";
    return fail("license_recovery_rejected", message, 403, { requestId });
  }
}
