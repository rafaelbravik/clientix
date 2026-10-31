import { describe, expect, it } from "vitest";

import { createDefaultRegistry } from "@/lib/agent-engine/edge/llm/providers";

describe("createDefaultRegistry", () => {
  it("registra os providers que a tela oferece", () => {
    // Eram três até a migration 0127 abrir `provider` como vocabulário aberto e
    // a OpenRouter entrar. A lista fica travada aqui de propósito: provider
    // novo no registry sem entrada em `lib/ai/pontos/provedores.ts` é código
    // que ninguém alcança pela tela, e o inverso é uma tela que oferece o que
    // toda chamada recusaria. O par é vigiado por provedores-x-registry.test.ts.
    const reg = createDefaultRegistry();
    expect(Object.keys(reg).sort()).toEqual([
      "anthropic",
      // Provedor personalizado (#1642): endpoint do operador, sem endpoint
      // canônico — a factory recusa a chamada quando falta o endereço.
      "custom",
      "deepseek",
      "google",
      "openai",
      "openai-assinatura",
      "openrouter",
      "requesty",
    ]);
  });
  it("cada factory produz um LanguageModel (não lança ao instanciar)", () => {
    const reg = createDefaultRegistry();
    expect(() => reg.anthropic!("k", "claude-sonnet-4-6")).not.toThrow();
    expect(() => reg.openai!("k", "gpt-5")).not.toThrow();
    expect(() => reg["openai-assinatura"]!("oauth-synthetic-token", "gpt-5-mini")).not.toThrow();
    expect(() => reg.google!("k", "gemini-2.5-pro")).not.toThrow();
    expect(() => reg.openrouter!("k", "meta-llama/llama-3.3-70b-instruct")).not.toThrow();
    expect(() => reg.deepseek!("k", "deepseek-flash")).not.toThrow();
    expect(() => reg.requesty!("k", "openai/gpt-4o-mini")).not.toThrow();
    // Endpoint próprio (gateway compatível, ou modelo local no roteiro).
    expect(() => reg.openrouter!("k", "x/y", "https://gateway.exemplo/v1")).not.toThrow();
    expect(() => reg.deepseek!("k", "deepseek-flash", "https://gateway.exemplo/v1")).not.toThrow();
    expect(() => reg.requesty!("k", "openai/gpt-4o-mini", "https://gateway.exemplo/v1")).not.toThrow();
  });

  it("openrouter fala Chat Completions, nunca o endpoint /responses", () => {
    // Medido em 2026-09-19: `google/gemini-2.5-flash-lite` pela OpenRouter
    // devolvia "Invalid JSON response" porque `createOpenAI()(modelId)` usa o
    // /responses por padrão e a OpenRouter não o serve para todo modelo.
    // `.chat()` fixa o formato que a OpenRouter realmente implementa.
    const reg = createDefaultRegistry();
    const modelo = reg.openrouter!("k", "google/gemini-2.5-flash-lite") as { provider?: string };
    expect(modelo.provider).toBe("openai.chat");
  });

  it("assinatura é um modelo Responses separado e recusa base URL customizada", () => {
    const reg = createDefaultRegistry();
    const model = reg["openai-assinatura"]!("oauth-synthetic-token", "gpt-5-mini") as { provider?: string };
    expect(model.provider).toBe("openai.responses");
    expect(() => reg["openai-assinatura"]!("oauth-synthetic-token", "gpt-5-mini", "https://gateway.invalid/v1"))
      .toThrow("A API da assinatura do ChatGPT recusou os parâmetros da chamada.");
  });
});
