import { z } from "zod";

export const caseWaitReminderConfigSchema = z
  .object({
    enabled: z.boolean(),
    interval_hours: z.number().int().min(1).max(168),
    limit: z.number().int().min(1).max(10),
  })
  .strict();

export type CaseWaitReminderConfig = z.infer<typeof caseWaitReminderConfigSchema>;

export const CASE_WAIT_REMINDER_DEFAULTS: CaseWaitReminderConfig = {
  enabled: true,
  interval_hours: 24,
  limit: 3,
};

/** Lê settings persistidas sem deixar valor legado/malformed derrubar a Central. */
export function normalizarCaseWaitReminderConfig(value: unknown): CaseWaitReminderConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return CASE_WAIT_REMINDER_DEFAULTS;
  }
  const raw = value as Record<string, unknown>;
  const parsed = caseWaitReminderConfigSchema.safeParse({
    enabled: typeof raw.enabled === "boolean" ? raw.enabled : CASE_WAIT_REMINDER_DEFAULTS.enabled,
    interval_hours:
      typeof raw.interval_hours === "number" ? raw.interval_hours : CASE_WAIT_REMINDER_DEFAULTS.interval_hours,
    limit: typeof raw.limit === "number" ? raw.limit : CASE_WAIT_REMINDER_DEFAULTS.limit,
  });
  return parsed.success ? parsed.data : CASE_WAIT_REMINDER_DEFAULTS;
}
