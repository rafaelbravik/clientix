import { describe, expect, it } from "vitest";
import type { DatabaseClient } from "../scripts/migrator";
import { BillingService } from "./billing-service";

class FakeBillingDatabase implements DatabaseClient {
  readonly calls: Array<{ sql: string; params: unknown[] }> = [];
  readonly results: Array<{ includes: string; rows: unknown[] }> = [];

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[] }> {
    this.calls.push({ sql, params });
    const result = this.results.find((candidate) => sql.includes(candidate.includes));
    return { rows: (result?.rows ?? []) as R[] };
  }
}

describe("Control Plane billing service", () => {
  it("fails closed for gateway subscription creation before any database call", async () => {
    const db = new FakeBillingDatabase();
    const service = new BillingService(db);
    await expect(
      service.createSubscription({
        customer_id: "00000000-0000-4000-8000-000000000001",
        license_id: "00000000-0000-4000-8000-000000000002",
        provider: "STRIPE",
        billing_cycle: "ANNUAL",
        amount_cents: 100,
        currency: "BRL",
        current_period_start: "2026-11-06T00:00:00Z",
        current_period_end: "2027-11-06T00:00:00Z",
        auto_renew: true,
        idempotency_key: "billing-idempotency-key",
        actor_id: "synthetic-operator",
        request_id: "synthetic-request",
      }),
    ).rejects.toThrow(/Only MANUAL/);
    expect(db.calls).toHaveLength(0);
  });

  it("keeps all external payment webhooks disabled regardless of provider metadata", async () => {
    const db = new FakeBillingDatabase();
    const service = new BillingService(db);
    await expect(service.isWebhookProviderReady("STRIPE")).resolves.toBe(false);
    await expect(service.isWebhookProviderReady("MERCADO_PAGO")).resolves.toBe(false);
    expect(db.calls).toHaveLength(0);
  });

  it("persists a normalized request fingerprint and uppercase currency for MANUAL subscriptions", async () => {
    const db = new FakeBillingDatabase();
    db.results.push({
      includes: "create_billing_subscription",
      rows: [{ id: "subscription-1", amount_cents: 100 }],
    });
    const service = new BillingService(db);
    await service.createSubscription({
      customer_id: "00000000-0000-4000-8000-000000000001",
      license_id: "00000000-0000-4000-8000-000000000002",
      provider: "MANUAL",
      billing_cycle: "ANNUAL",
      amount_cents: 100,
      currency: "brl",
      current_period_start: "2026-11-06T00:00:00Z",
      current_period_end: "2027-11-06T00:00:00Z",
      auto_renew: true,
      idempotency_key: "billing-idempotency-key",
      actor_id: "synthetic-operator",
      request_id: "synthetic-request",
    });
    expect(db.calls[0]?.params[5]).toBe("BRL");
    expect(db.calls[0]?.params[10]).toMatch(/^[0-9a-f]{64}$/);
  });

  it("routes a signed payment-failed event to the failure transition rather than renewal", async () => {
    const db = new FakeBillingDatabase();
    db.results.push(
      {
        includes: "record_billing_payment_failure",
        rows: [
          {
            payment_id: "payment-1",
            invoice_id: "00000000-0000-4000-8000-000000000003",
            duplicate: false,
          },
        ],
      },
      {
        includes: "from control_plane.billing_invoices i",
        rows: [
          {
            id: "00000000-0000-4000-8000-000000000003",
            subscription_id: "00000000-0000-4000-8000-000000000004",
            license_id: "00000000-0000-4000-8000-000000000005",
            customer_id: "00000000-0000-4000-8000-000000000006",
            provider: "STRIPE",
            amount_cents: 100,
            currency: "BRL",
            status: "OPEN",
            due_at: "2026-11-07T00:00:00.000Z",
            paid_at: null,
            period_start: "2026-11-06T00:00:00.000Z",
            period_end: "2027-11-06T00:00:00.000Z",
            created_at: "2026-11-06T00:00:00.000Z",
            updated_at: "2026-11-06T00:00:00.000Z",
            customer_name: "Synthetic",
            customer_email: "billing@example.invalid",
            license_serial: "CLX-2026-AAAA-BBBB",
            sub_status: "ACTIVE",
            billing_cycle: "ANNUAL",
            auto_renew: true,
            next_billing_at: null,
            current_period_start: "2026-11-06T00:00:00.000Z",
            current_period_end: "2027-11-06T00:00:00.000Z",
            billing_grace_days: 7,
            nonpayment_policy: "ALLOW_NATURAL_EXPIRATION",
            license_status: "ACTIVE",
            license_expires_at: "2027-11-06T00:00:00.000Z",
            subscription_amount_cents: 100,
          },
        ],
      },
      { includes: "where invoice_id=$1::uuid order by created_at desc", rows: [] },
      { includes: "from control_plane.billing_events where invoice_id=$1::uuid", rows: [] },
    );
    const service = new BillingService(db);
    await service.confirmProviderPayment({
      event: {
        event_id: "evt-test",
        type: "payment.failed",
        invoice_id: "00000000-0000-4000-8000-000000000003",
        payment_id: "pay-test",
        amount_cents: 100,
        currency: "BRL",
      },
      provider: "STRIPE",
      payload_sha256: "a".repeat(64),
      request_id: "request-test",
    });
    expect(db.calls.some((call) => call.sql.includes("record_billing_payment_failure"))).toBe(true);
    expect(db.calls.some((call) => call.sql.includes("confirm_billing_payment"))).toBe(false);
  });
});
