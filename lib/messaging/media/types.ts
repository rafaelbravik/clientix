/**
 * Tipos canônicos de mídia do messaging — camada provider-agnóstica.
 * Hoje só o WAHA produz mídia; a Meta Cloud API (futura) implementa a mesma
 * interface de fetch e o resto do sistema não muda (spec Onda 0).
 */

export const MAX_MEDIA_BYTES = 52_428_800; // 50MB — espelha file_size_limit do bucket

export interface FetchedMedia {
  buffer: Buffer;
  mime: string;
}

export class MediaTooLargeError extends Error {
  constructor() {
    super(`media exceeds ${MAX_MEDIA_BYTES} bytes`);
    this.name = "MediaTooLargeError";
  }
}

const MIME_EXT: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "application/mp4": "mp4", // WAHA/NOWEB anuncia vídeo do WhatsApp com esse mime
  "video/3gpp": "3gp",
  "video/webm": "webm",
  "audio/ogg": "ogg",
  "audio/mpeg": "mp3",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/amr": "amr",
  "audio/webm": "webm",
  "audio/wav": "wav",
  "application/pdf": "pdf",
  "application/msword": "doc",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.ms-excel": "xls",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/csv": "csv",
  "application/zip": "zip",
};

export function extFromMime(mime: string): string {
  const base = (mime ?? "").split(";")[0]!.trim().toLowerCase();
  return MIME_EXT[base] ?? "bin";
}

/** Path canônico no bucket whatsapp-media: {org}/{conversa}/{mensagem}.{ext} */
export function storagePathFor(
  orgId: string,
  conversationId: string,
  messageId: string,
  mime: string,
): string {
  return `${orgId}/${conversationId}/${messageId}.${extFromMime(mime)}`;
}

/**
 * Identifica formatos comuns pelo conteúdo. O MIME anunciado pelo provedor é
 * só uma dica: importação histórica não grava anexo quando o conteúdo não
 * confirma um tipo permitido.
 */
export function mimeRealDoBuffer(buffer: Buffer, anunciado: string | null | undefined): string | null {
  if (buffer.length === 0) return null;
  const mime = (anunciado ?? "").split(";")[0]?.trim().toLowerCase() ?? "";
  const ascii = (start: number, length: number) => buffer.subarray(start, start + length).toString("ascii");
  let detectado: string | null = null;
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) detectado = "image/jpeg";
  else if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) detectado = "image/png";
  else if (["GIF87a", "GIF89a"].includes(ascii(0, 6))) detectado = "image/gif";
  else if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") detectado = "image/webp";
  else if (ascii(4, 4) === "ftyp") {
    const brand = ascii(8, 4).toLowerCase();
    detectado = ["avif", "avis"].includes(brand)
      ? "image/avif"
      : brand.startsWith("3gp") ? "video/3gpp" : "video/mp4";
  } else if (ascii(0, 4) === "OggS") detectado = "audio/ogg";
  else if (ascii(0, 4) === "%PDF") detectado = "application/pdf";
  else if (ascii(0, 4) === "PK\u0003\u0004") {
    const zipHeaders = buffer.toString("latin1");
    detectado = zipHeaders.includes("word/")
      ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      : zipHeaders.includes("xl/")
        ? "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
        : zipHeaders.includes("ppt/")
          ? "application/vnd.openxmlformats-officedocument.presentationml.presentation"
          : "application/zip";
  }
  else if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WAVE") detectado = "audio/wav";
  else if (buffer.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]))) {
    detectado = mime === "video/webm" ? "video/webm" : "audio/webm";
  }
  else if (ascii(0, 3) === "ID3" || (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1]! & 0xe0) === 0xe0)) detectado = "audio/mpeg";
  else if (isUtf8Text(buffer)) detectado = "text/plain";

  if (!detectado) return null;
  if (!mime || mime === "application/octet-stream" || mime === detectado) return detectado;
  if (detectado === "video/mp4" && mime === "application/mp4") return detectado;
  if (detectado === "text/plain" && mime === "text/csv") return mime;
  return null;
}

function isUtf8Text(buffer: Buffer): boolean {
  if (buffer.includes(0)) return false;
  const decoded = buffer.toString("utf8");
  if (Buffer.from(decoded, "utf8").compare(buffer) !== 0) return false;
  const controles = (decoded.match(/[\u0001-\u0008\u000b\u000c\u000e-\u001f\u007f]/g) ?? []).length;
  return controles / Math.max(decoded.length, 1) < 0.01;
}
