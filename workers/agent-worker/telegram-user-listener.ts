import { setTimeout as delay } from "node:timers/promises";
import { Api, type TelegramClient } from "teleproto";
import { MessageRead, NewMessage } from "teleproto/events";
import type { SupabaseClient } from "@supabase/supabase-js";

import { createTelegramUserClient } from "@/lib/channels/telegram-user/client";
import { telegramUserGetOutboxReadStates } from "@/lib/channels/telegram-user/client";
import { resolveTelegramUserCreds } from "@/lib/channels/telegram-user/credentials";
import { ingestTelegramUserInbound } from "@/lib/channels/telegram-user/ingest";
import {
  extrairReciboLeituraTelegramUsuario,
  listarPendenciasDeLeituraTelegram,
  sincronizarLeituraTelegramUsuario,
} from "@/lib/channels/telegram-user/read-receipts";
import type { Logger } from "@/lib/agent-engine/obs/logger";
import { MAX_MEDIA_BYTES } from "@/lib/messaging/media/types";

const POLL_INTERVAL_MS = 30_000;
const HEALTH_INTERVAL_MS = 60_000;
const READ_RECEIPT_RECONCILIATION_INTERVAL_MS = 60_000;
const READ_RECEIPT_INBOUND_CHECK_INTERVAL_MS = 15_000;
const RETRY_AFTER_FAILURE_MS = 90_000;

interface TelegramSessionRow {
  id: string;
  organization_id: string;
  telegram_user_id: string;
  status: string;
  last_health_check_at: string | null;
}

interface ActiveTelegramClient {
  client: TelegramClient;
  organizationId: string;
  telegramUserId: string;
  lastHealthAt: number;
  lastReceiptReconciliationAt: number;
  lastReadCheckAtByPeer: Map<string, number>;
}

function mediaInfo(media: Api.TypeMessageMedia | undefined): {
  type: "image" | "audio" | "document" | "video" | null;
  mime: string | null;
} {
  if (media instanceof Api.MessageMediaPhoto) return { type: "image", mime: "image/jpeg" };
  if (!(media instanceof Api.MessageMediaDocument) || !media.document) {
    return { type: null, mime: null };
  }

  const document = media.document;
  const mime = document.className === "Document" ? document.mimeType : null;
  if (media.video || mime?.startsWith("video/")) return { type: "video", mime };
  if (
    media.voice ||
    mime?.startsWith("audio/") ||
    (document.className === "Document" &&
      document.attributes.some((attribute) => attribute.className === "DocumentAttributeAudio"))
  ) {
    return { type: "audio", mime };
  }
  return { type: "document", mime };
}

function safeSessionErrorCode(error: unknown): string {
  const record = error && typeof error === "object" ? (error as Record<string, unknown>) : null;
  const candidates = [
    record?.errorMessage,
    record?.code,
    error instanceof Error ? error.message : null,
  ];
  for (const candidate of candidates) {
    if (typeof candidate !== "string") continue;
    const telegramCode = candidate.match(/[A-Z][A-Z0-9_]{3,63}/)?.[0];
    if (telegramCode) return telegramCode;
    if (/^telegram_[a-z0-9_]{3,63}$/.test(candidate)) return candidate;
  }
  return "telegram_connection_error";
}

async function updateSessionHealth(
  admin: SupabaseClient,
  row: Pick<TelegramSessionRow, "id" | "organization_id">,
  status: "WORKING" | "FAILED",
  reason: string | null,
): Promise<void> {
  const now = new Date().toISOString();
  const { error } = await admin
    .from("channel_sessions")
    .update({
      status,
      status_reason: reason,
      last_health_check_at: now,
      ...(status === "WORKING" ? { last_status_change_at: now } : {}),
    })
    .eq("id", row.id)
    .eq("organization_id", row.organization_id)
    .eq("provider", "telegram_user")
    .is("archived_at", null);
  if (error) throw new Error("telegram_session_health_update_failed");
}

async function disconnect(entry: ActiveTelegramClient): Promise<void> {
  await entry.client.disconnect().catch(() => undefined);
}

