/**
 * GET /api/v1/system/license — Inspeciona o estado da licença comercial da instalação.
 * PUT /api/v1/system/license — Atualiza/substitui atomicamente a licença comercial da instalação.
 *
 * Auth: somente Platform Admin.
 * Permite que o administrador da plataforma visualize o estado da licença ou faça upload
 * de uma nova licença MESMO quando a instalação está com a licença expirada
 * ou inválida (Recovery Loop).
 */
import { randomUUID } from "node:crypto";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  getInstallationLicenseStatus,
  installLicenseFile,
  resolveSystemInstallationId,
} from "@/lib/licensing";

export const dynamic = "force-dynamic";

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Requer administrador da plataforma.", 403, { requestId });
  }

  try {
    const status = await getInstallationLicenseStatus();
    const installationId = await resolveSystemInstallationId();

    return ok(
      {
        installation_id: installationId,
        license: {
          state: status.state,
          usable: status.usable,
          valid: status.valid,
          cryptographic_valid: status.cryptographic_valid,
          reason: status.reason,
          error_code: status.error_code,
          license_id: status.license_id,
          customer_name: status.customer_name,
          license_type: status.license_type,
          expires_at: status.expires_at,
          grace_until: status.grace_until,
          entitlements: status.entitlements
            ? {
                max_installations: status.entitlements.max_installations,
                max_tenants: status.entitlements.max_tenants,
                resale_allowed: status.entitlements.resale_allowed,
                white_label: status.entitlements.white_label,
                features: status.entitlements.features,
              }
            : undefined,
          capabilities: {
            can_resell_access: Boolean(status.usable && status.entitlements?.resale_allowed),
            can_white_label: Boolean(status.usable && status.entitlements?.white_label),
            can_manage_multiple_tenants: Boolean(
              status.usable &&
              (status.entitlements?.max_tenants === null ||
                (status.entitlements?.max_tenants ?? 0) > 1),
            ),
            max_tenants: status.usable ? (status.entitlements?.max_tenants ?? null) : 1,
          },
          installation_id_matched: status.installation_id_matched,
        },
      },
      { requestId },
    );
  } catch {
    return fail("internal_error", "Falha ao inspecionar o estado da licença.", 500, {
      requestId,
    });
  }
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  let admin: Awaited<ReturnType<typeof requirePlatformAdminEscrita>>;
  try {
    admin = await requirePlatformAdminEscrita();
  } catch (error) {
    return falhaDaEscritaDePlatformAdmin(error, requestId, "Requer administrador da plataforma.");
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_failed", "JSON inválido fornecido no corpo da requisição", 400, {
      requestId,
    });
  }

  try {
    const result = await installLicenseFile(body);
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
      {
        message: "Licença comercial atualizada com sucesso.",
        status: result.statusInfo,
      },
      { status: 200, requestId },
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
