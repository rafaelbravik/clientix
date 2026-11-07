import { createHash, randomUUID } from "node:crypto";
import { fail, ok } from "@/lib/api/wrappers";
import { getControlPlaneBillingService } from "@/control-plane/src/billing-service-provider";
import type { BillingService } from "@/control-plane/src/billing-service";
import { NormalizedHmacWebhookAdapter } from "@/control-plane/src/billing-provider";
import { resolveBillingWebhookSecret } from "@/control-plane/src/billing-webhook-config";
import {
  getControlPlaneDatabaseClient,
  resolveControlPlaneConfig,
} from "@/control-plane/src/admin-service-provider";
import { readBodyBytesLimited } from "@/control-plane/src/http-input";
import { PostgresRateLimiter } from "@/control-plane/src/rate-limiter";

export const dynamic = "force-dynamic";

function resolveProvider(value: string): "STRIPE" | "MERCADO_PAGO" | null {
  if (value === "stripe") return "STRIPE";
  if (value === "mercado-pago") return "MERCADO_PAGO";
  return null;
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ provider: string }> },
) {
  const requestId = randomUUID();
  const { provider: providerSlug } = await params;
  const provider = resolveProvider(providerSlug);
  if (!provider) return fail("not_found", "Not found.", 404, { requestId });
  let service: BillingService;
  try {
    service = getControlPlaneBillingService();
    if (!(await service.isWebhookProviderReady(provider)))
      return fail("database_error", "Billing provider is not enabled.", 503, { requestId });
  } catch {
    return fail("database_error", "Billing provider is not enabled.", 503, { requestId });
  }
  const secret = resolveBillingWebhookSecret(provider, process.env);
  if (!secret)
    return fail("database_error", "Billing provider is not enabled.", 503, { requestId });
  let limiter: PostgresRateLimiter;
  try {
    const config = resolveControlPlaneConfig(process.env);
    limiter = new PostgresRateLimiter(getControlPlaneDatabaseClient(), config.pepper);
    const limit = await limiter.checkLimit(`billing-webhook:${provider}`, 120, 60);
    if (!limit.allowed) return fail("rate_limited", "Try again later.", 429, { requestId });
  } catch {
    return fail("database_error", "Billing provider is not enabled.", 503, { requestId });
  }
  let rawBody: Uint8Array;
  try {
    rawBody = await readBodyBytesLimited(request, 65_536);
  } catch (error) {
    return fail(
      "invalid_request",
      error instanceof Error && error.message === "REQUEST_BODY_TOO_LARGE"
        ? "Webhook body exceeds the configured limit."
        : "Invalid webhook body.",
      error instanceof Error && error.message === "REQUEST_BODY_TOO_LARGE" ? 413 : 400,
      { requestId },
    );
  }
  const adapter = new NormalizedHmacWebhookAdapter(provider, secret);
  if (!adapter.verify(rawBody, request.headers.get("x-clientix-signature")))
    return fail("unauthorized", "Invalid webhook signature.", 401, { requestId });
  let event;
  try {
    event = adapter.parseVerified(rawBody);
  } catch {
    return fail("invalid_request", "Webhook event was not accepted.", 400, { requestId });
  }
  const payloadSha256 = createHash("sha256").update(rawBody).digest("hex");
  try {
    const result = await service.confirmProviderPayment({
      event,
      provider,
      payload_sha256: payloadSha256,
      request_id: requestId,
    });
    return ok(
      { received: true, duplicate: result.duplicate },
      { requestId, headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    // Let enabled providers retry a transient transaction failure; details and payload stay private.
    return fail("database_error", "Webhook processing is temporarily unavailable.", 503, {
      requestId,
    });
  }
}
