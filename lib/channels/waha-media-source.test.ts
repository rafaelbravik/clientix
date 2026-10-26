import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchWahaMedia } from "@/lib/messaging/media/waha-source";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("origem de mídia do canal QR", () => {
  it("reconstrói download somente no endpoint de arquivos e não segue redirects", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", "http://waha.local:3000");
    vi.stubEnv("WAHA_API_KEY", "local-test-key");
    const fetchMock = vi.fn().mockResolvedValue(new Response(new Uint8Array([1, 2, 3]), {
      status: 200,
      headers: { "content-type": "image/jpeg" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const media = await fetchWahaMedia("https://external.invalid/api/files/session/image.jpg?download=1");

    expect(media.buffer).toEqual(Buffer.from([1, 2, 3]));
    expect(fetchMock).toHaveBeenCalledWith("http://waha.local:3000/api/files/session/image.jpg?download=1", expect.objectContaining({
      redirect: "error",
      headers: { "X-Api-Key": "local-test-key" },
    }));
  });

  it.each([
    "http://external.invalid/api/sessions",
    "http://external.invalid/api/files/../../api/sessions",
    "http://external.invalid/api/files/%2e%2e/api/sessions",
    "http://external.invalid/api/files/%2f%2fevil.invalid/file",
  ])("recusa caminho fora da área de arquivos: %s", async (url) => {
    vi.stubEnv("WAHA_API_BASE_URL", "http://waha.local:3000");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWahaMedia(url)).rejects.toThrow("waha_media_untrusted_host");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("não segue redirect oferecido pelo endpoint de mídia", async () => {
    vi.stubEnv("WAHA_API_BASE_URL", "http://waha.local:3000");
    const fetchMock = vi.fn().mockResolvedValue(new Response("", {
      status: 302,
      headers: { location: "http://169.254.169.254/latest/meta-data" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchWahaMedia("http://waha.local:3000/api/files/session/image.jpg"))
      .rejects.toThrow("waha_media_302");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ redirect: "error" });
  });
});
