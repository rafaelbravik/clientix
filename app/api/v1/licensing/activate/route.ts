import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { isValidCanonicalInstallationId } from "@/lib/licensing/installation-auth";
import { withControlPlaneLicenseService } from "@/control-plane/src/license-server-provider";
import { readJsonBodyLimited } from "@/control-plane/src/http-input";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const activationSchema = z
  .object({
    installation_id: z.string().refine(isValidCanonicalInstallationId),
    installation_public_key: z.string().min(64).max(2048),
    activation_code: z.string().min(32).max(128),
    timestamp: z.number().int().positive(),
    nonce: z.string().min(16).max(128),
    clientix_version: z.string().max(80).optional(),
  })
  .strict();

const noStore = { "Cache-Control": "no-store, max-age=0" };

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  let body: unknown;
  try {
    body = await readJsonBodyLimited(request, 16_384);
  } catch {
    return fail("invalid_request", "Activation could not be completed.", 400, {
      requestId,
      headers: noStore,
    });
  }

  const parsed = activationSchema.safeParse(body);
  if (!parsed.success)
    return fail("invalid_request", "Activation could not be completed.", 400, {
      requestId,
      headers: noStore,
    });

  try {
    const result = await withControlPlaneLicenseService(async (service, runtimeConfig) => {
      const forwardedFor = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
      const activated = await service.activate({
        installation_id: parsed.data.installation_id,
        installation_public_key: parsed.data.installation_public_key,
        activation_code: parsed.data.activation_code,
        timestamp: parsed.data.timestamp,
        nonce: parsed.data.nonce,
        clientIp: forwardedFor || "unknown",
        app_version: parsed.data.clientix_version,
      });
      if (!activated.ok || !activated.data) {
        return {
          status: activated.status,
          error: activated.error?.code === "RATE_LIMITED" ? "rate_limited" : "activation_rejected",
        } as const;
      }

      const now = new Date(activated.data.server_timestamp);
      const expiresAt = new Date(activated.data.signed_license.payload.expires_at);
      const validFrom = new Date(activated.data.signed_license.payload.valid_from);
      const graceUntil =
        expiresAt.getTime() + activated.data.signed_license.payload.grace_period_days! * 86_400_000;
      const temporalState =
        now < validFrom
          ? "NOT_YET_VALID"
          : now < expiresAt
            ? "VALID"
            : now.getTime() < graceUntil
              ? "GRACE"
              : "EXPIRED";
      const response = runtimeConfig.signResponse({
        version: 1,
        purpose: "license_server_response",
        response_type: "activation",
        installation_id: parsed.data.installation_id,
        request_nonce: parsed.data.nonce,
        license_id: activated.data.signed_license.payload.license_id,
        license_status: activated.data.license_status,
        installation_status: activated.data.installation_status,
        temporal_state: temporalState,
        server_time: activated.data.server_timestamp,
        next_online_validation_at: new Date(
          now.getTime() + runtimeConfig.nextCheckHours * 3_600_000,
        ).toISOString(),
        offline_validation_tolerance_days: runtimeConfig.offlineValidationToleranceDays,
        signed_license: activated.data.signed_license,
      });
      return { status: 200, response } as const;
    });

    if (result.status !== 200 || !("response" in result)) {
      return fail(
        result.error === "rate_limited" ? "rate_limited" : "invalid_request",
        "Activation could not be completed.",
        result.status,
        {
          requestId,
          headers: noStore,
        },
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
