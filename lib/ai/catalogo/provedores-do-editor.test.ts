import { describe, expect, it } from "vitest";
import { CHATGPT_SUBSCRIPTION_PROVIDER } from "@/lib/ai/credenciais/chatgpt-subscription-constants";
import { PROVEDORES } from "@/lib/ai/pontos/provedores";
import { provedoresDoEditorAgente } from "./provedores-do-editor";

describe("oferta de provedor no editor de agentes", () => {
  it("mantém o catálogo normal quando o módulo está desligado", () => {
    expect(provedoresDoEditorAgente(false, true)).toEqual(PROVEDORES);
  });

  it("não oferece assinatura sem uma conta conectada", () => {
    expect(provedoresDoEditorAgente(true, false)).toEqual(PROVEDORES);
  });

  it("oferece a assinatura conectada por último sem alterar OpenAI API", () => {
    const offered = provedoresDoEditorAgente(true, true);
    expect(offered.map((provider) => provider.id)).toEqual([
      ...PROVEDORES.map((provider) => provider.id),
      CHATGPT_SUBSCRIPTION_PROVIDER,
    ]);
    expect(offered.find((provider) => provider.id === "openai")?.rotulo).toBe("OpenAI (GPT)");
    expect(offered.at(-1)?.rotulo).toBe("OpenAI pela assinatura (ChatGPT)");
    expect(offered.at(-1)?.quandoUsar).not.toContain("chave API");
  });
});
