import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { NextRequest } from "next/server";

import { fail, ok } from "@/lib/api/wrappers";
import { isValidCanonicalInstallationId } from "@/lib/licensing/installation-auth";
import { withControlPlaneLicenseService } from "@/control-plane/src/license-server-provider";
import { readJsonBodyLimited } from "@/control-plane/src/http-input";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const schema = z
  .object({
    installation_id: z.string().refine(isValidCanonicalInstallationId),
    license_id: z.string().min(1).max(100),
    instance_session_id: z
      .string()
      .regex(/^sess_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i),
    boot_started_at: z.string().datetime({ offset: true }),
    clientix_version: z.string().max(80).optional(),
    timestamp: z.number().int().positive(),
    nonce: z.string().min(16).max(128),
  })
  .strict();

const noStore = { "Cache-Control": "no-store, max-age=0" };

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  let body: unknown;
  try {
    body = await readJsonBodyLimited(request, 16_384);
  } catch {
    return fail("invalid_request", "Attestation could not be completed.", 400, {
      requestId,
      headers: noStore,
    });
  }
  const parsed = schema.safeParse(body);
  const signature = request.headers.get("x-installation-signature");
  if (!parsed.success || !signature || signature.length > 256) {
    return fail("invalid_request", "Attestation could not be completed.", 400, {
      requestId,
      headers: noStore,
    });
  }

  try {
    const result = await withControlPlaneLicenseService(async (service, runtimeConfig) => {
      const challenge = await service.createAttestationChallenge({
        installation_id: parsed.data.installation_id,
        license_id: parsed.data.license_id,
        instance_session_id: parsed.data.instance_session_id,
        boot_started_at: parsed.data.boot_started_at,
        app_version: parsed.data.clientix_version,
        timestamp: parsed.data.timestamp,
        nonce: parsed.data.nonce,
        signatureBase64url: signature,
        rawBody: JSON.stringify(body),
        clientIp: request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim(),
      });
      if (!challenge.ok || !challenge.data) return { status: challenge.status } as const;
      return {
        status: 200,
        response: runtimeConfig.signAttestationChallenge({
          version: 1,
          purpose: "installation_attestation_challenge",
          ...challenge.data,
        }),
      } as const;
    });
    if (result.status !== 200 || !("response" in result)) {
      return fail(
        "unauthorized",
        "Attestation could not be completed.",
        result.status === 429 ? 429 : 401,
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
