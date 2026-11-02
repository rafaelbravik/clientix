import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

/** Limite agregado de itens/atributos por chamada de ferramenta MCP. */
export const LIMITE_ELEMENTOS_INPUT_MCP = 1_000;

/** Mantém o corpo HTTP MCP abaixo do teto padrão de 4 MiB do SDK. */
export const LIMITE_CORPO_MCP_BYTES = 1_048_576;

export function criarTransporteHttpMcp(): WebStandardStreamableHTTPServerTransport {
  return new WebStandardStreamableHTTPServerTransport({
    maxRequestBodySize: LIMITE_CORPO_MCP_BYTES,
  });
}
