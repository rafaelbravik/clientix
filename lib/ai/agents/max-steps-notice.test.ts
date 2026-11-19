import { describe, expect, it } from "vitest";
import { avisoDeLimiteDeEtapas } from "./max-steps-notice";

describe("aviso do limite de etapas do agente", () => {
  it("explica o risco quando só há uma etapa", () => {
    expect(avisoDeLimiteDeEtapas(1)).toBe(
      "Com 1 etapa, uma chamada de ferramenta pode encerrar o turno antes de o agente enviar uma resposta.",
    );
  });

  it("não mostra o aviso com mais etapas", () => {
    expect(avisoDeLimiteDeEtapas(2)).toBeNull();
    expect(avisoDeLimiteDeEtapas(10)).toBeNull();
  });
});
