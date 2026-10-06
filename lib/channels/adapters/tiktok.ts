import { createAdminClient } from "@/lib/supabase/admin";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";
import { resolveTikTokCreds } from "../tiktok/credentials";
import {
  tiktokGetBusinessInfo,
  tiktokSendMessage,
} from "../tiktok/client";

const NAO_CONFIGURADO = "tiktok_not_configured";

export const tiktokAdapter: ChannelAdapter = {
  provider: "tiktok",

  resolveRecipient(input: RecipientInput): string | null {
    if (input.groupChatId) return null;

    if (input.waIdentity && input.waIdentity.startsWith("tiktok:")) {
      return input.waIdentity.replace(/^tiktok:/, "");
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
    const creds = await resolveTikTokCreds(admin, {
      organizationId: input.organizationId,
      businessId: input.sessionRef,
    });

    if (!creds) {
      return { reachable: false, status: null, detail: "sem_credencial_para_o_tiktok" };
    }

    try {
      const info = await tiktokGetBusinessInfo(creds.token, creds.businessId);
      return {
        reachable: true,
        status: info.business_id ? "WORKING" : "FAILED",
        detail: info.display_name ?? null,
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
    const creds = await resolveTikTokCreds(admin, {
      organizationId: envelope.organizationId,
      businessId: envelope.sessionRef,
    });

    if (!creds) {
      throw new Error(NAO_CONFIGURADO);
    }

    if (envelope.beforeSend) {
      await envelope.beforeSend();
    }

    const res = await tiktokSendMessage(
      creds.token,
      creds.businessId,
      envelope.to,
      envelope.body ?? "",
    );

    return { externalId: res.messageId };
  },

  codes: {
    notConfigured: NAO_CONFIGURADO,
    sendFailed: "tiktok_send_failed",
    unknownError: "tiktok_unknown_error",
  },
};
