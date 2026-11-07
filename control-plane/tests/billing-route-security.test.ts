import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const writes = [
  "app/api/v1/admin/billing/subscriptions/route.ts",
  "app/api/v1/admin/billing/subscriptions/[id]/auto-renew/route.ts",
  "app/api/v1/admin/billing/invoices/route.ts",
  "app/api/v1/admin/billing/invoices/[id]/confirm-payment/route.ts",
  "app/api/v1/admin/billing/invoices/[id]/cancel/route.ts",
  "app/api/v1/admin/billing/payments/[id]/refund/route.ts",
  "app/api/v1/admin/billing/settings/route.ts",
  "app/api/v1/admin/billing/reconcile/route.ts",
  "app/api/v1/admin/licensing/licenses/[id]/renew/route.ts",
];

describe("LIC-04 route security boundary", () => {
  it("requires same-origin, full-scope MFA admin and support-write gates for each browser mutation", () => {
    for (const path of writes) {
      const source = readFileSync(path, "utf8");
      expect(source, path).toContain("requirePlatformAdminEscrita");
      expect(source, path).toContain("requireSupportWrite");
      expect(source, path).toContain("hasSameOrigin");
    }
  });

  it("verifies raw webhook bytes, bounds payload size, rate-limits, and never trusts customer payment status", () => {
    const source = readFileSync("app/api/v1/billing/webhooks/[provider]/route.ts", "utf8");
    expect(source).toContain("readBodyBytesLimited(request, 65_536)");
    expect(source).toContain("adapter.verify(rawBody");
    expect(source.indexOf("adapter.verify(rawBody")).toBeLessThan(
      source.indexOf("adapter.parseVerified(rawBody)"),
    );
    expect(source).toContain("PostgresRateLimiter");
    expect(source).toContain("resolveBillingWebhookSecret(provider, process.env)");
    expect(source).not.toContain("@/lib/env");
  });

  it("keeps the one-shot job and billing credentials inside the private Control Plane", () => {
    const job = readFileSync("control-plane/scripts/run-billing-maintenance.ts", "utf8");
    const policy = readFileSync("scripts/customer-build-policy.ts", "utf8");
    const customerEnv = readFileSync(".env.example", "utf8");
    const vendorEnv = readFileSync("control-plane/.env.example", "utf8");
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(job).toContain("getControlPlaneBillingService().runMaintenance");
    expect(policy).toContain('"app/api/v1/billing"');
    expect(policy).toContain('"control-plane"');
    expect(customerEnv).not.toContain("CONTROL_PLANE_BILLING_WEBHOOK_SECRETS_JSON");
    expect(customerEnv).not.toContain("CONTROL_PLANE_LICENSE_SIGNING_KEYS_JSON");
    expect(vendorEnv).toContain("CONTROL_PLANE_BILLING_WEBHOOK_SECRETS_JSON=");
    expect(packageJson.scripts["control-plane:billing-maintenance"]).toContain(
      "control-plane/.env",
    );
  });
});
