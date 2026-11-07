import { randomUUID } from "node:crypto";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { requirePlatformAdminEscrita, falhaDaEscritaDePlatformAdmin } from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createLicenseAdminSummary } from "@/lib/licensing/admin-view";
import { activate, LicenseServerClientError } from "@/lib/licensing/license-server-client";

export const dynamic = "force-dynamic";

const schema = z.object({ activation_code: z.string().trim().min(16).max(128) }).strict();

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
    body = await request.json();
  } catch {
    return fail("invalid_request", "Informe o código de ativação.", 400, { requestId });
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return fail("validation_failed", "Código de ativação inválido.", 400, { requestId });

  try {
    const result = await activate({ activationCode: parsed.data.activation_code });
    return ok(createLicenseAdminSummary(result.status), {
      requestId,
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    if (error instanceof LicenseServerClientError) {
      const status = error.code === "NOT_CONFIGURED" ? 503 : error.code === "REJECTED" ? 403 : 502;
      return fail("license_activation_failed", error.message, status, { requestId });
    }
    return fail("license_activation_failed", "Não foi possível ativar a licença.", 502, { requestId });
  }
}
