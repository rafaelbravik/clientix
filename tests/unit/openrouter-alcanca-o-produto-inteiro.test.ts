/**
 * ESCOLHER OPENROUTER NO INSTALADOR NÃO PODE SER UMA PERGUNTA DECORATIVA.
 *
 * O `install.sh` passou a oferecer OpenRouter como PRIMEIRA opção de "qual IA
 * vai atender". A partir daí, cada lugar que só conhece anthropic/openai vira
 * um buraco na instalação que aceitou o convite — e os buracos são mudos, que é
 * o que os torna caros:
 *
 *  - `resolveOrgLlmConfig` não tinha ramo de fallback de env para openrouter:
 *    numa instalação sem `ANTHROPIC_API_KEY`, TUDO que passa pelo seam lançava
 *    `LlmNotConfiguredError`. Na derivação de mídia isso acontecia ANTES do
 *    mecanismo de aviso: 5 tentativas, `media_derived_status='failed'`, zero
 *    avisos na Central, só um `logger.error` no log do contêiner.
 *  - `modelCapabilities('openrouter', 'openai/gpt-4o')` devolvia
 *    `{image:false}`, porque a capacidade era do PROVEDOR e num roteador ela é
 *    do MODELO. O comprovante do cliente virava marcador e o aviso afirmava "o
 *    modelo openai/gpt-4o não enxerga imagens" — falso, e gravado para o
 *    operador ler.
 *  - `lib/env.ts` avisava no boot que a IA ia ficar muda por falta de chave —
 *    numa instalação em que ela não ia ficar.
 */
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  capacidadeEhConhecida,
  modelCapabilities,
} from "@/lib/agent-engine/edge/llm/capabilities";
import { llmEdgeConfigFromEnv } from "@/lib/agent-engine/edge/llm/credentials";

describe("a chave da OpenRouter chega ao seam", () => {
  it("llmEdgeConfigFromEnv carrega OPENROUTER_API_KEY", () => {
    const cfg = llmEdgeConfigFromEnv({ OPENROUTER_API_KEY: "sk-or-v1-teste" });
    expect(
      cfg.openrouterApiKey,
      "sem isto, a instalação só-OpenRouter não tem chave que o seam aceite e tudo morre com llm_not_configured",
    ).toBe("sk-or-v1-teste");
  });

  it("chave vazia não vira string vazia (o mesmo cuidado das outras duas)", () => {
    const cfg = llmEdgeConfigFromEnv({ OPENROUTER_API_KEY: "" });
    expect(cfg.openrouterApiKey).toBeUndefined();
  });

  it("o resolvedor tem o ramo de fallback para openrouter", () => {
    // Comportamental seria melhor, mas `resolveOrgLlmConfig` exige `pg.Pool` e
    // decifragem AES — está coberto no invariante com Postgres real. Aqui o
    // alvo é a existência do RAMO, que é o que faltava.
    const fonte = readFileSync("lib/agent-engine/edge/llm/credentials.ts", "utf8");
    expect(fonte).toMatch(/provider === 'openrouter' && cfg\.openrouterApiKey/);
  });
});

describe("capacidade num roteador é do MODELO, não do provedor", () => {
  it("o instrumento distingue os providers conhecidos (controle positivo)", () => {
    expect(modelCapabilities("anthropic", "claude-sonnet-4-6").image).toBe(true);
    expect(modelCapabilities("provedor-que-nao-existe", "qualquer").image).toBe(false);
  });

  it("openrouter + modelo de fabricante com visão enxerga imagem", () => {
    expect(
      modelCapabilities("openrouter", "openai/gpt-4o").image,
      "o comprovante do cliente virava marcador, e o aviso afirmava que o gpt-4o não enxerga imagens",
    ).toBe(true);
    expect(modelCapabilities("openrouter", "anthropic/claude-sonnet-4-6").image).toBe(true);
  });

  it("openrouter + fabricante desconhecido continua conservador", () => {
    // Conservador é o desfecho certo aqui: mandar imagem para um modelo que não
    // a aceita quebra o turno inteiro. O que muda é o que se DIZ sobre isso.
    expect(modelCapabilities("openrouter", "fabricante-x/modelo-y").image).toBe(false);
  });

  it("'não sei' é distinguível de 'não consegue'", () => {
    // Sem esta distinção, o aviso ao operador afirma uma limitação que ninguém
    // verificou — e ele vai trocar de modelo por causa de uma frase inventada.
    expect(capacidadeEhConhecida("openrouter", "openai/gpt-4o")).toBe(true);
    expect(capacidadeEhConhecida("openrouter", "fabricante-x/modelo-y")).toBe(false);
    expect(capacidadeEhConhecida("anthropic", "claude-sonnet-4-6")).toBe(true);
  });

  it("embedding/tts continuam rebaixados mesmo num fabricante capaz", () => {
    expect(modelCapabilities("openrouter", "openai/text-embedding-3-small").image).toBe(false);
  });
});

