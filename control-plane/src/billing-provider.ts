import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

export const billingProviderNames = ["MANUAL", "STRIPE", "MERCADO_PAGO"] as const;
export type BillingProviderName = (typeof billingProviderNames)[number];
export const enabledBillingProviders = ["MANUAL"] as const;
export const disabledBillingProviders = ["STRIPE", "MERCADO_PAGO"] as const;

export function isBillingProviderEnabled(provider: BillingProviderName): boolean {
  return (enabledBillingProviders as readonly string[]).includes(provider);
}

export interface BillingProviderInvoiceInput {
  invoice_id: string;
  amount_cents: number;
  currency: string;
  due_at: string;
}

export interface BillingProvider {
  readonly name: BillingProviderName;
  createSubscription(input: {
    subscription_id: string;
  }): Promise<{ provider_subscription_id: string | null }>;
  cancelSubscription(providerSubscriptionId: string | null): Promise<void>;
  createInvoice(
    input: BillingProviderInvoiceInput,
  ): Promise<{ provider_invoice_id: string | null }>;
  getInvoice(providerInvoiceId: string | null): Promise<unknown | null>;
  getPayment(providerPaymentId: string): Promise<unknown | null>;
  refundPayment(providerPaymentId: string, amountCents?: number): Promise<void>;
}

export class BillingProviderNotConfiguredError extends Error {
  constructor(provider: BillingProviderName) {
    super(`Billing provider ${provider} is not configured for live operations.`);
    this.name = "BillingProviderNotConfiguredError";
  }
}

/** Manual provider has no financial credentials or external network side effects. */
export class ManualBillingProvider implements BillingProvider {
  readonly name = "MANUAL" as const;

  async createSubscription(_input: {
    subscription_id: string;
  }): Promise<{ provider_subscription_id: null }> {
    return { provider_subscription_id: null };
  }

  async cancelSubscription(_providerSubscriptionId: string | null): Promise<void> {}

  async createInvoice(_input: BillingProviderInvoiceInput): Promise<{ provider_invoice_id: null }> {
    return { provider_invoice_id: null };
  }

  async getInvoice(_providerInvoiceId: string | null): Promise<null> {
    return null;
  }

  async getPayment(_providerPaymentId: string): Promise<null> {
    return null;
  }

  async refundPayment(_providerPaymentId: string, _amountCents?: number): Promise<void> {
    throw new Error("Manual refunds are recorded administratively; no gateway refund is sent.");
  }
}

/** Future gateways fail closed until their native adapter and credentials are configured. */
export class UnconfiguredBillingProvider implements BillingProvider {
  constructor(readonly name: Exclude<BillingProviderName, "MANUAL">) {}

  async createSubscription(_input: { subscription_id: string }): Promise<never> {
    throw new BillingProviderNotConfiguredError(this.name);
  }
  async cancelSubscription(_providerSubscriptionId: string | null): Promise<never> {
    throw new BillingProviderNotConfiguredError(this.name);
  }
  async createInvoice(_input: BillingProviderInvoiceInput): Promise<never> {
    throw new BillingProviderNotConfiguredError(this.name);
  }
  async getInvoice(_providerInvoiceId: string | null): Promise<never> {
    throw new BillingProviderNotConfiguredError(this.name);
  }
  async getPayment(_providerPaymentId: string): Promise<never> {
    throw new BillingProviderNotConfiguredError(this.name);
  }
  async refundPayment(_providerPaymentId: string, _amountCents?: number): Promise<never> {
    throw new BillingProviderNotConfiguredError(this.name);
  }
}

export function getBillingProvider(name: BillingProviderName): BillingProvider {
  if (name === "MANUAL") return new ManualBillingProvider();
  return new UnconfiguredBillingProvider(name);
}

export interface BillingWebhookEvent {
  event_id: string;
  type: "payment.confirmed" | "payment.failed";
  invoice_id: string;
  payment_id: string;
  amount_cents: number;
  currency: string;
  occurred_at?: string;
}

export interface BillingWebhookAdapter {
  readonly provider: Exclude<BillingProviderName, "MANUAL">;
  verify(rawBody: Uint8Array, signatureHeader: string | null, now?: Date): boolean;
  parseVerified(rawBody: Uint8Array): BillingWebhookEvent;
}

const normalizedWebhookSchema = z
  .object({
    event_id: z.string().min(1).max(200),
    type: z.enum(["payment.confirmed", "payment.failed"]),
    invoice_id: z.string().uuid(),
    payment_id: z.string().min(1).max(200),
    amount_cents: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    currency: z.string().regex(/^[A-Za-z]{3}$/),
    occurred_at: z.string().datetime({ offset: true }).optional(),
  })
  .strict();

/**
 * HMAC primitive for provider adapters that normalize and re-sign a gateway
 * event at a trusted vendor boundary. Native Stripe/MP signature parsers remain
 * provider-specific and are deliberately not enabled by this generic adapter.
 */
export class NormalizedHmacWebhookAdapter implements BillingWebhookAdapter {
  constructor(
    readonly provider: Exclude<BillingProviderName, "MANUAL">,
    private readonly secret: string,
    private readonly toleranceSeconds = 300,
  ) {
    if (secret.length < 32) throw new Error("Webhook secret must contain at least 32 characters.");
    if (!Number.isInteger(toleranceSeconds) || toleranceSeconds < 1 || toleranceSeconds > 900)
      throw new Error("Invalid webhook timestamp tolerance.");
  }

  verify(rawBody: Uint8Array, signatureHeader: string | null, now = new Date()): boolean {
    if (!signatureHeader || rawBody.byteLength === 0 || rawBody.byteLength > 65_536) return false;
    const match = /^t=(\d{10,13}),v1=([a-f0-9]{64})$/i.exec(signatureHeader.trim());
    if (!match) return false;
    const rawTimestamp = Number(match[1]);
    const timestampSeconds =
      rawTimestamp > 10_000_000_000 ? Math.floor(rawTimestamp / 1000) : rawTimestamp;
    if (!Number.isSafeInteger(timestampSeconds)) return false;
    if (Math.abs(Math.floor(now.getTime() / 1000) - timestampSeconds) > this.toleranceSeconds)
      return false;
    const expected = createHmac("sha256", this.secret)
      .update(`${timestampSeconds}.`, "utf8")
      .update(rawBody)
      .digest();
    let supplied: Buffer;
    try {
      supplied = Buffer.from(match[2]!, "hex");
    } catch {
      return false;
    }
    return supplied.length === expected.length && timingSafeEqual(supplied, expected);
  }

  parseVerified(rawBody: Uint8Array): BillingWebhookEvent {
    const parsed = normalizedWebhookSchema.safeParse(
      JSON.parse(Buffer.from(rawBody).toString("utf8")),
    );
    if (!parsed.success) throw new Error("Invalid normalized billing webhook payload.");
    return { ...parsed.data, currency: parsed.data.currency.toUpperCase() };
  }
}

export function signNormalizedWebhookForTest(
  rawBody: Uint8Array,
  secret: string,
  timestampSeconds: number,
): string {
  const signature = createHmac("sha256", secret)
    .update(`${timestampSeconds}.`, "utf8")
    .update(rawBody)
    .digest("hex");
  return `t=${timestampSeconds},v1=${signature}`;
}
