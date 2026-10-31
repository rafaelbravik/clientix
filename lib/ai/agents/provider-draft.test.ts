import { describe, expect, it } from "vitest";
import { CHATGPT_SUBSCRIPTION_PROVIDER } from "@/lib/ai/credenciais/chatgpt-siwc";
import { IDS_DE_PROVEDOR } from "@/lib/ai/pontos/provedores";
import { PROVIDERS, PROVIDERS_DE_RASCUNHO, versionPatchSchema } from "@/lib/ai/agents/validation";

describe("provider de assinatura em rascunhos", () => {
  it("mantém o registry executável separado do provider de assinatura", () => {
    expect(PROVIDERS).toEqual(IDS_DE_PROVEDOR);
    expect(PROVIDERS).not.toContain(CHATGPT_SUBSCRIPTION_PROVIDER);
    expect(PROVIDERS_DE_RASCUNHO).toContain(CHATGPT_SUBSCRIPTION_PROVIDER);
  });

  it("aceita openai-assinatura somente no schema de edição do rascunho", () => {
    expect(versionPatchSchema.safeParse({ provider: CHATGPT_SUBSCRIPTION_PROVIDER }).success).toBe(true);
  });
});
