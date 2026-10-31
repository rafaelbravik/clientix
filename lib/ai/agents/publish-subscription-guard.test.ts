import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), chaveDePlataforma: vi.fn() }));

vi.mock("@/lib/ai/runtime/agent", () => ({ chaveDePlataforma: mocks.chaveDePlataforma }));

import { publishAgentVersion } from "./publish";

describe("publicação de openai-assinatura antes da governança de schema", () => {
  it("recusa o provider sem chamar fn_publish_ai_agent_version", async () => {
    const query: Record<string, unknown> = {};
    const builder = {
      select: () => builder,
      eq: (column: string, value: unknown) => { query[column] = value; return builder; },
      maybeSingle: async () => ({ data: { provider: "openai-assinatura", credential_id: "cred-a" }, error: null }),
    };
    const admin = {
      from: (table: string) => {
        expect(table).toBe("ai_agent_versions");
        return builder;
      },
      rpc: mocks.rpc,
    } as never;

    const result = await publishAgentVersion(admin, {
      orgId: "org-a", agentId: "agent-a", versionId: "version-a",
    });

    expect(result).toMatchObject({ ok: false, code: "provider_not_publishable" });
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect(query).toMatchObject({ organization_id: "org-a", agent_id: "agent-a", id: "version-a" });
  });
});