async function reconciliarRecibosDeLeituraTelegram(
  admin: SupabaseClient,
  row: TelegramSessionRow,
  entry: ActiveTelegramClient,
  log: Logger,
): Promise<void> {
  try {
    const pendencias = await listarPendenciasDeLeituraTelegram(admin, {
      organizationId: row.organization_id,
      channelSessionId: row.id,
    });
    if (pendencias.length === 0) return;

    let atualizadas = 0;
    for (let offset = 0; offset < pendencias.length; offset += 50) {
      const lote = pendencias.slice(offset, offset + 50);
      const estados = await telegramUserGetOutboxReadStates(
        entry.client,
        lote.map((pending) => pending.providerConversationId),
      );
      const estadoPorPeer = new Map(estados.map((state) => [state.peerId, state.maxId]));

      for (const pending of lote) {
        const maxIdLido = estadoPorPeer.get(pending.peerId);
        if (maxIdLido === undefined || maxIdLido < pending.minMessageId) continue;

        const result = await sincronizarLeituraTelegramUsuario(admin, {
          organizationId: row.organization_id,
          channelSessionId: row.id,
          peerId: pending.peerId,
          maxId: maxIdLido,
        });
        atualizadas += result.updated;
      }
    }

    if (atualizadas > 0) {
      log.info("telegram_user: recibos de leitura reconciliados pela API", {
        organization_id: row.organization_id,
        channel_session_id: row.id,
        messages_updated: atualizadas,
      });
    }
  } catch (error) {
    log.warn("telegram_user: reconciliação de recibos pela API falhou", {
      organization_id: row.organization_id,
      channel_session_id: row.id,
      reason: safeSessionErrorCode(error),
    });
  }
}

async function reconciliarLeituraTelegramAposRecebimento(
  admin: SupabaseClient,
  row: TelegramSessionRow,
  entry: ActiveTelegramClient,
  peerId: string,
  accessHash: string,
  log: Logger,
): Promise<void> {
  const agora = Date.now();
  const ultimaVerificacao = entry.lastReadCheckAtByPeer.get(peerId) ?? 0;
  if (agora - ultimaVerificacao < READ_RECEIPT_INBOUND_CHECK_INTERVAL_MS) return;
  entry.lastReadCheckAtByPeer.set(peerId, agora);

  try {
    const referencia = `tgu:${peerId}:${accessHash}`;
    const estados = await telegramUserGetOutboxReadStates(entry.client, [referencia]);
    const estado = estados.find((item) => item.peerId === peerId);
    if (!estado || estado.maxId < 1) return;

    const resultado = await sincronizarLeituraTelegramUsuario(admin, {
      organizationId: row.organization_id,
      channelSessionId: row.id,
      peerId,
      maxId: estado.maxId,
    });
    if (resultado.updated > 0) {
      log.info("telegram_user: recibos de leitura sincronizados após resposta recebida", {
        organization_id: row.organization_id,
        channel_session_id: row.id,
        messages_updated: resultado.updated,
      });
    }
  } catch (error) {
    log.warn("telegram_user: consulta de leitura após resposta recebida falhou", {
      organization_id: row.organization_id,
      channel_session_id: row.id,
      reason: safeSessionErrorCode(error),
    });
  }
}

