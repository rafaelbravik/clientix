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
  telegramUserEditMessage,
  telegramUserFetchMedia,
  telegramUserGetMe,
  telegramUserRevokeMessage,
  telegramUserSendMessage,
  telegramUserSendMedia,
} from "../telegram-user/client";

const NAO_CONFIGURADO = "telegram_user_not_configured";

export const telegramUserAdapter: ChannelAdapter = {
  provider: "telegram_user",

  resolveRecipient(input: RecipientInput): string | null {
    // A API de usuário precisa do access_hash entregue pelo próprio Telegram.
    // O ingest guarda esse peer em provider_conversation_id; telefone ou ID puro
    // não bastam para endereçar com segurança uma mensagem MTProto.
    return input.isGroup
      ? null
      : input.providerConversationId?.startsWith("tgu:")
        ? input.providerConversationId
        : null;
  },

  isConfigured(): boolean {
    return true;
  },

  async checkHealth(input: ChannelTenantScope & { sessionRef: string }): Promise<ChannelHealth> {
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

  async fetchInboundMedia(input) {
    const match = /^telegram-user-media:\/\/(\d+)\/(-?\d+)\/(\d+)$/.exec(input.url);
    if (!match?.[1] || !match[2] || !match[3]) throw new Error("telegram_media_reference_invalid");

    const creds = await resolveTelegramUserCreds(createAdminClient(), {
      organizationId: input.organizationId,
      userId: input.sessionRef,
    });
    if (!creds) throw new Error("telegram_user_session_unavailable");
    return telegramUserFetchMedia(creds, `tgu:${match[1]}:${match[2]}`, match[3]);
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
      return { externalId: `${to}:${res.messageId}` };
    }

    if (envelope.kind === "image" && envelope.media?.url) {
      const res = await telegramUserSendMedia(creds, {
        to,
        mediaUrl: envelope.media.url,
        caption: envelope.media.caption ?? null,
        mediaType: "image",
      });
      return { externalId: `${to}:${res.messageId}` };
    }

    if (envelope.kind === "audio" && envelope.media?.url) {
      const res = await telegramUserSendMedia(creds, {
        to,
        mediaUrl: envelope.media.url,
        caption: envelope.media.caption ?? null,
        mediaType: "audio",
      });
      return { externalId: `${to}:${res.messageId}` };
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
      return { externalId: `${to}:${res.messageId}` };
    }

    if (envelope.kind === "video" && envelope.media?.url) {
      const res = await telegramUserSendMedia(creds, {
        to,
        mediaUrl: envelope.media.url,
        caption: envelope.media.caption ?? null,
        mediaType: "video",
      });
      return { externalId: `${to}:${res.messageId}` };
    }

    if (envelope.body) {
      const res = await telegramUserSendMessage(creds, { to, text: envelope.body });
      return { externalId: `${to}:${res.messageId}` };
    }

    throw new Error(`Tipo de mensagem não suportado pelo Telegram Usuário: ${envelope.kind}`);
  },

  async editMessage(input) {
    if (!input.recipient) throw new Error("recipient_unavailable");
    const creds = await resolveTelegramUserCreds(createAdminClient(), {
      organizationId: input.organizationId,
      userId: input.sessionRef,
    });
    if (!creds) throw new Error(`${NAO_CONFIGURADO}: nenhuma credencial gravada para esta sessão.`);
    await telegramUserEditMessage(creds, {
      to: input.recipient,
      externalId: input.externalId,
      text: input.text,
    });
  },

  async revokeMessage(input) {
    if (!input.recipient) throw new Error("recipient_unavailable");
    const creds = await resolveTelegramUserCreds(createAdminClient(), {
      organizationId: input.organizationId,
      userId: input.sessionRef,
    });
    if (!creds) throw new Error(`${NAO_CONFIGURADO}: nenhuma credencial gravada para esta sessão.`);
    await telegramUserRevokeMessage(creds, {
      to: input.recipient,
      externalId: input.externalId,
    });
  },
};
