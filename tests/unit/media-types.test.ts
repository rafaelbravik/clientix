import { describe, expect, it } from "vitest";

import {
  extFromMime,
  mimeRealDoBuffer,
  storagePathFor,
  MAX_MEDIA_BYTES,
} from "@/lib/messaging/media/types";

describe("extFromMime", () => {
  it("mapeia mimes comuns do WhatsApp", () => {
    expect(extFromMime("image/jpeg")).toBe("jpg");
    expect(extFromMime("image/png")).toBe("png");
    expect(extFromMime("image/webp")).toBe("webp"); // figurinhas
    expect(extFromMime("video/mp4")).toBe("mp4");
    expect(extFromMime("application/mp4")).toBe("mp4"); // mime real observado no WAHA 2026.7.1
    expect(extFromMime("audio/ogg; codecs=opus")).toBe("ogg"); // PTT
    expect(extFromMime("audio/mpeg")).toBe("mp3");
    expect(extFromMime("application/pdf")).toBe("pdf");
    expect(extFromMime("application/vnd.openxmlformats-officedocument.wordprocessingml.document")).toBe("docx");
    expect(extFromMime("text/csv")).toBe("csv");
    expect(extFromMime("application/zip")).toBe("zip");
    expect(extFromMime("audio/webm")).toBe("webm");
  });
  it("cai em bin para mime desconhecido", () => {
    expect(extFromMime("application/x-unknown")).toBe("bin");
    expect(extFromMime("")).toBe("bin");
  });
});

describe("storagePathFor", () => {
  it("monta o path canônico org/conversa/mensagem.ext", () => {
    expect(storagePathFor("org1", "conv2", "msg3", "image/jpeg")).toBe("org1/conv2/msg3.jpg");
  });
});

describe("MAX_MEDIA_BYTES", () => {
  it("é 50MB", () => {
    expect(MAX_MEDIA_BYTES).toBe(52_428_800);
  });
});

describe("mimeRealDoBuffer", () => {
  it("confere assinatura real e recusa MIME incompatível", () => {
    expect(mimeRealDoBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg")).toBe("image/jpeg");
    expect(mimeRealDoBuffer(Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "text/html")).toBeNull();
    expect(mimeRealDoBuffer(Buffer.from("login_required"), "image/jpeg")).toBeNull();
  });

  it("reconhece documentos OpenXML pelo nome das entradas ZIP", () => {
    const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("word/document.xml")]);
    const xlsx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from("xl/workbook.xml")]);
    expect(mimeRealDoBuffer(docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document"))
      .toBe("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
    expect(mimeRealDoBuffer(xlsx, "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"))
      .toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  });
});
