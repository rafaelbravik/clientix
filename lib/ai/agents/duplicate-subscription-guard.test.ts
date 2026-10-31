import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ moduloLigado: vi.fn(), validarModeloDaAssinatura: vi.fn() }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: mocks.moduloLigado }));
vi.mock("@/lib/ai/catalogo/modelos-da-assinatura", () => ({
  validarModeloDaAssinatura: mocks.validarModeloDaAssinatura,
}));

import { duplicateAgentWithVersion } from "./duplicate";

function dbDeAssinatura() {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
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
      insert: (row: Record<string, unknown>) => {
        inserts.push({ table, row });
        const id = table === "ai_agents" ? "agent-copy" : "version-copy";
        return { select: () => ({ single: async () => ({ data: { ...row, id }, error: null }) }) };
      },
    };
    return query;
  };
  return { admin: { from: (table: string) => build(table) } as never, inserts };
}

describe("duplicação respeita o módulo login_codex", () => {
  beforeEach(() => {
    mocks.moduloLigado.mockReset().mockResolvedValue(false);
    mocks.validarModeloDaAssinatura.mockReset().mockResolvedValue({ ok: true });
  });

  it("recusa duplicar versão de assinatura quando o módulo está desligado", async () => {
    const { admin, inserts } = dbDeAssinatura();
    const result = await duplicateAgentWithVersion(admin, {
      orgId: "org-a", agentId: "agent-a", actorUserId: "user-a", requireVersion: true,
    });
    expect(result).toEqual({ ok: false, error: "provider_disabled" });
    expect(mocks.moduloLigado).toHaveBeenCalledWith(admin, "login_codex");
    expect(inserts).toEqual([]);
  });

  it("com o módulo ligado preserva provider/modelo sem duplicar credencial", async () => {
    mocks.moduloLigado.mockResolvedValue(true);
    const { admin, inserts } = dbDeAssinatura();
    const result = await duplicateAgentWithVersion(admin, {
      orgId: "org-a", agentId: "agent-a", actorUserId: "user-a", requireVersion: true,
    });

    expect(result.ok).toBe(true);
    expect(mocks.validarModeloDaAssinatura).toHaveBeenCalledWith({
      admin,
      organizationId: "org-a",
      credentialId: "credential-a",
      modelId: "gpt-A",
    });
    const versionInsert = inserts.find(({ table }) => table === "ai_agent_versions")?.row;
    expect(versionInsert).toMatchObject({
      organization_id: "org-a",
      provider: "openai-assinatura",
      model: "gpt-A",
      credential_id: "credential-a",
    });
    expect(inserts.some(({ table }) => table === "ai_provider_credentials")).toBe(false);
  });

  it("recusa credencial/modelo fora do catálogo antes de qualquer insert", async () => {
    mocks.moduloLigado.mockResolvedValue(true);
    mocks.validarModeloDaAssinatura.mockResolvedValue({ ok: false, error: "model_not_allowed" });
    const { admin, inserts } = dbDeAssinatura();
    const result = await duplicateAgentWithVersion(admin, {
      orgId: "org-a", agentId: "agent-a", actorUserId: "user-a", requireVersion: true,
    });

    expect(result).toEqual({ ok: false, error: "model_not_allowed" });
    expect(inserts).toEqual([]);
  });
});