describe("o aviso de boot lê a mesma régua que a execução", () => {
  it("OPENROUTER_API_KEY conta como chave de IA configurada", () => {
    const fonte = readFileSync("lib/env.ts", "utf8");
    const condicao = /if \(\s*!env\.AI_GATEWAY_API_KEY\s*&&\s*!env\.ANTHROPIC_API_KEY([^)]*)\)/.exec(fonte);
    expect(condicao, "não achei o aviso de chave de IA no lib/env.ts — instrumento cego").not.toBeNull();
    expect(
      condicao?.[1],
      "o boot avisa que a IA está muda numa instalação só-OpenRouter, em que ela não está",
    ).toContain("OPENROUTER_API_KEY");
  });
});

describe("o worker de mídia obedece ao painel", () => {
  it("lê o binding de visao_de_imagem antes de resolver o modelo", () => {
    // O ponto é editável na tela (sem `fixo`, fora dos governados pelo agente
    // publicado). Enquanto o worker resolvia só pela config da org, a tela
    // aceitava a escolha, dizia "salvo", gravava a linha — e a descrição de
    // imagem seguia no modelo padrão. É a classe de defeito que o próprio
    // `gateway-binding.ts` declara ter vindo matar.
    const fonte = readFileSync("workers/media-derive-worker.ts", "utf8");
    expect(fonte).toMatch(/lerBindingDoPonto\(\s*admin,\s*row\.organization_id,\s*"visao_de_imagem"\s*\)/);
    expect(fonte).toContain("ai_purpose_bindings");
  });

  it("a chave da OpenRouter é passada ao seam da derivação", () => {
    const fonte = readFileSync("workers/media-derive-worker.ts", "utf8");
    expect(fonte).toMatch(/openrouterApiKey: process\.env\.OPENROUTER_API_KEY/);
  });
});

describe("o provedor escolhido no instalador chega à primeira organização", () => {
  it("preserva o padrão no ambiente e só a rota server-side o injeta na RPC", () => {
    const instalador = readFileSync("hostgator-setup-kit/install.sh", "utf8");
    const envExample = readFileSync(".env.example", "utf8");
    const rota = readFileSync("app/api/v1/admin/tenants/route.ts", "utf8");
    expect(instalador).toMatch(/envq AI_PROVIDER \"\$\{AI_PROVIDER:-anthropic\}\"/);
    expect(envExample).toContain("AI_PROVIDER=anthropic");
    expect(rota).toMatch(/default_llm_provider: env\.AI_PROVIDER \|\| \"anthropic\"/);
    expect(rota).toMatch(/admin\.rpc\(\"fn_create_tenant_with_owner_limited\"/);
  });

  it("a RPC aplica provider e modelo dentro da criação atômica da organização", () => {
    const migration = readFileSync("supabase/migrations/20261103121717_9062_platform_owner_first_run_setup.sql", "utf8");
    expect(migration).toContain("CREATE OR REPLACE FUNCTION public.fn_create_tenant_with_owner_limited(");
    expect(migration).toContain("v_default_llm_provider text := NULLIF(p_request->>'default_llm_provider', '')");
    expect(migration).toContain("'{llm,provider}'");
    expect(migration).toContain("'{llm,default_model}'");
    expect(migration).toMatch(/GRANT EXECUTE ON FUNCTION public\.fn_create_tenant_with_owner_limited[\s\S]*?TO service_role;/);
  });

  it("o bootstrap-owner faz o mesmo (é o caminho do e2e e da doc)", () => {
    const fonte = readFileSync("scripts/bootstrap-owner.ts", "utf8");
    expect(fonte).toContain("aplicarProvedorEscolhido");
    expect(fonte).toMatch(/process\.env\.AI_PROVIDER/);
  });

  it("o bootstrap de testes também mantém o MODELO do provedor escolhido", () => {
    // Trocar só o provider deixava `{openai, claude-sonnet-5}`. A escolha em si
    // é provada em `lib/ai/agents/escolher-modelo.test.ts`.
    const bootstrap = readFileSync("scripts/bootstrap-owner.ts", "utf8");
    expect(bootstrap).toMatch(/escolherModeloNoCatalogo\(admin, escolhido\)/);
    expect(bootstrap).toMatch(/default_model: modelo/);
  });
});
