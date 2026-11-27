import { describe, expect, it, vi } from "vitest";

import { telegramUserGetOutboxReadStates } from "./client";

describe("consulta de leitura de saída do Telegram", () => {
  it("consulta peers privados em lote e retorna o limite de leitura", async () => {
    const invoke = vi.fn().mockResolvedValue({
      dialogs: [
        {
          className: "Dialog",
          peer: { className: "PeerUser", userId: 123 },
          readOutboxMaxId: 179,
        },
        {
          className: "Dialog",
          peer: { className: "PeerUser", userId: 456 },
          readOutboxMaxId: 0,
        },
        {
          className: "Dialog",
          peer: { className: "PeerChat", chatId: 789 },
          readOutboxMaxId: 50,
        },
      ],
    });

    const result = await telegramUserGetOutboxReadStates({ invoke } as never, [
      "tgu:123:456",
      "tgu:456:-789",
    ]);

    expect(result).toEqual([
      { peerId: "123", maxId: 179 },
      { peerId: "456", maxId: 0 },
    ]);
    expect(invoke).toHaveBeenCalledOnce();
    expect(invoke.mock.calls[0]?.[0]).toMatchObject({
      className: "messages.GetPeerDialogs",
      peers: [
        {
          className: "InputDialogPeer",
          peer: { className: "InputPeerUser" },
        },
        {
          className: "InputDialogPeer",
          peer: { className: "InputPeerUser" },
        },
      ],
    });
  });
});
