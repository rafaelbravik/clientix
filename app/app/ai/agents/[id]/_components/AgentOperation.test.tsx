import { describe, expect, it } from "vitest";
import { agentOperationDescription } from "./AgentOperation";

describe("descrição do modo de operação do agente", () => {
  it("explica que o modo assistido exige aprovação antes do envio", () => {
    expect(agentOperationDescription("assisted", false)).toBe(
      "O modo assistido prepara sugestões na conversa. Só a aprovação humana autoriza o envio.",
    );
  });

  it("explica que o modo automático envia sem aprovação humana", () => {
    expect(agentOperationDescription("automatic", false)).toBe(
      "No modo automático, o agente envia respostas sem aprovação humana, conforme as regras e limites configurados.",
    );
  });

  it("mantém a explicação de pausa em qualquer modo", () => {
    expect(agentOperationDescription("automatic", true)).toBe(
      "Automático pausado. A versão publicada foi preservada e a assistência continua disponível.",
    );
    expect(agentOperationDescription("assisted", true)).toBe(
      "Automático pausado. A versão publicada foi preservada e a assistência continua disponível.",
    );
  });
});
