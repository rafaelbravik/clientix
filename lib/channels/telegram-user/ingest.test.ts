import { describe, expect, it, vi } from "vitest";

const { marcarConversa, aplicarEfeitos } = vi.hoisted(() => ({
  marcarConversa: vi.fn(),
  aplicarEfeitos: vi.fn(),
}));

vi.mock("../marcar-conversa", () => ({ marcarConversaComMensagem: marcarConversa }));
vi.mock("../pos-entrada", () => ({ aplicarEfeitosPosEntrada: aplicarEfeitos }));

import { ingestTelegramUserInbound } from "./ingest";

function adminMock() {
  const inserts: Array<{ table: string; row: Record<string, unknown> }> = [];
  type Query = {
    select: (columns?: string) => Query;
    eq: (column: string, value: unknown) => Query;
    is: (column: string, value: unknown) => Query;
    order: (column: string, options?: unknown) => Query;
    limit: (count: number) => Query;
    insert: (row: Record<string, unknown>) => Query;
    single: () => Promise<{ data: { id: string }; error: null }>;
    maybeSingle: () => Promise<{ data: { id: string } | null; error: null }>;
  };
  const admin = {
    from(table: string) {
      let inserted = false;
      const query: Query = {
        select: vi.fn(() => query),
        eq: vi.fn(() => query),
        is: vi.fn(() => query),
        order: vi.fn(() => query),
        limit: vi.fn(() => query),
        insert: vi.fn((row) => {
          inserted = true;
          inserts.push({ table, row });
          return query;
        }),
        single: vi.fn(async () => ({
          data: { id: table === "contacts" ? "contact-test" : "conversation-test" },
          error: null,
        })),
        maybeSingle: vi.fn(async () => ({
          data: inserted ? { id: "message-test" } : null,
          error: null,
        })),
      };
      return query;
    },
    rpc: vi.fn(),
  };
  return { admin, inserts };
}

describe("ingestTelegramUserInbound", () => {
  it("usa o tipo de contato e os campos aceitos pelo esquema de contacts", async () => {
    const { admin, inserts } = adminMock();

    const result = await ingestTelegramUserInbound(admin as never, {
      organizationId: "00000000-0000-4000-8000-000000000001",
      channelSessionId: "00000000-0000-4000-8000-000000000002",
      payload: {
        message_id: "message-test",
        date: 1_795_680_000,
        is_private: true,
        from: { id: "telegram-user-test", first_name: "Contato", phone: null },
        peer_id: "telegram-user-test",
        text: "mensagem de teste",
      },
    });

    const contactInsert = inserts.find((insert) => insert.table === "contacts")?.row;
    expect(result.status).toBe("ingested");
    expect(contactInsert).toHaveProperty("kind", "person");
    expect(contactInsert).toHaveProperty("phone_number", null);
    expect(contactInsert).not.toHaveProperty("phone");
  });
});
