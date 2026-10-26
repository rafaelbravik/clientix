import { afterEach, describe, expect, it, vi } from "vitest";
import { WahaClient } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cliente WAHA para histórico", () => {
  it("não segue redirect do endpoint de histórico", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("login", {
      status: 302,
      headers: { location: "/login", "content-type": "text/html" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WahaClient("http://waha.local", "test-key");
    await expect(client.listarChatsHistorico("sess", { limit: 5, offset: 0 })).rejects.toThrow("waha_history_302");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("recusa login HTML com 200 e JSON malformado", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("<html>login</html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new WahaClient("http://waha.local", "test-key");
    await expect(client.listarChatsHistorico("sess", { limit: 5, offset: 0 }))
      .rejects.toThrow("waha_history_malformed_response");
  });

  it("aceita JSON válido do endpoint, inclusive sem content-type", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => [{ id: "5511999999999@c.us" }],
    } as unknown as Response));
    const client = new WahaClient("http://waha.local", "test-key");
    await expect(client.listarChatsHistorico("sess", { limit: 5, offset: 0 }))
      .resolves.toMatchObject({ items: [{ id: "5511999999999@c.us" }], hasMore: false });
  });

  it("distingue LID desconhecido de indisponibilidade do provedor", async () => {
    const client = new WahaClient("http://waha.local", "test-key");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 404 })));
    await expect(client.resolvePhoneForLid("sess", "123", { falhaLanca: true })).resolves.toBeNull();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{}", { status: 503 })));
    await expect(client.resolvePhoneForLid("sess", "123", { falhaLanca: true })).rejects.toThrow("waha_lid_503");
  });

  it("descarta host e query do caminho de mídia e recusa path externo", () => {
    const client = new WahaClient("http://waha.local:3030", "test-key");
    expect(client.urlMidiaHistorica("https://evil.invalid/api/files/item.jpg?token=secret"))
      .toBe("http://waha.local:3030/api/files/item.jpg");
    expect(() => client.urlMidiaHistorica("https://evil.invalid/login"))
      .toThrow("waha_history_media_url_invalid");
  });
});
