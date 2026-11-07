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
    installation_public_key: z.string().min(64).max(2048),
    recovery_code: z.string().regex(/^REC_[A-Za-z0-9_-]{40,48}$/),
    timestamp: z.number().int().positive(),
    nonce: z.string().min(16).max(128),
  })
  .strict();
const noStore = { "Cache-Control": "no-store, max-age=0" };

export async function POST(request: NextRequest) {
  const requestId = randomUUID();
  let body: unknown;
  try {
    body = await readJsonBodyLimited(request, 12_288);
  } catch {
    return fail("invalid_request", "Installation recovery could not be completed.", 400, {
      requestId,
      headers: noStore,
    });
  }
  const parsed = schema.safeParse(body);
  const signature = request.headers.get("x-installation-signature");
  if (!parsed.success || !signature || signature.length > 256) {
    return fail("invalid_request", "Installation recovery could not be completed.", 400, {
      requestId,
      headers: noStore,
    });
  }
  try {
    const result = await withControlPlaneLicenseService(async (service, runtimeConfig) => {
      const recovered = await service.recoverInstallationKey({
        installation_id: parsed.data.installation_id,
        installation_public_key: parsed.data.installation_public_key,
        recovery_code: parsed.data.recovery_code,
        timestamp: parsed.data.timestamp,
        nonce: parsed.data.nonce,
        signatureBase64url: signature,
        rawBody: JSON.stringify(body),
        clientIp: request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim(),
      });
      if (!recovered.ok || !recovered.data) return { status: recovered.status } as const;
      return {
        status: 200,
        response: runtimeConfig.signInstallationRecovery({
          version: 1,
          purpose: "installation_recovery",
          installation_id: recovered.data.installation_id,
          request_nonce: parsed.data.nonce,
          public_key_fingerprint: recovered.data.public_key_fingerprint,
          clone_status: "NORMAL",
          server_time: recovered.data.server_timestamp,
        }),
      } as const;
    });
    if (result.status !== 200 || !("response" in result)) {
      return fail(
        "unauthorized",
        "Installation recovery could not be completed.",
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
