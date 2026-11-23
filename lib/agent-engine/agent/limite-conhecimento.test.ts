import { describe, expect, it } from "vitest";
import { blocoLimiteDeConhecimento } from "./limite-conhecimento";

describe("limite de conhecimento da organização", () => {
  it("não cria o bloco sem configuração de agente", () => {
    expect(blocoLimiteDeConhecimento(null)).toBeNull();
  });

  it("não cria o bloco quando há material novo ou legado habilitado", () => {
    expect(blocoLimiteDeConhecimento({ knowledgeSourceIds: ["source-1"] })).toBeNull();
    expect(blocoLimiteDeConhecimento({ activeKbVersionId: "kb-1" })).toBeNull();
  });

  it("proíbe inferir fatos empresariais quando não há material", () => {
    const bloco = blocoLimiteDeConhecimento({ knowledgeSourceIds: [], activeKbVersionId: null });

    expect(bloco).toContain("não tem material da empresa");
    expect(bloco).toContain("Não responda horário, endereço, preço");
    expect(bloco).toContain("não chute");
    expect(bloco).toContain("Não prometa retorno");
  });

  it("só permite afirmar transferência após a ferramenta concluir", () => {
    const bloco = blocoLimiteDeConhecimento({
      knowledgeSourceIds: [],
      activeKbVersionId: null,
      handoffToolEnabled: true,
    });

    expect(bloco).toContain(
      "Só diga que alguém foi acionado depois que a ferramenta concluir com sucesso.",
    );
  });
});
