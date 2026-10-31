import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  chaveDePlataforma: vi.fn(),
  moduloLigado: vi.fn(),
}));

vi.mock("@/lib/ai/runtime/agent", () => ({ chaveDePlataforma: mocks.chaveDePlataforma }));
vi.mock("@/lib/instalacao/modulos", () => ({ moduloLigado: mocks.moduloLigado }));

import { CHATGPT_SUBSCRIPTION_MODULE } from "@/lib/ai/credenciais/chatgpt-subscription-constants";
import { publishAgentVersion } from "./publish";

function adminDeVersao(provider: string, credentialId: string | null = "cred-a") {
  const query: Record<string, unknown> = {};
  const builder = {
    select: () => builder,
    eq: (column: string, value: unknown) => {
      query[column] = value;
      return builder;
    },
    maybeSingle: async () => ({ data: { provider, credential_id: credentialId }, error: null }),
  };
  return {
    admin: {
      from: (table: string) => {
        expect(table).toBe("ai_agent_versions");
        return builder;
      },
      rpc: mocks.rpc,
    } as never,
    query,
  };
}

describe("publicação de openai-assinatura", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.chaveDePlataforma.mockReturnValue(false);
  });

  it("login_codex desligado bloqueia antes de chamar fn_publish_ai_agent_version", async () => {
    mocks.moduloLigado.mockResolvedValue(false);
    const { admin, query } = adminDeVersao("openai-assinatura");

    const result = await publishAgentVersion(admin, {
      orgId: "org-a", agentId: "agent-a", versionId: "version-a",
    });

    expect(result).toMatchObject({ ok: false, code: "feature_disabled" });
    expect(mocks.moduloLigado).toHaveBeenCalledWith(admin, CHATGPT_SUBSCRIPTION_MODULE);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(query).toMatchObject({ organization_id: "org-a", agent_id: "agent-a", id: "version-a" });
  });

  it("login_codex ligado encaminha a publicação à RPC canônica", async () => {
    mocks.moduloLigado.mockResolvedValue(true);
    mocks.rpc.mockResolvedValue({
      data: [{
        agent_id: "agent-a",
        version_id: "version-a",
        previous_version_id: null,
        published_at: "2026-10-31T12:00:00.000Z",
      }],
      error: null,
    });
    const { admin } = adminDeVersao("openai-assinatura");

    const result = await publishAgentVersion(admin, {
      orgId: "org-a", agentId: "agent-a", versionId: "version-a",
    });

    expect(result).toMatchObject({ ok: true, agent_id: "agent-a", version_id: "version-a" });
    expect(mocks.rpc).toHaveBeenCalledWith("fn_publish_ai_agent_version", expect.objectContaining({
      p_org_id: "org-a",
      p_agent_id: "agent-a",
      p_version_id: "version-a",
    }));
  });

  it("não consulta login_codex nem altera a publicação de outro provider", async () => {
    mocks.rpc.mockResolvedValue({
      data: [{
        agent_id: "agent-a",
        version_id: "version-a",
        previous_version_id: null,
        published_at: "2026-10-31T12:00:00.000Z",
      }],
      error: null,
    });
    const { admin } = adminDeVersao("openai");

    const result = await publishAgentVersion(admin, {
      orgId: "org-a", agentId: "agent-a", versionId: "version-a",
    });

    expect(result).toMatchObject({ ok: true });
    expect(mocks.moduloLigado).not.toHaveBeenCalled();
    expect(mocks.rpc).toHaveBeenCalledOnce();
  });
});
