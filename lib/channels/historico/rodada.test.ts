import { describe, expect, it, vi } from "vitest";
import type { WahaClient } from "@/lib/waha/client";
import type { WahaPayload } from "@/lib/waha/envelope";

vi.mock("@/lib/audit", () => ({ audit: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/env", () => ({ get env() { return {}; } }));

import { runHistoryImportTick } from "./rodada";

const JOB = {
  id: "11111111-1111-4111-8111-111111111111",
  organization_id: "22222222-2222-4222-8222-222222222222",
  channel_session_id: "33333333-3333-4333-8333-333333333333",
  range_start: "2026-01-01T00:00:00.000Z",
  cursor: { chat_offset: 0 },
  lease_token: "44444444-4444-4444-8444-444444444444",
  attempts: 0,
  imported_count: 0,
  skipped_count: 0,
  failed_count: 0,
  created_by: "55555555-5555-4555-8555-555555555555",
};

const SESSION = {
  id: JOB.channel_session_id,
  organization_id: JOB.organization_id,
  provider: "waha",
  waha_session_name: "local-session",
  status: "WORKING",
  phone_number: "+5511888888888",
  archived_at: null,
};

function payload(id = "false_5511999999999@c.us_A1", overrides: Partial<WahaPayload> = {}): WahaPayload {
  return {
    id,
    from: "5511999999999@c.us",
    to: "5511888888888@c.us",
    fromMe: false,
    timestamp: Math.floor(Date.now() / 1000) - 60,
    type: "chat",
    body: "fixture histórico",
    ...overrides,
  } as WahaPayload;
}

function makeDb(persistResult: unknown = { inserted_count: 1 }) {
  const calls: Array<{ name: string; args: unknown }> = [];
  const db = {
    rpc: vi.fn(async (name: string, args: unknown) => {
      calls.push({ name, args });
      if (name === "fn_whatsapp_history_claim") return { data: [JOB], error: null };
      if (name === "fn_whatsapp_history_persist_conversation") return { data: persistResult, error: null };
      if (name === "fn_whatsapp_history_checkpoint") {
        return { data: { ...JOB, ...(args as Record<string, unknown>), imported_count: 1, skipped_count: 0, failed_count: 0 }, error: null };
      }
      return { data: null, error: null };
    }),
    from: () => {
      const chain: Record<string, unknown> = {};
      chain.select = () => chain;
      chain.eq = () => chain;
      chain.maybeSingle = async () => ({ data: SESSION, error: null });
      return chain;
    },
  };
  return { db, calls };
}

function makeWaha(messages: WahaPayload[], options: {
  chatId?: string;
  secondRead?: WahaPayload[];
  mediaError?: Error;
  sessionStatus?: string;
} = {}) {
  let reads = 0;
  const waha = {
    getVerifiedSession: vi.fn().mockResolvedValue({ name: SESSION.waha_session_name, status: options.sessionStatus ?? "WORKING", me: { id: "5511888888888@c.us" } }),
    isHistoryStoreEnabled: vi.fn().mockReturnValue(true),
    listarChatsHistorico: vi.fn().mockResolvedValue({ items: [{ id: options.chatId ?? "5511999999999@c.us" }], hasMore: false }),
    listarMensagensHistorico: vi.fn().mockImplementation(async () => {
      reads += 1;
      return { items: reads > 1 && options.secondRead ? options.secondRead : messages, hasMore: false };
    }),
    urlMidiaHistorica: vi.fn((url: string) => url),
    obterMensagemMidiaHistorica: vi.fn().mockImplementation(async () => {
      if (options.mediaError) throw options.mediaError;
      return payload("false_5511999999999@c.us_A1", { type: "image", hasMedia: true, mediaUrl: "http://waha.local/api/files/image.jpg" });
    }),
    resolvePhoneForLid: vi.fn().mockResolvedValue(null),
  };
  return waha as unknown as WahaClient;
}

describe("rodada de importação histórica", () => {
  it("não processa a sessão quando o status real do provedor não está em WORKING", async () => {
    const { db, calls } = makeDb();
    const waha = makeWaha([payload()], { sessionStatus: "STOPPED" });

    const result = await runHistoryImportTick(db as never, waha);

    expect(result).toMatchObject({ claimed: true, result: "retry" });
    expect(waha.listarChatsHistorico).not.toHaveBeenCalled();
    expect(calls.some((call) => call.name === "fn_whatsapp_history_persist_conversation")).toBe(false);
    expect(calls.find((call) => call.name === "fn_whatsapp_history_checkpoint")?.args).toMatchObject({
      p_error_code: "history_session_not_working",
    });
  });

  it("não persiste nenhuma mensagem se a identidade da conversa diverge entre leituras", async () => {
    const { db, calls } = makeDb();
    const waha = makeWaha([payload()], { secondRead: [payload("false_5511666666666@c.us_A1", { from: "5511666666666@c.us" })] });
    const result = await runHistoryImportTick(db as never, waha);
    expect(result).toMatchObject({ claimed: true, result: "conversation_skipped" });
    expect(calls.some((call) => call.name === "fn_whatsapp_history_persist_conversation")).toBe(false);
    expect(calls.find((call) => call.name === "fn_whatsapp_history_checkpoint")?.args).toMatchObject({ p_skipped: 1 });
  });

  it("persiste mídia que o endpoint histórico não oferece como indisponível, sem perder a mensagem", async () => {
    const { db, calls } = makeDb();
    const waha = makeWaha([payload("false_5511999999999@c.us_A1", { type: "image", hasMedia: true })], {
      mediaError: new Error("waha_history_404"),
    });
    const result = await runHistoryImportTick(db as never, waha);
    expect(result).toMatchObject({ claimed: true, result: "conversation_imported" });
    const persisted = calls.find((call) => call.name === "fn_whatsapp_history_persist_conversation");
    const args = persisted?.args as { p_messages: Array<Record<string, unknown>> };
    expect(args.p_messages).toHaveLength(1);
    expect(args.p_messages[0]).toMatchObject({ media_url: null, metadata: { media_status: "unavailable" } });
  });

  it("não trata erro de transporte ao resolver LID como identidade sem telefone", async () => {
    const { db, calls } = makeDb();
    const message = payload("false_123456789@lid_A1", {
      from: "123456789@lid",
      to: "5511888888888@c.us",
      _data: { key: { remoteJid: "123456789@lid" } },
    });
    const waha = makeWaha([message], { chatId: "123456789@lid" });
    vi.mocked(waha.resolvePhoneForLid).mockRejectedValue(new Error("waha_timeout"));
    const result = await runHistoryImportTick(db as never, waha);
    expect(result).toMatchObject({ claimed: true, result: "retry" });
    expect(calls.some((call) => call.name === "fn_whatsapp_history_persist_conversation")).toBe(false);
  });
});
