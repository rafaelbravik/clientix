import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/mcp/audit", () => ({
  auditMcpToolCall: vi.fn().mockResolvedValue(undefined),
}));

import { pickToolsFromMcp } from "./tools";

const ORG = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const CONTACT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOOL_ID = "crm_get_prospecting_site_audit";

function query(result: unknown) {
  const q: Record<string, unknown> = {};
  for (const method of ["select", "eq", "is", "order", "limit"]) {
    q[method] = vi.fn(() => q);
  }
  q.maybeSingle = vi.fn(async () => ({ data: result, error: null }));
  q.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve({ data: result, error: null }).then(resolve, reject);
  return q;
}

describe("agent runtime prospecting audit MCP tool", () => {
  beforeEach(() => vi.clearAllMocks());

  it("the real runtime bridge invokes the audit with the authenticated turn contact", async () => {
    const contactQuery = query({
      is_anonymized: false,
      is_blocked: false,
      is_merged_into: null,
      consent: {},
    });
    const candidateQuery = query([
      {
        updated_at: "2026-10-31T12:00:00.000Z",
        data: {
          website: "https://business.example.test/",
          site: {
            ver: 1,
            classe: "site-ok",
            status: "checked",
            provisorio: false,
            citavel: true,
            verificado_em: "2026-10-31T12:00:00.000Z",
            url: "https://business.example.test/",
            facts: {
              trust: "UNTRUSTED_EXTERNAL_CONTENT",
              title: "FATO EXTERNO",
              description: null,
              headings: [],
              visible_text_length: 120,
            },
          },
        },
      },
    ]);
    const supabase = {
      from: vi.fn((table: string) =>
        table === "contacts" ? contactQuery : table === "prospecting_candidates" ? candidateQuery : query(null),
      ),
    };
    const actor = { type: "ai_agent" as const, id: "synthetic-agent", api_token_id: "ephemeral" };
    const ctx = {
      organizationId: ORG,
      role: "ai_operator" as const,
      actor,
      apiTokenId: "ephemeral",
      requestId: "synthetic-turn",
      supabase,
    };
    const runtimeTools = pickToolsFromMcp({
      supabase: supabase as never,
      ctx: ctx as never,
      auth: { organizationId: ORG, role: "ai_operator", actor, apiTokenId: "ephemeral", scopes: ["mcp:read"] } as never,
      toolIds: [TOOL_ID],
      handoffToolEnabled: false,
      handoffSignal: { triggered: false },
      contatoDoTurno: CONTACT,
      modulosLigados: [],
      capacidadesLigadas: [],
    });

    const result = await runtimeTools[TOOL_ID]!.execute!({}, {
      toolCallId: "synthetic-tool-call",
      messages: [],
      context: undefined,
    });

    expect(result).toMatchObject({
      disponivel: true,
      auditoria: {
        classe: "site-ok",
        citabilidade: "definitiva",
        fatos_citaveis: { titulo: "FATO EXTERNO", trust: "UNTRUSTED_EXTERNAL_CONTENT" },
      },
    });
    expect(supabase.from).toHaveBeenNthCalledWith(1, "contacts");
    expect(supabase.from).toHaveBeenNthCalledWith(2, "prospecting_candidates");
    expect(contactQuery.eq).toHaveBeenCalledWith("organization_id", ORG);
    expect(contactQuery.eq).toHaveBeenCalledWith("id", CONTACT);
    expect(candidateQuery.eq).toHaveBeenCalledWith("organization_id", ORG);
    expect(candidateQuery.eq).toHaveBeenCalledWith("contact_id", CONTACT);
  });
});
