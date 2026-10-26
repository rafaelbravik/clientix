import type { WahaPayload } from "@/lib/waha/envelope";
import { resolveMessageType } from "@/lib/waha/ingest";

export interface HistoricalMessageInput {
  externalId: string;
  direction: "inbound" | "outbound";
  status: "delivered" | "sent";
  sentAt: string;
  type: string;
  body: string | null;
  mediaUrl: string | null;
  mediaMime: string | null;
  metadata: Record<string, unknown>;
}

export function timestampHistorico(timestamp: number | null | undefined): string | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp) || timestamp <= 0) return null;
  const millis = timestamp >= 1e16 ? timestamp / 1e6 : timestamp >= 1e11 ? timestamp : timestamp * 1000;
  const date = new Date(millis);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function mapearMensagemHistorica(
  payload: WahaPayload,
  opts: { mediaUnavailable?: boolean } = {},
): HistoricalMessageInput | null {
  const externalId = payload.id?.trim();
  const sentAt = timestampHistorico(payload.timestamp);
  if (!externalId || !sentAt || typeof payload.fromMe !== "boolean") return null;
  const type = resolveMessageType(payload);
  const direction = payload.fromMe ? "outbound" : "inbound";
  const mediaUrl = payload.mediaUrl ?? payload.media?.url ?? null;
  const mediaMime = payload.mimetype ?? payload.media?.mimetype ?? null;
  const hasMedia = payload.hasMedia === true || Boolean(mediaUrl);
  if (hasMedia && !mediaUrl && !opts.mediaUnavailable) return null;
  return {
    externalId,
    direction,
    status: direction === "inbound" ? "delivered" : "sent",
    sentAt,
    type,
    body: typeof payload.body === "string" ? payload.body : null,
    mediaUrl,
    mediaMime,
    metadata: {
      raw_type: payload.type ?? null,
      history_import: true,
      ...(hasMedia ? { media_status: opts.mediaUnavailable ? "unavailable" : "pending" } : {}),
    },
  };
}
