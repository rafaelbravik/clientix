import { describe, expect, it } from "vitest";
import {
  BillingProviderNotConfiguredError,
  disabledBillingProviders,
  enabledBillingProviders,
  isBillingProviderEnabled,
  ManualBillingProvider,
  NormalizedHmacWebhookAdapter,
  UnconfiguredBillingProvider,
  signNormalizedWebhookForTest,
} from "./billing-provider";

const secret = "synthetic-test-webhook-secret-with-32-chars";

function rawEvent() {
  return new TextEncoder().encode(
    JSON.stringify({
      event_id: "evt_synthetic_01",
      type: "payment.confirmed",
      invoice_id: "9ebd2cb6-50de-456e-9cbc-2a7be9f8ae50",
      payment_id: "pay_synthetic_01",
      amount_cents: 12500,
      currency: "brl",
      occurred_at: "2026-11-06T12:00:00Z",
    }),
  );
}

describe("LIC-04 billing provider boundary", () => {
  it("supports manual billing without calling an external provider", async () => {
    const provider = new ManualBillingProvider();
    await expect(provider.createSubscription({ subscription_id: "synthetic" })).resolves.toEqual({
      provider_subscription_id: null,
    });
    await expect(
      provider.createInvoice({
        invoice_id: "synthetic",
        amount_cents: 1,
        currency: "BRL",
        due_at: "2026-11-07T00:00:00Z",
      }),
    ).resolves.toEqual({ provider_invoice_id: null });
    await expect(provider.refundPayment("synthetic")).rejects.toThrow(/recorded administratively/);
  });

  it("enables only MANUAL and keeps future gateway adapters disabled in LIC-04", async () => {
    expect(enabledBillingProviders).toEqual(["MANUAL"]);
    expect(disabledBillingProviders).toEqual(["STRIPE", "MERCADO_PAGO"]);
    expect(isBillingProviderEnabled("MANUAL")).toBe(true);
    expect(isBillingProviderEnabled("STRIPE")).toBe(false);
    expect(isBillingProviderEnabled("MERCADO_PAGO")).toBe(false);

    const provider = new UnconfiguredBillingProvider("STRIPE");
    await expect(
      provider.createInvoice({
        invoice_id: "synthetic",
        amount_cents: 1,
        currency: "BRL",
        due_at: "2026-11-07T00:00:00Z",
      }),
    ).rejects.toBeInstanceOf(BillingProviderNotConfiguredError);
  });

  it("verifies raw-body HMAC before parsing and normalizes only a signed event", () => {
    const now = new Date("2026-11-06T12:00:00Z");
    const timestamp = Math.floor(now.getTime() / 1000);
    const body = rawEvent();
    const adapter = new NormalizedHmacWebhookAdapter("STRIPE", secret);
    const signature = signNormalizedWebhookForTest(body, secret, timestamp);

    expect(adapter.verify(body, signature, now)).toBe(true);
    expect(adapter.parseVerified(body)).toMatchObject({
      type: "payment.confirmed",
      currency: "BRL",
      amount_cents: 12500,
    });
    expect(
      adapter.verify(
        new TextEncoder().encode(`${new TextDecoder().decode(body)} `),
        signature,
        now,
      ),
    ).toBe(false);
    expect(() => adapter.parseVerified(new TextEncoder().encode("not-json"))).toThrow();
  });

  it("rejects stale timestamps, malformed signatures, and overlarge bodies", () => {
    const now = new Date("2026-11-06T12:00:00Z");
    const body = rawEvent();
    const adapter = new NormalizedHmacWebhookAdapter("MERCADO_PAGO", secret);
    const staleSignature = signNormalizedWebhookForTest(
      body,
      secret,
      Math.floor(now.getTime() / 1000) - 301,
    );
    expect(adapter.verify(body, staleSignature, now)).toBe(false);
    expect(adapter.verify(body, "v1=not-a-signature", now)).toBe(false);
    expect(adapter.verify(new Uint8Array(65_537), "t=1793966400,v1=" + "0".repeat(64), now)).toBe(
      false,
    );
  });

  it("rejects a short webhook secret", () => {
    expect(() => new NormalizedHmacWebhookAdapter("STRIPE", "short")).toThrow(/32 characters/);
  });
});
