import { createHash } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { audit } from "@/lib/audit";
import { canonicalPhoneBR } from "@/lib/channels/phone-variants";
import { validarIdentidadeDaConversa, type HistoryIdentity } from "@/lib/channels/historico/identidade";
import { mapearMensagemHistorica } from "@/lib/channels/historico/mapear";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";
import { getWahaClient, type WahaClient, type WahaHistoryPage, type WahaSessionSnapshot } from "@/lib/waha/client";
import { parseChatId } from "@/lib/waha/ingest";
import type { WahaPayload } from "@/lib/waha/envelope";

const CHAT_PAGE_SIZE = 1;
const MESSAGE_PAGE_SIZE = 100;
// O cron tem teto operacional de 180s. Uma conversa é indivisível para validar
// identidade; acima destes limites ela é ignorada inteira, sem gravação parcial.
const MAX_MESSAGES_PER_CHAT = 100;
const MAX_MEDIA_DETAIL_REQUESTS = 4;
const MAX_ATTEMPTS = 5;

interface HistoryJob {
  id: string;
  organization_id: string;
  channel_session_id: string;
  range_start: string;
  cursor: unknown;
  lease_token: string;
  attempts: number;
  imported_count: number;
  skipped_count: number;
  failed_count: number;
  created_by: string | null;
}

interface ChannelSession {
  id: string;
  organization_id: string;
  provider: string;
  waha_session_name: string | null;
  status: string;
  phone_number: string | null;
  archived_at: string | null;
}

type Admin = SupabaseClient;

function cursorOffset(value: unknown): number {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  const offset = (value as Record<string, unknown>).chat_offset;
  return typeof offset === "number" && Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
}

function codeSeguro(error: unknown): string {
  const message = error instanceof Error ? error.message : "";
  const code = message.match(/\b(history_[a-z0-9_]+|waha_history_[0-9]{3})\b/)?.[1];
  return code ?? "history_provider_unavailable";
}

function tipoPermitido(type: string): boolean {
  return ["text", "image", "video", "audio", "document", "sticker", "location", "contact", "reaction", "system"].includes(type);
}

function digestMensagens(messages: WahaPayload[]): string {
  const stable = messages.map((m) => [
    m.id ?? null, m.timestamp ?? null, m.fromMe ?? null, m.from ?? null, m.to ?? null,
    m.body ?? null, m.type ?? null, m.hasMedia ?? null,
    m.mediaUrl ?? m.media?.url ?? null, m.mimetype ?? m.media?.mimetype ?? null,
    m._data?.key?.remoteJid ?? null, m._data?.key?.remoteJidAlt ?? null,
    m._data?.key?.participant ?? null, m._data?.key?.participantAlt ?? null,
  ]);
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

async function carregarConversa(
  waha: WahaClient,
  session: string,
  chatId: string,
  desde: number,
): Promise<{ messages: WahaPayload[]; bounded: boolean }> {
  const messages: WahaPayload[] = [];
  for (let offset = 0; offset <= MAX_MESSAGES_PER_CHAT; offset += MESSAGE_PAGE_SIZE) {
    const page: WahaHistoryPage = await waha.listarMensagensHistorico(session, chatId, {
      limit: MESSAGE_PAGE_SIZE,
      offset,
      desde,
    });
    if (messages.length + page.items.length > MAX_MESSAGES_PER_CHAT) return { messages: [], bounded: false };
    messages.push(...page.items);
    if (page.items.length === 0 || !page.hasMore) return { messages, bounded: true };
  }
  return { messages: [], bounded: false };
}

function localPhoneOf(session: WahaSessionSnapshot, channelPhone: string | null): string | null {
  if (channelPhone) return channelPhone;
  const me = session.me;
  if (!me) return null;
  for (const key of ["id", "_serialized", "wid"]) {
    const value = me[key];
    if (typeof value === "string" && value.includes("@")) return value;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const serialized = (value as Record<string, unknown>)._serialized;
      if (typeof serialized === "string") return serialized;
    }
  }
  return null;
}

function identitiesForSuppression(identities: HistoryIdentity[]): string[] {
  return [...new Set(identities.map((identity) => identity.token))];
}

async function checkpoint(
  db: Admin,
  job: HistoryJob,
  input: { offset: number; skipped?: number; failed?: number; status?: "pending" | "completed" | "failed"; errorCode?: string | null },
): Promise<HistoryJob> {
  const { data, error } = await db.rpc("fn_whatsapp_history_checkpoint" as never, {
    p_import: job.id,
    p_lease: job.lease_token,
    p_cursor: { chat_offset: input.offset },
    p_imported: 0, // contagem de mensagens é incrementada atomicamente no INSERT
    p_skipped: input.skipped ?? 0,
    p_failed: input.failed ?? 0,
    p_status: input.status ?? "pending",
    p_error_code: input.errorCode ?? null,
  } as never);
  if (error) {
    if (error.message.includes("history_import_lease_lost")) throw new Error("history_import_lease_lost");
    throw new Error("history_checkpoint_failed");
  }
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error("history_checkpoint_failed");
  return row as HistoryJob;
}

