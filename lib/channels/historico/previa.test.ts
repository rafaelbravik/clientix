import { describe, expect, it, vi } from "vitest";
import type { WahaPayload } from "@/lib/waha/envelope";
import { calcularPreviaHistorico } from "./previa";

const now = Date.parse("2026-10-25T12:00:00.000Z");
const payload = (id: string, overrides: Partial<WahaPayload> = {}) => ({
  id, fromMe: false, timestamp: Math.floor(now / 1000), type: "chat", body: "fixture",
  ...overrides,
}) as WahaPayload;

describe("prévia limitada do histórico", () => {
  it("conta apenas chats diretos e mensagens no período, preservando tipos de mídia", async () => {
    const listarChatsHistorico = vi.fn().mockResolvedValue({
      items: [{ id: "5511999999999@c.us" }, { id: "123@g.us" }], hasMore: false,
    });
    const listarMensagensHistorico = vi.fn().mockResolvedValue({
      items: [
        payload("a", { type: "image", hasMedia: true }),
        payload("b", { type: "audio", hasMedia: true }),
        payload("c", { type: "reaction" }),
        payload("old", { timestamp: Math.floor((now - 120 * 86_400_000) / 1000) }),
      ], hasMore: false,
    });
    const result = await calcularPreviaHistorico({ listarChatsHistorico, listarMensagensHistorico }, "s", 90, { now });
    expect(result).toMatchObject({ conversations: 1, messages: 3, audios: 1, images: 1, partial: false });
    expect(listarMensagensHistorico).toHaveBeenCalledTimes(1);
  });

  it("marca a estimativa parcial quando um chat excede o teto de importação", async () => {
    const listarChatsHistorico = vi.fn().mockResolvedValue({ items: [{ id: "5511999999999@c.us" }], hasMore: false });
    const items = Array.from({ length: 100 }, (_, i) => payload(`m${i}`));
    const listarMensagensHistorico = vi.fn()
      .mockResolvedValueOnce({ items, hasMore: true })
      .mockResolvedValueOnce({ items: [payload("m100")], hasMore: false });
    const result = await calcularPreviaHistorico({ listarChatsHistorico, listarMensagensHistorico }, "s", 90, { now });
    expect(result).toMatchObject({ conversations: 1, messages: 101, partial: true });
  });

  it("não excede o teto de chamadas e declara a prévia parcial", async () => {
    const listarChatsHistorico = vi.fn().mockResolvedValue({
      items: Array.from({ length: 50 }, (_, i) => ({ id: `${5511999990000 + i}@c.us` })), hasMore: true,
    });
    const listarMensagensHistorico = vi.fn();
    const result = await calcularPreviaHistorico({ listarChatsHistorico, listarMensagensHistorico }, "s", 90, { now, maxCalls: 2 });
    expect(listarChatsHistorico).toHaveBeenCalledTimes(2);
    expect(listarMensagensHistorico).not.toHaveBeenCalled();
    expect(result.partial).toBe(true);
  });
});
