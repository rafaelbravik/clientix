import type { InstagramWebhookMessagingEvent } from "./types";

export interface InstagramInboundAttachment {
  id: string | null;
  type: "image" | "audio" | "video" | "file" | "share";
  url: string | null;
  mime_type: string | null;
  filename: string | null;
  caption: string | null;
}

const MIME_BY_TYPE = {
  image: "image/*",
  video: "video/*",
  audio: "audio/*",
  file: "application/octet-stream",
  share: "text/uri-list",
} as const;

function safeProviderMediaUrl(rawUrl: string | undefined): string | null {
  if (!rawUrl) return null;
  try {
    const parsed = new URL(rawUrl);
    const hasCredentialQuery = [...parsed.searchParams.keys()].some((key) =>
      /token|secret|authorization|api[_-]?key|signature|(^|[_-])sig($|[_-])|credential|key[_-]?pair|^policy$/i.test(
        key,
      ),
    );
    if (
      parsed.protocol !== "https:" ||
      parsed.username ||
      parsed.password ||
      parsed.hash ||
      hasCredentialQuery
    ) {
      return null;
    }
    return parsed.toString();
  } catch {
    return null;
  }
}

/** Map provider attachment kinds onto the existing `messages.type` CHECK set. */
export function instagramMessageType(
  attachment: InstagramInboundAttachment | null,
): "text" | "image" | "video" | "audio" | "document" {
  if (!attachment || attachment.type === "share") return "text";
  return attachment.type === "file" ? "document" : attachment.type;
}

/** Preserve provider media facts while refusing credential-bearing URLs. */
export function normalizeInstagramAttachments(
  message: InstagramWebhookMessagingEvent["message"],
): InstagramInboundAttachment[] {
  return (message?.attachments ?? []).map((attachment) => ({
    id: attachment.payload?.id ?? null,
    type: attachment.type,
    url: safeProviderMediaUrl(attachment.payload?.url),
    mime_type: attachment.payload?.mime_type ?? MIME_BY_TYPE[attachment.type],
    filename: attachment.payload?.filename ?? attachment.payload?.name ?? null,
    caption: attachment.payload?.caption ?? null,
  }));
}
