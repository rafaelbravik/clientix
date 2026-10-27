import { describe, expect, it } from "vitest";

import { AGENT_TOOL_DEFS } from "@/lib/agent-engine/agent/inbound-turn";

type SchemaComDescricoes = {
  shape?: Record<string, { description?: string }>;
};

function descricaoCampo(
  tool: keyof typeof AGENT_TOOL_DEFS,
  field: string,
): string {
  const schema = AGENT_TOOL_DEFS[tool].inputSchema as unknown as SchemaComDescricoes;
  return schema.shape?.[field]?.description ?? "";
}

const camposNoIdiomaDaConversa = [
  ["send_message", "body"],
  ["search_knowledge", "query"],
  ["open_human_case", "title"],
  ["open_human_case", "summary"],
  ["open_human_case", "blocker"],
] as const;

describe("tools customer-facing usam o idioma da conversa", () => {
  it("nenhuma descrição de tool fixa pt-BR/português para o cliente", () => {
    const descricoes = Object.values(AGENT_TOOL_DEFS).flatMap((tool) => {
      const schema = tool.inputSchema as unknown as SchemaComDescricoes;
      return [
        tool.description,
        ...Object.values(schema.shape ?? {}).map((campo) => campo.description ?? ""),
      ];
    });

    expect(descricoes.join("\n")).not.toMatch(/\b(?:em\s+pt[-‑]?br|em\s+portugu[eê]s|pt[-‑]?br)\b/i);
  });

  it.each(camposNoIdiomaDaConversa)("%s.%s solicita o idioma da conversa", (tool, field) => {
    expect(descricaoCampo(tool, field)).toMatch(/idioma da conversa/i);
  });
});