async function connectSession(
  admin: SupabaseClient,
  row: TelegramSessionRow,
  active: Map<string, ActiveTelegramClient>,
  log: Logger,
): Promise<void> {
  let client: TelegramClient | undefined;
  let stage:
    | "resolve_credentials"
    | "connect"
    | "check_authorization"
    | "authorization_probe"
    | "register_listener"
    | "mark_working" = "resolve_credentials";
  try {
    const creds = await resolveTelegramUserCreds(admin, {
      organizationId: row.organization_id,
      userId: row.telegram_user_id,
    });
    if (!creds) throw new Error("telegram_session_credentials_unavailable");

    client = createTelegramUserClient(creds);
    stage = "connect";
    await client.connect();
    stage = "check_authorization";
    if (!(await client.checkAuthorization())) {
      // checkAuthorization descarta a exceção de updates.getState. Repetir a
      // verificação por getMe preserva um código RPC útil e não registra dados
      // pessoais; se a chamada funcionar, a sessão está autorizada.
      stage = "authorization_probe";
      const user = await client.getMe();
      if (!user || user.className !== "User") throw new Error("telegram_session_expired");
    }

    const entry: ActiveTelegramClient = {
      client,
      organizationId: row.organization_id,
      telegramUserId: row.telegram_user_id,
      lastHealthAt: Date.now(),
      lastReceiptReconciliationAt: Date.now(),
      lastReadCheckAtByPeer: new Map(),
    };
    stage = "register_listener";
    client.addEventHandler(
      async (event) => {
        try {
          if (!event.isPrivate || !event.message || event.message.out) return;
          const sender = await event.message.getSender();
          if (!(sender instanceof Api.User)) return;
          const peerId = event.chatId?.toString();
          if (!peerId || !/^\d+$/.test(peerId)) return;

          const message = event.message;
          const media = mediaInfo(message.media);
          const messageText = message.message || null;
          const accessHash = sender.accessHash?.toString() ?? null;
          const payload = {
            message_id: message.id,
            date: message.date,
            is_private: true as const,
            access_hash: accessHash,
            from: {
              id: sender.id.toString(),
              first_name: sender.firstName ?? "",
              last_name: sender.lastName ?? null,
              username: sender.username ?? null,
              phone: sender.phone ?? null,
            },
            peer_id: peerId,
            text: messageText,
            caption: media.type ? messageText : null,
            media_type: media.type,
            media_url:
              media.type && accessHash
                ? `telegram-user-media://${peerId}/${accessHash}/${message.id}`
                : null,
            media_mime: media.mime,
          };

          if (media.type) {
            const document =
              message.media instanceof Api.MessageMediaDocument ? message.media.document : null;
            if (document?.className === "Document" && Number(document.size) > MAX_MEDIA_BYTES) {
              log.warn("telegram_user: mídia acima do limite foi ignorada", {
                organization_id: row.organization_id,
                channel_session_id: row.id,
              });
              payload.media_type = null;
              payload.media_url = null;
              payload.media_mime = null;
            }
          }

          const result = await ingestTelegramUserInbound(admin, {
            organizationId: row.organization_id,
            channelSessionId: row.id,
            payload,
          });
          if (result.status === "failed") {
            log.error("telegram_user: mensagem recebida não foi persistida", {
              organization_id: row.organization_id,
              channel_session_id: row.id,
            });
          } else if (accessHash) {
            // Uma resposta do contato confirma que ele abriu a DM. Consulta o
            // limite de leitura do peer sem esperar o ciclo periódico completo.
            void reconciliarLeituraTelegramAposRecebimento(
              admin,
              row,
              entry,
              sender.id.toString(),
              accessHash,
              log,
            );
          }
        } catch (error) {
          log.error("telegram_user: falha ao processar mensagem recebida", {
            organization_id: row.organization_id,
            channel_session_id: row.id,
            reason: safeSessionErrorCode(error),
          });
        }
      },
      new NewMessage({ incoming: true }),
    );

    client.addEventHandler(
      async (event) => {
        try {
          const update = event.originalUpdate;
          const updateType =
            update && typeof update === "object" && "className" in update
              ? String(update.className)
              : "unknown";
          const peer =
            update && typeof update === "object" && "peer" in update ? update.peer : null;
          const peerType =
            peer && typeof peer === "object" && "className" in peer
              ? String(peer.className)
              : "unknown";

          log.info("telegram_user: evento MTProto de leitura recebido", {
            organization_id: row.organization_id,
            channel_session_id: row.id,
            outbox: event.outbox,
            update_type: updateType,
            peer_type: peerType,
          });

          const recibo = extrairReciboLeituraTelegramUsuario(event.outbox, update);
          if (!recibo) {
            log.warn("telegram_user: evento de leitura ignorado", {
              organization_id: row.organization_id,
              channel_session_id: row.id,
              outbox: event.outbox,
              update_type: updateType,
              peer_type: peerType,
            });
            return;
          }

          // O destinatário pode abrir a conversa logo após o envio, antes de a
          // rota do Customer persistir o external_id. Reconsultas curtas fecham
          // essa janela sem criar fila ou estado duplicado no banco.
          let resultado = null;
          for (let tentativa = 0; tentativa < 4; tentativa += 1) {
            if (tentativa > 0) await delay(250);
            resultado = await sincronizarLeituraTelegramUsuario(admin, {
              organizationId: row.organization_id,
              channelSessionId: row.id,
              peerId: recibo.peerId,
              maxId: recibo.maxId,
            });
            if (resultado.messageMatched || !resultado.conversationFound) break;
          }

          if (resultado?.updated) {
            log.info("telegram_user: recibo de leitura sincronizado", {
              organization_id: row.organization_id,
              channel_session_id: row.id,
              messages_updated: resultado.updated,
            });
          } else {
            log.warn("telegram_user: recibo de leitura sem mensagem correspondente", {
              organization_id: row.organization_id,
              channel_session_id: row.id,
              conversation_found: resultado?.conversationFound ?? false,
              message_matched: resultado?.messageMatched ?? false,
            });
          }
        } catch (error) {
          log.error("telegram_user: falha ao sincronizar recibo de leitura", {
            organization_id: row.organization_id,
            channel_session_id: row.id,
            reason: safeSessionErrorCode(error),
          });
        }
      },
      new MessageRead({ inbox: false }),
    );

    active.set(row.id, entry);
    stage = "mark_working";
    await updateSessionHealth(admin, row, "WORKING", null);
    log.info("telegram_user: sessão conectada ao worker", {
      organization_id: row.organization_id,
      channel_session_id: row.id,
    });
    await reconciliarRecibosDeLeituraTelegram(admin, row, entry, log);
  } catch (error) {
    if (client) await client.disconnect().catch(() => undefined);
    await updateSessionHealth(admin, row, "FAILED", safeSessionErrorCode(error)).catch(
      () => undefined,
    );
    log.warn("telegram_user: conexão da sessão falhou", {
      organization_id: row.organization_id,
      channel_session_id: row.id,
      stage,
      reason: safeSessionErrorCode(error),
    });
  }
}

