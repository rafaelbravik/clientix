import { describe, expect, it } from "vitest";
import {
  instagramMessageType,
  normalizeInstagramAttachments,
} from "@/lib/channels/instagram/media";

describe("mídia inbound do Instagram", () => {
  it("preserva tipo, id, URL HTTPS, MIME, nome e caption sem guardar credenciais", () => {
    const attachments = normalizeInstagramAttachments({
      mid: "mid-1",
      text: "olhe",
      attachments: [
        {
          type: "image",
          payload: {
            id: "media-1",
            url: "https://cdn.example.test/image.jpg",
            mime_type: "image/jpeg",
            filename: "produto.jpg",
            caption: "foto",
          },
        },
      ],
    });

    expect(attachments).toEqual([
      {
        id: "media-1",
        type: "image",
        url: "https://cdn.example.test/image.jpg",
        mime_type: "image/jpeg",
        filename: "produto.jpg",
        caption: "foto",
      },
    ]);
  });

  it("recusa mídia HTTP e URLs com token/assinatura na query", () => {
    const attachments = normalizeInstagramAttachments({
      mid: "mid-2",
      attachments: [
        { type: "video", payload: { url: "http://cdn.example.test/video.mp4" } },
        { type: "file", payload: { url: "https://cdn.example.test/file?access_token=private" } },
        { type: "audio", payload: { url: "https://cdn.example.test/audio?signature=private" } },
      ],
    });

    expect(attachments.map((item) => item.url)).toEqual([null, null, null]);
    expect(JSON.stringify(attachments)).not.toContain("private");
  });

  it("normaliza os tipos para o CHECK existente de messages.type", () => {
    const [file, share] = normalizeInstagramAttachments({
      mid: "mid-3",
      attachments: [
        { type: "file", payload: {} },
        { type: "share", payload: {} },
      ],
    });

    expect(instagramMessageType(file ?? null)).toBe("document");
    expect(instagramMessageType(share ?? null)).toBe("text");
    expect(instagramMessageType(null)).toBe("text");
  });
});
