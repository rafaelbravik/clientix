import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { isValidCanonicalInstallationId } from "@/lib/licensing/installation-auth";
import { withControlPlaneLicenseService } from "@/control-plane/src/license-server-provider";
import { readJsonBodyLimited } from "@/control-plane/src/http-input";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const validationSchema = z
  .object({
    installation_id: z.string().refine(isValidCanonicalInstallationId),
    license_id: z.string().min(1).max(100).optional(),
    timestamp: z.number().int().positive(),
    nonce: z.string().min(16).max(128),
    clientix_version: z.string().max(80).optional(),
    local_license_status: z.string().max(32).optional(),
  })
  .strict();

const noStore = { "Cache-Control": "no-store, max-age=0" };

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  let body: unknown;
  try {
    body = await readJsonBodyLimited(request, 16_384);
  } catch {
    return fail("invalid_request", "Validation could not be completed.", 400, {
      requestId,
      headers: noStore,
    });
  }
  const rawBody = JSON.stringify(body);
  const parsed = validationSchema.safeParse(body);
  const signature = request.headers.get("x-installation-signature");
  if (!parsed.success || !signature || signature.length > 256) {
    return fail("invalid_request", "Validation could not be completed.", 400, {
      requestId,
      headers: noStore,
    });
  }

  try {
    const result = await withControlPlaneLicenseService(async (service, runtimeConfig) => {
      const validated = await service.heartbeat({
        installation_id: parsed.data.installation_id,
        clientIp: request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim() || undefined,
        license_id: parsed.data.license_id,
        app_version: parsed.data.clientix_version,
        local_license_state: parsed.data.local_license_status,
        timestamp: parsed.data.timestamp,
        nonce: parsed.data.nonce,
        signatureBase64url: signature,
        rawBody,
        requestPath: "/api/v1/licensing/validate",
      });
      if (!validated.ok || !validated.data) {
        return { status: validated.status, error: "validation_rejected" } as const;
      }
      const response = runtimeConfig.signResponse({
        version: 1,
        purpose: "license_server_response",
        response_type: "validation",
        installation_id: parsed.data.installation_id,
        request_nonce: parsed.data.nonce,
        license_id: validated.data.license_id,
        license_status: validated.data.license_status,
        installation_status: validated.data.installation_status,
        clone_status: validated.data.clone_status,
        temporal_state: validated.data.temporal_state,
        server_time: validated.data.server_timestamp,
        next_online_validation_at: new Date(
          Date.parse(validated.data.server_timestamp) + runtimeConfig.nextCheckHours * 3_600_000,
        ).toISOString(),
        offline_validation_tolerance_days: runtimeConfig.offlineValidationToleranceDays,
        signed_license: validated.data.signed_license,
      });
      return { status: 200, response } as const;
    });

    if (result.status !== 200 || !("response" in result)) {
      return fail(
        "unauthorized",
        "Validation could not be completed.",
        result.status === 429 ? 429 : 401,
        { requestId, headers: noStore },
      );
    }
    return ok(result.response, { requestId, headers: noStore });
  } catch {
    return fail("service_unavailable", "License service is temporarily unavailable.", 503, {
      requestId,
      headers: noStore,
    });
  }
}