/**
 * Mantém listeners MTProto no worker de agente já publicado. Uma instalação
 * sem contas conectadas só faz uma consulta leve por ciclo; não cria serviço
 * nem contêiner adicional.
 */
export async function runTelegramUserListenerLoop(
  admin: SupabaseClient,
  log: Logger,
  signal: AbortSignal,
): Promise<void> {
  const active = new Map<string, ActiveTelegramClient>();

  try {
    while (!signal.aborted) {
      try {
        const { data, error } = await admin
          .from("channel_sessions")
          .select("id, organization_id, telegram_user_id, status, last_health_check_at")
          .eq("provider", "telegram_user")
          .is("archived_at", null)
          .in("status", ["WORKING", "STARTING", "FAILED"]);

        if (error) throw new Error("telegram_session_query_failed");
        const rows = (data ?? []) as unknown as TelegramSessionRow[];
        const currentIds = new Set(rows.map((row) => row.id));

        for (const [id, entry] of active) {
          const row = rows.find((candidate) => candidate.id === id);
          const shouldRestart = row?.status === "STARTING";
          if (!currentIds.has(id) || !entry.client.connected || shouldRestart) {
            await disconnect(entry);
            active.delete(id);
            if (row && !shouldRestart) {
              await updateSessionHealth(admin, row, "FAILED", "telegram_connection_lost").catch(
                () => undefined,
              );
            }
          }
        }

        for (const row of rows) {
          if (signal.aborted) break;
          const existing = active.get(row.id);
          if (existing) {
            const now = Date.now();
            if (now - existing.lastHealthAt >= HEALTH_INTERVAL_MS) {
              existing.lastHealthAt = now;
              await updateSessionHealth(admin, row, "WORKING", null).catch(() => undefined);
            }
            if (
              now - existing.lastReceiptReconciliationAt >=
              READ_RECEIPT_RECONCILIATION_INTERVAL_MS
            ) {
              existing.lastReceiptReconciliationAt = now;
              await reconciliarRecibosDeLeituraTelegram(admin, row, existing, log);
            }
            continue;
          }

          const lastCheck = row.last_health_check_at ? Date.parse(row.last_health_check_at) : 0;
          if (row.status === "FAILED" && Date.now() - lastCheck < RETRY_AFTER_FAILURE_MS) continue;
          await connectSession(admin, row, active, log);
        }
      } catch (error) {
        log.warn("telegram_user: reconciliação do listener falhou", {
          reason: safeSessionErrorCode(error),
        });
      }

      try {
        await delay(POLL_INTERVAL_MS, undefined, { signal });
      } catch {
        if (!signal.aborted) throw new Error("telegram_listener_wait_failed");
      }
    }
  } finally {
    await Promise.all([...active.values()].map(disconnect));
    active.clear();
  }
}
