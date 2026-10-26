import { describe, expect, it } from "vitest";
import type { WahaPayload } from "@/lib/waha/envelope";
import { mapearMensagemHistorica, timestampHistorico } from "./mapear";

describe("mapeamento de mensagem histórica", () => {
  it("normaliza timestamps em segundos, milissegundos e nanossegundos", () => {
    expect(timestampHistorico(1_797_000_000)).toBe(new Date(1_797_000_000_000).toISOString());
    expect(timestampHistorico(1_797_000_000_000)).toBe(new Date(1_797_000_000_000).toISOString());
    expect(timestampHistorico(1_797_000_000_000_000_000)).toBe(new Date(1_797_000_000_000).toISOString());
    expect(timestampHistorico(Number.NaN)).toBeNull();
  });

  it("preserva direção, estado e timestamp original", () => {
    const incoming = mapearMensagemHistorica({
      id: "false_5511999999999@c.us_A1", fromMe: false, timestamp: 1_797_000_000,
      type: "chat", body: "mensagem antiga",
    } as WahaPayload);
    const outgoing = mapearMensagemHistorica({
      id: "true_5511999999999@c.us_A2", fromMe: true, timestamp: 1_797_000_001,
      type: "chat", body: "resposta antiga",
    } as WahaPayload);
    expect(incoming).toMatchObject({ direction: "inbound", status: "delivered", sentAt: new Date(1_797_000_000_000).toISOString() });
    expect(outgoing).toMatchObject({ direction: "outbound", status: "sent" });
  });

  it("não inventa o horário atual nem aceita mensagem sem identidade direcional", () => {
    expect(mapearMensagemHistorica({ id: "A1", fromMe: false, body: "sem data" } as WahaPayload)).toBeNull();
    expect(mapearMensagemHistorica({ id: "A1", timestamp: 1_797_000_000, body: "sem direção" } as WahaPayload)).toBeNull();
  });

  it("marca mídia não recuperável sem apagar a mensagem ou inventar URL", () => {
    const payload = { id: "false_5511999999999@c.us_A3", fromMe: false, timestamp: 1_797_000_000, type: "image", hasMedia: true } as WahaPayload;
    expect(mapearMensagemHistorica(payload)).toBeNull();
    expect(mapearMensagemHistorica(payload, { mediaUnavailable: true })).toMatchObject({
      mediaUrl: null,
      metadata: { history_import: true, media_status: "unavailable" },
    });
  });
});
