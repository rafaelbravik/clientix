import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ moduloLigado: vi.fn() }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: mocks.moduloLigado }));

import { duplicateAgentWithVersion } from "./duplicate";

function dbDeAssinatura() {
  const inserts: string[] = [];
  const build = (table: string) => {
    const state: Record<string, unknown> = {};
    const query: Record<string, unknown> = {
      select: () => query,
      eq: (key: string, value: unknown) => { state[key] = value; return query; },
      order: () => query,
      limit: () => query,
      maybeSingle: async () => {
        if (table === "ai_agents") return { data: { id: "agent-a", organization_id: "org-a", kind: "mcp_agent", name: "Agente" }, error: null };
        if (state.status === "draft") return { data: null, error: null };
        return { data: { id: "version-a", provider: "openai-assinatura", model: "gpt-A", credential_id: "credential-a" }, error: null };
      },
      insert: () => { inserts.push(table); return query; },
    };
    return query;
  };
  return { admin: { from: (table: string) => build(table) } as never, inserts };
}

describe("duplicação respeita o módulo login_codex", () => {
  beforeEach(() => { mocks.moduloLigado.mockReset().mockResolvedValue(false); });

  it("recusa duplicar versão de assinatura quando o módulo está desligado", async () => {
    const { admin, inserts } = dbDeAssinatura();
    const result = await duplicateAgentWithVersion(admin, {
      orgId: "org-a", agentId: "agent-a", actorUserId: "user-a", requireVersion: true,
    });
    expect(result).toEqual({ ok: false, error: "provider_disabled" });
    expect(mocks.moduloLigado).toHaveBeenCalledWith(admin, "login_codex");
    expect(inserts).toEqual([]);
  });
});
