import { createAdminClient } from "@/lib/supabase/admin";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";
import { resolveTelegramCreds } from "../telegram/credentials";
import {
  telegramGetMe,
  telegramSendDocument,
  telegramSendMessage,
  telegramSendPhoto,
  telegramSendVoice,
} from "../telegram/client";

const NAO_CONFIGURADO = "telegram_not_configured";

export const telegramAdapter: ChannelAdapter = {
  provider: "telegram",

  resolveRecipient(input: RecipientInput): string | null {
    if (input.groupChatId) return input.groupChatId;

    if (input.waIdentity && input.waIdentity.startsWith("telegram:")) {
      return input.waIdentity.replace(/^telegram:/, "");
    }

    if (input.phoneNumber) {
      // Aceita IDs numéricos de Telegram passados no campo de telefone
      const clean = input.phoneNumber.replace(/[^\d-]/g, "");
      return clean.length > 0 ? clean : null;
    }

    return null;
  },

  isConfigured(): boolean {
    return true;
  },

  async checkHealth(
    input: ChannelTenantScope & { sessionRef: string },
  ): Promise<ChannelHealth> {
    const admin = createAdminClient();
    const creds = await resolveTelegramCreds(admin, {
      organizationId: input.organizationId,
      botId: input.sessionRef,
    });

    if (!creds) {
      return { reachable: false, status: null, detail: "sem_credencial_para_o_bot" };
    }

    try {
      const me = await telegramGetMe(creds.token);
      return {
        reachable: true,
        status: me.is_bot ? "WORKING" : "FAILED",
        detail: me.username ? `@${me.username}` : null,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "erro_desconhecido";
      return { reachable: false, status: "FAILED", detail: detail.slice(0, 200) };
    }
  },

  codes: {
    notConfigured: NAO_CONFIGURADO,
    sendFailed: "telegram_error",
    unknownError: "telegram_unknown",
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const admin = createAdminClient();
    const creds = await resolveTelegramCreds(admin, {
      organizationId: envelope.organizationId,
      botId: envelope.sessionRef,
    });

    if (!creds) {
      throw new Error(`${NAO_CONFIGURADO}: nenhuma credencial gravada para esta sessão.`);
    }

    const chatId = envelope.to;
    const { token } = creds;

    if (envelope.kind === "text" && envelope.body) {
      const res = await telegramSendMessage(token, chatId, envelope.body);
      return { externalId: `tg:${chatId}:${res.message_id}` };
    }

    if (envelope.kind === "image" && envelope.media?.url) {
      const res = await telegramSendPhoto(
        token,
        chatId,
        envelope.media.url,
        envelope.media.caption ?? undefined,
      );
      return { externalId: `tg:${chatId}:${res.message_id}` };
    }

    if (envelope.kind === "audio" && envelope.media?.url) {
      const res = await telegramSendVoice(
        token,
        chatId,
        envelope.media.url,
        envelope.media.caption ?? undefined,
      );
      return { externalId: `tg:${chatId}:${res.message_id}` };
    }

    if (envelope.kind === "document" && envelope.media?.url) {
      const res = await telegramSendDocument(
        token,
        chatId,
        envelope.media.url,
        envelope.media.caption ?? undefined,
      );
      return { externalId: `tg:${chatId}:${res.message_id}` };
    }

    // Fallback: se houver corpo
    if (envelope.body) {
      const res = await telegramSendMessage(token, chatId, envelope.body);
      return { externalId: `tg:${chatId}:${res.message_id}` };
    }

    return { externalId: null };
  },
};