async function logTerminalJob(job: HistoryJob, action: "channel.history_import_completed" | "channel.history_import_failed", counts?: Record<string, number | string>): Promise<void> {
  await audit({
    action,
    actorUserId: job.created_by ?? undefined,
    organizationId: job.organization_id,
    resourceType: "whatsapp_history_import",
    resourceId: job.id,
    metadata: counts ?? {},
  });
}

async function tratarChat(
  db: Admin,
  waha: WahaClient,
  job: HistoryJob,
  session: ChannelSession,
  snapshot: WahaSessionSnapshot,
  chatId: string,
): Promise<"imported" | "skipped"> {
  const identity = parseChatId(chatId);
  if (identity.kind !== "phone" && identity.kind !== "lid") return "skipped";

  const first = await carregarConversa(waha, session.waha_session_name!, chatId, Math.floor(new Date(job.range_start).getTime() / 1000));
  if (!first.bounded || first.messages.length === 0) return "skipped";
  const second = await carregarConversa(waha, session.waha_session_name!, chatId, Math.floor(new Date(job.range_start).getTime() / 1000));
  if (!second.bounded || digestMensagens(first.messages) !== digestMensagens(second.messages)) return "skipped";

  const resolvedPhone = identity.kind === "lid"
    ? await waha.resolvePhoneForLid(session.waha_session_name!, identity.lid ?? "", { falhaLanca: true })
    : identity.phone;
  const localPhone = localPhoneOf(snapshot, session.phone_number);
  const validate = (messages: WahaPayload[]) => validarIdentidadeDaConversa({
    chatId,
    messages,
    resolvedPhone,
    localPhone,
  });
  const beforeMedia = validate(second.messages);
  if (beforeMedia.verdict !== "IDENTITY_VALID") return "skipped";

  let mediaDetails = 0;
  const mediaUnavailable = new Set<string>();
  const completeMessages: WahaPayload[] = [];
  for (const original of second.messages) {
    let message = original;
    const url = original.mediaUrl ?? original.media?.url;
    if ((original.hasMedia === true || Boolean(url)) && !url) {
      mediaDetails += 1;
      if (!original.id) return "skipped";
      if (mediaDetails > MAX_MEDIA_DETAIL_REQUESTS) {
        mediaUnavailable.add(original.id);
      } else {
        try {
          const detailed = await waha.obterMensagemMidiaHistorica(session.waha_session_name!, chatId, original.id);
          if (detailed.fromMe !== original.fromMe || detailed.timestamp !== original.timestamp) return "skipped";
          message = { ...original, ...detailed };
          if (detailed.hasMedia && !(detailed.mediaUrl ?? detailed.media?.url)) mediaUnavailable.add(original.id);
        } catch (error) {
          const code = error instanceof Error ? error.message : "";
          if (!/^waha_history_(404|410)$/.test(code)) throw error;
          mediaUnavailable.add(original.id);
        }
      }
    } else if (url) {
      message = { ...original, mediaUrl: waha.urlMidiaHistorica(url) };
    }
    completeMessages.push(message);
  }
  const completeIdentity = validate(completeMessages);
  if (completeIdentity.verdict !== "IDENTITY_VALID") return "skipped";

  const minTime = new Date(job.range_start).getTime();
  const maxTime = Date.now() + 5 * 60_000;
  const mapped = [];
  const seen = new Set<string>();
  for (const message of completeMessages) {
    if (!message.id || seen.has(message.id)) return "skipped";
    seen.add(message.id);
    const row = mapearMensagemHistorica(message, { mediaUnavailable: mediaUnavailable.has(message.id ?? "") });
    if (!row || !tipoPermitido(row.type)) return "skipped";
    const sentAt = new Date(row.sentAt).getTime();
    if (!Number.isFinite(sentAt) || sentAt > maxTime) return "skipped";
    if (sentAt >= minTime) mapped.push(row);
  }
  if (mapped.length === 0) return "skipped";
  mapped.sort((a, b) => a.sentAt.localeCompare(b.sentAt) || a.externalId.localeCompare(b.externalId));

  const parsedPhone = completeIdentity.phone ?? resolvedPhone;
  const phone = parsedPhone ? canonicalPhoneBR(parsedPhone) : null;
  const result = await db.rpc("fn_whatsapp_history_persist_conversation" as never, {
    p_import: job.id,
    p_lease: job.lease_token,
    p_kind: identity.kind,
    p_phone: phone,
    p_lid: completeIdentity.lid,
    p_chat_id: chatId,
    p_identities: identitiesForSuppression(completeIdentity.identities),
    p_messages: mapped.map((m) => ({
      external_id: m.externalId,
      type: m.type,
      direction: m.direction,
      status: m.status,
      body: m.body,
      media_url: m.mediaUrl,
      media_mime: m.mediaMime,
      sent_at: m.sentAt,
      metadata: m.metadata,
    })),
  } as never);
  if (result.error) throw new Error("history_persist_failed");
  const persisted = result.data as Record<string, unknown> | null;
  if (persisted?.skipped === true) return "skipped";
  return "imported";
}

