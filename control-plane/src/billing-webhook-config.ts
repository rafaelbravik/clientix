import { z } from "zod";

const providerSecretsSchema = z
  .object({ STRIPE: z.string().min(32).optional(), MERCADO_PAGO: z.string().min(32).optional() })
  .strict();

export type BillingWebhookProvider = keyof z.infer<typeof providerSecretsSchema>;

/** Reads credentials only in the private Vendor webhook route. */
export function resolveBillingWebhookSecret(
  provider: BillingWebhookProvider,
  source: Record<string, string | undefined>,
): string | null {
  const raw = source.CONTROL_PLANE_BILLING_WEBHOOK_SECRETS_JSON;
  if (!raw || raw.length > 4_096) return null;
  try {
    const parsed = providerSecretsSchema.safeParse(JSON.parse(raw));
    return parsed.success ? (parsed.data[provider] ?? null) : null;
  } catch {
    return null;
  }
}
