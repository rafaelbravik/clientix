import { describe, expect, it } from "vitest";

import {
  CASE_WAIT_REMINDER_DEFAULTS,
  caseWaitReminderConfigSchema,
  normalizarCaseWaitReminderConfig,
} from "./case-wait-reminders";

describe("configuração de lembretes por espera humana", () => {
  it("mantém os padrões do produto quando a configuração ainda não existe", () => {
    expect(normalizarCaseWaitReminderConfig(undefined)).toEqual({
      enabled: true,
      interval_hours: 24,
      limit: 3,
    });
  });

  it("aceita os limites configuráveis e rejeita valores fora da faixa", () => {
    expect(caseWaitReminderConfigSchema.safeParse({ enabled: false, interval_hours: 168, limit: 10 }).success).toBe(true);
    expect(caseWaitReminderConfigSchema.safeParse({ enabled: true, interval_hours: 0, limit: 3 }).success).toBe(false);
    expect(caseWaitReminderConfigSchema.safeParse({ enabled: true, interval_hours: 24, limit: 11 }).success).toBe(false);
  });

  it("usa defaults seguros para objeto legado inválido", () => {
    expect(normalizarCaseWaitReminderConfig({ enabled: "yes", interval_hours: 999, limit: 20 })).toEqual(
      CASE_WAIT_REMINDER_DEFAULTS,
    );
  });
});
