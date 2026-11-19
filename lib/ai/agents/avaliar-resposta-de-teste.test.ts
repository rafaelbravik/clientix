import { describe, expect, it } from "vitest";
import { avaliarRespostaDeTeste } from "./avaliar-resposta-de-teste";

describe("avaliação da resposta de teste", () => {
  it("declara que a prévia não confere se fatos da empresa têm fonte", () => {
    const avaliacao = avaliarRespostaDeTeste("Nosso horário é das 9h às 18h.");

    expect(avaliacao.naoAvaliados).toContainEqual({
      gate: "knowledge_grounding",
      porque:
        "o teste não confirma se fatos sobre a empresa têm uma fonte aprovada; revise o material e a resposta",
    });
  });
});
