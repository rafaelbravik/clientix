import { describe, expect, it } from "vitest";

import { isDeletedSubjectSuppressionError, isSuppressionUnavailableError } from "@/lib/lgpd/suppression";

describe("erros da cerca de supressão LGPD", () => {
  it("reconhece somente o marcador estável de titular apagado", () => {
    expect(isDeletedSubjectSuppressionError({ code: "42501", message: "lgpd_subject_suppressed" })).toBe(true);
    expect(isDeletedSubjectSuppressionError({ code: "PGRST", message: "erro genérico" })).toBe(false);
    expect(isDeletedSubjectSuppressionError(null)).toBe(false);
  });

  it("mantém indisponibilidade de tombstone como resultado separado", () => {
    expect(isSuppressionUnavailableError({ code: "55000", message: "lgpd_suppression_unavailable" })).toBe(true);
    expect(isSuppressionUnavailableError({ code: "42501", message: "lgpd_subject_suppressed" })).toBe(false);
  });
});