/** Processa no máximo uma conversa por tick; todo o lote é validado antes do RPC atômico. */
export async function runHistoryImportTick(
  db: Admin = createAdminClient(),
  waha: WahaClient | null = getWahaClient(),
): Promise<{ claimed: boolean; result?: string }> {
  if (!waha) return { claimed: false, result: "waha_unconfigured" };
  const { data: claimed, error: claimError } = await db.rpc("fn_whatsapp_history_claim" as never, { p_lease_seconds: 180 } as never);
  if (claimError) throw new Error("history_claim_failed");
  const job = (Array.isArray(claimed) ? claimed[0] : claimed) as HistoryJob | null;
  if (!job) return { claimed: false };
  const offset = cursorOffset(job.cursor);

  try {
    const { data: rawSession, error: sessionError } = await db
      .from("channel_sessions")
      .select("id, organization_id, provider, waha_session_name, status, phone_number, archived_at")
      .eq("organization_id", job.organization_id)
      .eq("id", job.channel_session_id)
      .maybeSingle();
    if (sessionError || !rawSession) throw new Error("history_session_unavailable");
    const session = rawSession as ChannelSession;
    if (session.provider !== "waha" || !session.waha_session_name || session.archived_at) throw new Error("history_session_incompatible");
    if (session.status !== "WORKING") throw new Error("history_session_not_working");

    const snapshot = await waha.getVerifiedSession(session.waha_session_name);
    if (!snapshot || snapshot.status !== "WORKING") throw new Error("history_session_not_working");
    if (!waha.isHistoryStoreEnabled(snapshot)) throw new Error("history_store_not_enabled");

    const page = await waha.listarChatsHistorico(session.waha_session_name, { limit: CHAT_PAGE_SIZE, offset });
    const chatId = page.items[0]?.id;
    if (!chatId) {
      const completed = await checkpoint(db, job, { offset, status: "completed" });
      await logTerminalJob(job, "channel.history_import_completed", {
        imported_count: completed.imported_count,
        skipped_count: completed.skipped_count,
        failed_count: completed.failed_count,
      });
      return { claimed: true, result: "completed" };
    }

    let skipped = 0;
    let imported = false;
    try {
      imported = await tratarChat(db, waha, job, session, snapshot, chatId) === "imported";
      skipped = imported ? 0 : 1;
    } catch (error) {
      const code = codeSeguro(error);
      // Provider/transport errors retry boundedly; identity and format failures
      // are counted as skipped by tratarChat before this catch.
      const exhausted = job.attempts + 1 >= MAX_ATTEMPTS;
      const updated = await checkpoint(db, job, {
        offset,
        failed: exhausted ? 1 : 0,
        status: exhausted ? "failed" : "pending",
        errorCode: code,
      });
      if (exhausted) {
      await logTerminalJob(job, "channel.history_import_failed", {
          imported_count: updated.imported_count,
          skipped_count: updated.skipped_count,
          failed_count: updated.failed_count,
        reason_code: code,
        });
      }
      logger.warn("[whatsapp-history] conversation processing deferred", {
        import_id: job.id,
        organization_id: job.organization_id,
        error_code: code,
        attempt: job.attempts,
      });
      return { claimed: true, result: exhausted ? "failed" : "retry" };
    }

    await checkpoint(db, job, { offset: offset + 1, skipped });
    return { claimed: true, result: imported ? "conversation_imported" : "conversation_skipped" };
  } catch (error) {
    const code = codeSeguro(error);
    if (code === "history_import_lease_lost") return { claimed: true, result: "lease_lost" };
    const exhausted = job.attempts + 1 >= MAX_ATTEMPTS;
    const updated = await checkpoint(db, job, {
      offset,
      failed: exhausted ? 1 : 0,
      status: exhausted ? "failed" : "pending",
      errorCode: code,
    });
    if (exhausted) await logTerminalJob(job, "channel.history_import_failed", {
      imported_count: updated.imported_count,
      skipped_count: updated.skipped_count,
      failed_count: updated.failed_count,
      reason_code: code,
    });
    logger.warn("[whatsapp-history] import tick deferred", {
      import_id: job.id,
      organization_id: job.organization_id,
      error_code: code,
      attempt: job.attempts,
    });
    return { claimed: true, result: exhausted ? "failed" : "retry" };
  }
}
