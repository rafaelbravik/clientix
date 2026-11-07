import { randomUUID } from "node:crypto";
import { Buffer } from "node:buffer";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createLicenseAdminSummary } from "@/lib/licensing/admin-view";
import { MAX_LICENSE_DOCUMENT_BYTES } from "@/lib/licensing/schema";
import { installLicenseFile } from "@/lib/licensing/enforcement";

export const dynamic = "force-dynamic";

const updateSchema = z
  .object({
    document: z.union([
      z.string().max(MAX_LICENSE_DOCUMENT_BYTES),
      z.record(z.string(), z.unknown()),
    ]),
  })
  .strict();

export async function POST(request: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  let admin: Awaited<ReturnType<typeof requirePlatformAdminEscrita>>;
  try {
    admin = await requirePlatformAdminEscrita();
  } catch (error) {
    return falhaDaEscritaDePlatformAdmin(error, requestId, "Requer administrador da plataforma.");
  }

  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return fail("validation_failed", "JSON inválido fornecido no corpo da requisição.", 400, {
      requestId,
    });
  }

  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "Envie um documento de licença válido.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  let encoded: string;
  try {
    encoded =
      typeof parsed.data.document === "string"
        ? parsed.data.document
        : JSON.stringify(parsed.data.document);
  } catch {
    return fail("validation_failed", "Documento de licença inválido.", 422, { requestId });
  }
  if (Buffer.byteLength(encoded, "utf-8") > MAX_LICENSE_DOCUMENT_BYTES) {
    return fail("validation_failed", "O documento de licença excede o limite de tamanho.", 413, {
      requestId,
    });
  }

  try {
    const result = await installLicenseFile(parsed.data.document);
    await audit({
      action: "platform_license.updated",
      actorUserId: admin.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      requestId,
      resourceType: "installation_license",
      resourceId: result.statusInfo.license_id ?? null,
      metadata: {
        status: result.statusInfo.commercial_status,
        plan: result.statusInfo.plan ?? null,
      },
    });

    return ok(
      { license: createLicenseAdminSummary(result.statusInfo) },
      {
        requestId,
        headers: { "Cache-Control": "no-store" },
      },
    );
  } catch {
    return fail(
      "validation_failed",
      "A licença foi recusada. O arquivo válido atual, se houver, foi preservado.",
      422,
      { requestId },
    );
  }
}
