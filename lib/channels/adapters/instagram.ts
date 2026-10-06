import { createAdminClient } from "@/lib/supabase/admin";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";
import { resolveInstagramCreds } from "../instagram/credentials";
import {
  instagramGetAccount,
  instagramSendMedia,
  instagramSendMessage,
} from "../instagram/client";

const NAO_CONFIGURADO = "instagram_not_configured";

export const instagramAdapter: ChannelAdapter = {
  provider: "instagram",

  resolveRecipient(input: RecipientInput): string | null {
    if (input.groupChatId) return null;

    if (input.waIdentity && input.waIdentity.startsWith("instagram:")) {
      return input.waIdentity.replace(/^instagram:/, "");
    }

    if (input.phoneNumber) {
      const clean = input.phoneNumber.replace(/[^\d]/g, "");
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
    const creds = await resolveInstagramCreds(admin, {
      organizationId: input.organizationId,
      accountId: input.sessionRef,
    });

    if (!creds) {
      return { reachable: false, status: null, detail: "sem_credencial_para_o_instagram" };
    }

    try {
      const acc = await instagramGetAccount(creds.token, creds.accountId);
      return {
        reachable: true,
        status: acc.id ? "WORKING" : "FAILED",
        detail: acc.username ? `@${acc.username}` : null,
      };
    } catch (err) {
      return {
        reachable: false,
        status: "FAILED",
        detail: String(err),
      };
    }
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const admin = createAdminClient();
    const creds = await resolveInstagramCreds(admin, {
      organizationId: envelope.organizationId,
      accountId: envelope.sessionRef,
    });

    if (!creds) {
      throw new Error(NAO_CONFIGURADO);
    }

    if (envelope.beforeSend) {
      await envelope.beforeSend();
    }

    if (envelope.media && envelope.media.url) {
      const mediaType =
        envelope.media.mime.startsWith("image/")
          ? "image"
          : envelope.media.mime.startsWith("audio/")
            ? "audio"
            : envelope.media.mime.startsWith("video/")
              ? "video"
              : "file";

      const res = await instagramSendMedia(
        creds.token,
        creds.accountId,
        envelope.to,
        mediaType,
        envelope.media.url,
      );
      return { externalId: res.messageId };
    }

    const res = await instagramSendMessage(
      creds.token,
      creds.accountId,
      envelope.to,
      envelope.body ?? "",
    );

    return { externalId: res.messageId };
  },

  codes: {
    notConfigured: NAO_CONFIGURADO,
    sendFailed: "instagram_send_failed",
    unknownError: "instagram_unknown_error",
  },
};
