import { describe, expect, it } from "vitest";

import {
  isLeadAttachmentPathOwnedBy,
  leadAttachmentStoragePath,
  LEAD_ATTACHMENT_MAX_BYTES,
  sanitizeLeadAttachmentFilename,
  validateLeadAttachment,
} from "./attachment-validation";

const ORG = "11111111-1111-4111-8111-111111111111";
const LEAD = "22222222-2222-4222-8222-222222222222";
const ATTACHMENT = "33333333-3333-4333-8333-333333333333";
const PDF = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");

describe("anexo de campo file do lead", () => {
  it("aceita PDF e persiste o nome apenas como metadado sanitizado", () => {
    expect(
      validateLeadAttachment({ name: "contrato.pdf", type: "application/pdf", size: PDF.length, bytes: PDF }),
    ).toMatchObject({ ok: true, mimeType: "application/pdf", extension: "pdf", filename: "contrato.pdf" });
  });

  it("fareja PNG, JPEG e WebP pela assinatura binária", () => {
    const casos = [
      { name: "imagem.png", type: "image/png", bytes: Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]) },
      { name: "imagem.jpeg", type: "image/jpeg", bytes: Uint8Array.from([255, 216, 255, 0, 1]) },
      { name: "imagem.webp", type: "image/webp", bytes: new TextEncoder().encode("RIFF\x04\x00\x00\x00WEBP") },
    ];
    for (const c of casos) {
      expect(validateLeadAttachment({ ...c, size: c.bytes.length })).toMatchObject({ ok: true, mimeType: c.type });
    }
  });

  it("recusa HTML renomeado, MIME adulterado e assinatura ausente", () => {
    const html = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    const htmlComMarcador = new TextEncoder().encode("<!doctype html><!-- %PDF-1.7 -->");
    expect(validateLeadAttachment({ name: "a.pdf", type: "application/pdf", size: html.length, bytes: html })).toMatchObject({
      ok: false,
      code: "unsupported_media_type",
      reason: "signature",
    });
    expect(validateLeadAttachment({ name: "a.pdf", type: "application/pdf", size: htmlComMarcador.length, bytes: htmlComMarcador })).toMatchObject({
      ok: false,
      reason: "signature",
    });
    expect(validateLeadAttachment({ name: "a.png", type: "image/jpeg", size: PDF.length, bytes: PDF })).toMatchObject({
      ok: false,
      reason: "mime",
    });
    expect(validateLeadAttachment({ name: "a.txt", type: "application/pdf", size: PDF.length, bytes: PDF })).toMatchObject({
      ok: false,
      reason: "extension",
    });
  });

  it("recusa vazio, comprimento incompatível e acima do limite de 5 MiB", () => {
    expect(validateLeadAttachment({ name: "vazio.pdf", type: "application/pdf", size: 0, bytes: new Uint8Array() })).toMatchObject({
      ok: false,
      reason: "empty",
    });
    expect(validateLeadAttachment({ name: "x.pdf", type: "application/pdf", size: 9, bytes: PDF })).toMatchObject({
      ok: false,
      reason: "length",
    });
    expect(validateLeadAttachment({ name: "x.pdf", type: "application/pdf", size: LEAD_ATTACHMENT_MAX_BYTES + 1, bytes: PDF })).toMatchObject({
      ok: false,
      code: "payload_too_large",
    });
  });

  it("remove traversal/control/bidi do nome e mantém Unicode legível", () => {
    expect(sanitizeLeadAttachmentFilename("../contrato\u202e\u0000-á.pdf")).toBe("contrato__-á.pdf");
    expect(sanitizeLeadAttachmentFilename("C:\\fakepath\\laudo.pdf")).toBe("laudo.pdf");
  });

  it("gera e valida somente o caminho exato org/lead/anexo", () => {
    const path = leadAttachmentStoragePath(ORG, LEAD, ATTACHMENT, "pdf");
    expect(path).toBe(`${ORG}/lead-attachments/${LEAD}/${ATTACHMENT}.pdf`);
    expect(isLeadAttachmentPathOwnedBy(path, ORG, LEAD, ATTACHMENT)).toBe(true);
    expect(isLeadAttachmentPathOwnedBy(`${ORG}/lead-attachments/${LEAD}/../${ATTACHMENT}.pdf`, ORG, LEAD, ATTACHMENT)).toBe(false);
    expect(isLeadAttachmentPathOwnedBy(`${ORG}/lead-attachments/${LEAD}/${ATTACHMENT}.pdf/extra`, ORG, LEAD, ATTACHMENT)).toBe(false);
    expect(() => leadAttachmentStoragePath(ORG, LEAD, ATTACHMENT, "svg")).toThrow();
  });
});
