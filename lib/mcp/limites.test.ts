import { describe, expect, it } from "vitest";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { criarTransporteHttpMcp, LIMITE_CORPO_MCP_BYTES } from "./limites";

describe("limites HTTP do MCP", () => {
  it("recusa corpo maior que o teto antes de interpretar JSON-RPC", async () => {
    const server = new McpServer({ name: "limite-test", version: "1" });
    const transport = criarTransporteHttpMcp();
    await server.connect(transport);

    const response = await transport.handleRequest(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: {
          accept: "application/json, text/event-stream",
          "content-type": "application/json",
        },
        body: "x".repeat(LIMITE_CORPO_MCP_BYTES + 1),
      }),
    );

    expect(response.status).toBe(413);
    await server.close();
  });
});
