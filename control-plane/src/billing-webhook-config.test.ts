import { describe, expect, it } from "vitest";
import { resolveBillingWebhookSecret } from "./billing-webhook-config";

describe("private Vendor billing webhook configuration", () => {
  it("resolves only a well-formed provider secret from the Vendor environment", () => {
    const secret = "synthetic-test-webhook-secret-with-32-chars";
    expect(
      resolveBillingWebhookSecret("STRIPE", {
        CONTROL_PLANE_BILLING_WEBHOOK_SECRETS_JSON: JSON.stringify({ STRIPE: secret }),
      }),
    ).toBe(secret);
  });

  it("fails closed on missing, short, unknown, malformed, or oversized configuration", () => {
    expect(resolveBillingWebhookSecret("STRIPE", {})).toBeNull();
    expect(
      resolveBillingWebhookSecret("STRIPE", {
        CONTROL_PLANE_BILLING_WEBHOOK_SECRETS_JSON: JSON.stringify({ STRIPE: "short" }),
      }),
    ).toBeNull();
    expect(
      resolveBillingWebhookSecret("STRIPE", {
        CONTROL_PLANE_BILLING_WEBHOOK_SECRETS_JSON: JSON.stringify({
          STRIPE: "a".repeat(32),
          UNKNOWN: "x",
        }),
      }),
    ).toBeNull();
    expect(
      resolveBillingWebhookSecret("STRIPE", {
        CONTROL_PLANE_BILLING_WEBHOOK_SECRETS_JSON: "{",
      }),
    ).toBeNull();
    expect(
      resolveBillingWebhookSecret("STRIPE", {
        CONTROL_PLANE_BILLING_WEBHOOK_SECRETS_JSON: "x".repeat(4_097),
      }),
    ).toBeNull();
  });

  it("does not fall back to another provider's credential", () => {
    expect(
      resolveBillingWebhookSecret("MERCADO_PAGO", {
        CONTROL_PLANE_BILLING_WEBHOOK_SECRETS_JSON: JSON.stringify({
          STRIPE: "synthetic-test-webhook-secret-with-32-chars",
        }),
      }),
    ).toBeNull();
  });
});
