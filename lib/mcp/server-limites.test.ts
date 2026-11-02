import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createAdminClient: vi.fn(() => ({})),
  auditMcpToolCall: vi.fn(async () => undefined),
  verificarTetoMcp: vi.fn(async () => undefined),
}));

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("./audit", () => ({ auditMcpToolCall: mocks.auditMcpToolCall }));
vi.mock("./rate-limit", () => ({ verificarTetoMcp: mocks.verificarTetoMcp }));

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "./server";
import type { McpAuthResult } from "./auth";
import { LIMITE_ELEMENTOS_INPUT_MCP } from "./limites";

describe("limite de elementos nas ferramentas MCP", () => {
  afterEach(() => vi.clearAllMocks());

  it("rejeita input amplo antes de executar a ferramenta ou gerar auditoria", async () => {
    const tokenId = "11111111-1111-4111-8111-111111111111";
    const auth: McpAuthResult = {
      organizationId: "22222222-2222-4222-8222-222222222222",
      role: "admin",
      actor: { type: "api_token", id: tokenId, role: "admin" },
      apiTokenId: tokenId,
      scopes: ["mcp:write", "role:admin"],
    };
    const server = createMcpServer(auth, "test-request");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "limite-test", version: "1" });

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const resultado = await client.callTool({
        name: "crm_update_lead",
        arguments: {
          lead_id: "33333333-3333-4333-8333-333333333333",
          tags: Array.from(
            { length: LIMITE_ELEMENTOS_INPUT_MCP + 1 },
            (_, index) => `tag-${index}`,
          ),
        },
      });

      expect(resultado.isError).toBe(true);
      expect(resultado.content).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining(`maximum of ${LIMITE_ELEMENTOS_INPUT_MCP} elements`),
          }),
        ]),
      );
      expect(mocks.verificarTetoMcp).not.toHaveBeenCalled();
      expect(mocks.auditMcpToolCall).not.toHaveBeenCalled();
    } finally {
      await client.close();
      await server.close();
    }
  });
});
