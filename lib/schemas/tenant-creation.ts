import { z } from "zod";
import { interfaceSettingsSchema, interfaceTemDestino } from "@/lib/navigation/interface";

const initialTenantSubscriptionSchema = z
  .object({
    status: z.enum(["active", "trialing"]),
    billing_interval: z.enum(["monthly", "annual", "custom"]),
    price_cents: z.number().int().nonnegative().max(999_999_999_900).nullable(),
    currency: z.string().regex(/^[A-Z]{3}$/).optional(),
    current_period_starts_at: z.string().datetime({ offset: true }),
    current_period_ends_at: z.string().datetime({ offset: true }),
    trial_ends_at: z.string().datetime({ offset: true }).nullable().optional(),
    cancel_at_period_end: z.literal(false).optional(),
  })
  .strict()
  .superRefine((subscription, context) => {
    if (Date.parse(subscription.current_period_ends_at) <= Date.parse(subscription.current_period_starts_at)) {
      context.addIssue({ code: "custom", message: "O fim do período deve ser posterior ao início.", path: ["current_period_ends_at"] });
    }
    if (Date.parse(subscription.current_period_ends_at) <= Date.now()) {
      context.addIssue({ code: "custom", message: "O período inicial deve terminar no futuro.", path: ["current_period_ends_at"] });
    }
    if (subscription.status === "trialing" && !subscription.trial_ends_at) {
      context.addIssue({ code: "custom", message: "Informe o fim do período de teste.", path: ["trial_ends_at"] });
    }
    if (subscription.status === "trialing" && subscription.trial_ends_at && Date.parse(subscription.trial_ends_at) <= Date.now()) {
      context.addIssue({ code: "custom", message: "O período de teste inicial deve terminar no futuro.", path: ["trial_ends_at"] });
    }
  });

/** Mesmo vocabulário no formulário e no limite HTTP. */
export const tenantCreationFields = {
  display_name: z.string().trim().min(2).max(120),
  slug: z
    .string()
    .min(2)
    .max(40)
    .regex(/^[a-z0-9-]+$/, "Apenas letras minúsculas, números e hífens"),
  legal_name: z.string().max(255).optional(),
  cnpj: z.string().max(18).optional(),
  plan: z.enum(["standard", "pro", "enterprise"]),
  subscription: initialTenantSubscriptionSchema.optional(),
  owner_interface_settings: interfaceSettingsSchema.optional(),
  owner_email: z.string().trim().email(),
};
export const createTenantSchema = z
  .object({ ...tenantCreationFields, plan: tenantCreationFields.plan.default("standard") })
  .refine(
    (v) => !v.owner_interface_settings || interfaceTemDestino(v.owner_interface_settings, "admin"),
    { message: "Selecione ao menos uma área de trabalho.", path: ["owner_interface_settings"] },
  );
