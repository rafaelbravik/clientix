import { beforeEach, describe, expect, it, vi } from "vitest";

const { beginServiceAtOrigin, sendMessageHandler, recordSend, getRequestPool } = vi.hoisted(() => ({
  beginServiceAtOrigin: vi.fn(),
  sendMessageHandler: vi.fn(),
  recordSend: vi.fn(),
  getRequestPool: vi.fn(),
}));

vi.mock("@/lib/atendimento/origem", () => ({ beginServiceAtOrigin }));
vi.mock("@/app/api/v1/messages/_handler", () => ({ sendMessageHandler }));
vi.mock("@/lib/agent-engine/pacing/store", () => ({ recordSend }));
vi.mock("@/lib/agent-engine/db/request-pool", () => ({ getRequestPool }));
vi.mock("./elegibilidade", () => ({
  baseLegalValida: () => true,
  motivoParaExcluir: () => null,
  recusouMarketing: () => false,
}));
vi.mock("./renderizador", () => ({
  renderizar: (body: string) => ({ texto: body, faltando: [] }),
}));

import { duplicarAcao, testarAcao, type CampanhaCarregada } from "./acoes";

const campaign: CampanhaCarregada = {
  id: "campaign-qa",
  organization_id: "org-qa",
  name: "QA — campaign",
  status: "draft",
  channel: "whatsapp",
  channel_session_id: "session-qa",
  message_body: "Primeiro parágrafo\n\nSegundo parágrafo",
  split_messages: true,
  base_legal: "consent",
  lia_ref: null,
  audience_filter: {},
  audience_version: 1,
  content_version: 1,
  scheduled_at: null,
  intervalo_segundos: null,
  janela_inicio_hora: null,
  janela_fim_hora: null,
  teto_diario: null,
  teto_horario: null,
  description: null,
};

function fakeAdmin() {
  let table = "";
  let insert: Record<string, unknown> | null = null;
  const contact = {
    id: "contact-qa",
    name: "QA",
    display_name: "QA",
    phone_number: "+10000000000",
    is_blocked: false,
    is_anonymized: false,
    consent: {},
  };
  const builder: Record<string, unknown> = {
    from: (name: string) => {
      table = name;
      return builder;
    },
    insert: (row: Record<string, unknown>) => {
      insert = row;
      return builder;
    },
    select: () => builder,
    eq: () => builder,
    maybeSingle: async () => ({ data: table === "contacts" ? contact : null, error: null }),
    single: async () => ({ data: { id: "copy-qa" }, error: null }),
  };
  return { admin: builder as never, getInserted: () => insert };
}

beforeEach(() => {
  vi.clearAllMocks();
  beginServiceAtOrigin.mockResolvedValue({ conversation_id: "conversation-qa" });
  getRequestPool.mockReturnValue({});
  sendMessageHandler.mockImplementation(async (_admin, _context, input) => ({
    id: `message-${String(input.body)}`,
    status: "sent",
  }));
});

describe("ações de campanha com divisão em balões", () => {
  it("preserva a opção ao duplicar a campanha", async () => {
    const fake = fakeAdmin();
    const result = await duplicarAcao(fake.admin, campaign, "user-qa");

    expect(result).toEqual({ ok: true, id: "copy-qa" });
    expect(fake.getInserted()).toMatchObject({ split_messages: true });
  });

  it("envia o teste em ordem, com pacing entre balões e identidade por posição", async () => {
    const fake = fakeAdmin();
    const result = await testarAcao(
      fake.admin,
      campaign,
      "contact-qa",
      new Date("2026-10-28T12:00:00.000Z"),
      "UTC",
      { throttleMs: 0, jitterMaxMs: 0, minIntervalMs: 0 },
    );

    expect(result).toEqual({ ok: true, status: "sent" });
    expect(sendMessageHandler).toHaveBeenCalledTimes(2);
    expect(sendMessageHandler.mock.calls.map((call) => call[2].body)).toEqual([
      "Primeiro parágrafo",
      "Segundo parágrafo",
    ]);
    expect(sendMessageHandler.mock.calls[0]?.[1].internalMessageId).not.toBe(
      sendMessageHandler.mock.calls[1]?.[1].internalMessageId,
    );
    expect(recordSend).toHaveBeenCalledTimes(2);
  });

  it("não envia balões posteriores depois de uma falha parcial do teste", async () => {
    const fake = fakeAdmin();
    sendMessageHandler
      .mockResolvedValueOnce({ id: "message-1", status: "sent" })
      .mockResolvedValueOnce({ id: "message-2", status: "failed" });

    const result = await testarAcao(
      fake.admin,
      campaign,
      "contact-qa",
      new Date("2026-10-28T12:00:00.000Z"),
      "UTC",
      { throttleMs: 0, jitterMaxMs: 0, minIntervalMs: 0 },
    );

    expect(result).toMatchObject({ ok: false, status: 409 });
    expect(sendMessageHandler).toHaveBeenCalledTimes(2);
  });
});
