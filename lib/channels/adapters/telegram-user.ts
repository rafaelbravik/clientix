import { createAdminClient } from "@/lib/supabase/admin";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";
import { resolveTelegramUserCreds } from "../telegram-user/credentials";
import {
  telegramUserGetMe,
  telegramUserSendMessage,
  telegramUserSendMedia,
} from "../telegram-user/client";

const NAO_CONFIGURADO = "telegram_user_not_configured";

export const telegramUserAdapter: ChannelAdapter = {
  provider: "telegram_user",

  resolveRecipient(input: RecipientInput): string | null {
    if (input.groupChatId) return input.groupChatId;

    if (input.waIdentity && input.waIdentity.startsWith("telegram:")) {
      return input.waIdentity.replace(/^telegram:(user:)?/, "");
    }

    if (input.phoneNumber) {
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
    const creds = await resolveTelegramUserCreds(admin, {
      organizationId: input.organizationId,
      userId: input.sessionRef,
    });

    if (!creds) {
      return { reachable: false, status: null, detail: "sem_credencial_para_o_usuario" };
    }

    try {
      const me = await telegramUserGetMe(creds);
      return {
        reachable: true,
        status: "WORKING",
        detail: me.username ? `@${me.username}` : me.phone || me.firstName,
      };
    } catch (err) {
      const detail = err instanceof Error ? err.message : "erro_desconhecido";
      return { reachable: false, status: "FAILED", detail: detail.slice(0, 200) };
    }
  },

  codes: {
    notConfigured: NAO_CONFIGURADO,
    sendFailed: "telegram_user_error",
    unknownError: "telegram_user_unknown",
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const admin = createAdminClient();
    const creds = await resolveTelegramUserCreds(admin, {
      organizationId: envelope.organizationId,
      userId: envelope.sessionRef,
    });

    if (!creds) {
      throw new Error(`${NAO_CONFIGURADO}: nenhuma credencial gravada para esta sessão.`);
    }

    const to = envelope.to;

    if (envelope.kind === "text" && envelope.body) {
      const res = await telegramUserSendMessage(creds, {
        to,
        text: envelope.body,
      });
      return { externalId: `tgu:${to}:${res.messageId}` };
    }

    if (envelope.kind === "image" && envelope.media?.url) {
      const res = await telegramUserSendMedia(creds, {
        to,
        mediaUrl: envelope.media.url,
        caption: envelope.media.caption ?? null,
        mediaType: "image",
      });
      return { externalId: `tgu:${to}:${res.messageId}` };
    }

    if (envelope.kind === "audio" && envelope.media?.url) {
      const res = await telegramUserSendMedia(creds, {
        to,
        mediaUrl: envelope.media.url,
        caption: envelope.media.caption ?? null,
        mediaType: "audio",
      });
      return { externalId: `tgu:${to}:${res.messageId}` };
    }

    if (envelope.kind === "document" && envelope.media?.url) {
      const res = await telegramUserSendMedia(creds, {
        to,
        mediaUrl: envelope.media.url,
        caption: envelope.media.caption ?? null,
        mediaType: "document",
      });
      return { externalId: `tgu:${to}:${res.messageId}` };
    }

    if (envelope.body) {
      const res = await telegramUserSendMessage(creds, {
        to,
        text: envelope.body,
      });
      return { externalId: `tgu:${to}:${res.messageId}` };
    }

    return { externalId: null };
  },
};
