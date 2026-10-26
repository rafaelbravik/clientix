/** Limites e validação dos anexos privados de campos file do CRM. */

export const LEAD_ATTACHMENT_MAX_BYTES = 5 * 1024 * 1024;
export const LEAD_ATTACHMENT_MAX_FILES = 10;
export const LEAD_ATTACHMENT_MIME_TYPES = [
  "application/pdf",
  "image/png",
  "image/jpeg",
  "image/webp",
] as const;

export type LeadAttachmentMime = (typeof LEAD_ATTACHMENT_MIME_TYPES)[number];

const EXTENSOES: Record<LeadAttachmentMime, readonly string[]> = {
  "application/pdf": ["pdf"],
  "image/png": ["png"],
  "image/jpeg": ["jpg", "jpeg"],
  "image/webp": ["webp"],
};

export interface LeadAttachmentFileInput {
  name: string;
  type: string;
  size: number;
  bytes: Uint8Array;
}

export type LeadAttachmentValidation =
  | {
      ok: true;
      mimeType: LeadAttachmentMime;
      extension: string;
      filename: string;
      bytes: Uint8Array;
    }
  | {
      ok: false;
      code: "payload_too_large" | "unsupported_media_type" | "validation_failed";
      reason: "empty" | "size" | "mime" | "extension" | "signature" | "length";
    };

/** Remove caminhos, controles e bidi; preserva letras Unicode legíveis. */
export function sanitizeLeadAttachmentFilename(raw: string): string {
  const normalized = raw.normalize("NFKC").replace(/\\/g, "/");
  const basename = normalized.split("/").at(-1) ?? "";
  const safe = basename
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, "_")
    .replace(/[<>:"|?*]/g, "_")
    .replace(/[. ]+$/g, "")
    .trim()
    .slice(0, 180);
  return safe || "arquivo";
}

function detectMime(bytes: Uint8Array): LeadAttachmentMime | null {
  // A signature buried in an HTML/polyglot prefix is not a PDF. Keep the
  // sniff strict; inline delivery is sandboxed, but the boundary must still
  // reject content whose first bytes identify another format.
  if (bytes.length >= 5 && new TextDecoder().decode(bytes.subarray(0, 5)) === "%PDF-") {
    return "application/pdf";
  }
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return "image/jpeg";
  }
  if (
    bytes.length >= 12 &&
    String.fromCharCode(...bytes.subarray(0, 4)) === "RIFF" &&
    String.fromCharCode(...bytes.subarray(8, 12)) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Confere bytes, MIME e extensão juntos. O tipo reportado pelo navegador nunca
 * escolhe sozinho o MIME persistido; uma divergência é recusada.
 */
export function validateLeadAttachment(input: LeadAttachmentFileInput): LeadAttachmentValidation {
  if (!Number.isInteger(input.size) || input.size <= 0 || input.bytes.length === 0) {
    return { ok: false, code: "validation_failed", reason: "empty" };
  }
  if (input.size > LEAD_ATTACHMENT_MAX_BYTES) {
    return { ok: false, code: "payload_too_large", reason: "size" };
  }
  if (input.bytes.length !== input.size) {
    return { ok: false, code: "validation_failed", reason: "length" };
  }

  const detected = detectMime(input.bytes);
  if (!detected) return { ok: false, code: "unsupported_media_type", reason: "signature" };
  if (input.type.trim().toLowerCase() !== detected) {
    return { ok: false, code: "unsupported_media_type", reason: "mime" };
  }

  const extension = input.name.split(/[./\\]/).at(-1)?.toLowerCase() ?? "";
  if (!EXTENSOES[detected].includes(extension)) {
    return { ok: false, code: "unsupported_media_type", reason: "extension" };
  }

  return {
    ok: true,
    mimeType: detected,
    extension: EXTENSOES[detected][0]!,
    filename: sanitizeLeadAttachmentFilename(input.name),
    bytes: input.bytes,
  };
}

/** Chave de Storage exata; o cliente nunca fornece nenhum dos segmentos. */
export function leadAttachmentStoragePath(
  organizationId: string,
  leadId: string,
  attachmentId: string,
  extension: string,
): string {
  if (![organizationId, leadId, attachmentId].every((value) => /^[0-9a-f-]{36}$/i.test(value))) {
    throw new Error("Identificador inválido para caminho de anexo.");
  }
  if (!(["pdf", "png", "jpg", "webp"] as const).includes(extension as "pdf" | "png" | "jpg" | "webp")) {
    throw new Error("Extensão inválida para caminho de anexo.");
  }
  return `${organizationId}/lead-attachments/${leadId}/${attachmentId}.${extension}`;
}

/** Validador da fronteira DB → Storage → API (sem aceitar sufixos extras). */
export function isLeadAttachmentPathOwnedBy(
  path: string,
  organizationId: string,
  leadId: string,
  attachmentId: string,
): boolean {
  if (path.includes("\\")) return false;
  const prefix = `${organizationId}/lead-attachments/${leadId}/${attachmentId}.`;
  if (!path.startsWith(prefix)) return false;
  const extension = path.slice(prefix.length);
  return EXTENSOES["application/pdf"].includes(extension) ||
    EXTENSOES["image/png"].includes(extension) ||
    EXTENSOES["image/jpeg"].includes(extension) ||
    EXTENSOES["image/webp"].includes(extension);
}
