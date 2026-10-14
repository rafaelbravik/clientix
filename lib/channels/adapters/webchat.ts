import { randomUUID } from "node:crypto";

import { CHANNEL_PROVIDER_WEBCHAT } from "../capabilities";
import { createAdminClient } from "@/lib/supabase/admin";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";

type SessionQuery = {
  eq(column: string, value: string): SessionQuery;
  is(column: string, value: null): SessionQuery;
  maybeSingle(): PromiseLike<{
    data: unknown;
    error: { message: string } | null;
  }>;
};

async function carregarSessao(input: ChannelTenantScope & { sessionRef: string }) {
  const admin = createAdminClient();
  const query = admin
    .from("channel_sessions")
    .select("id, status")
    .eq("organization_id", input.organizationId) as unknown as SessionQuery;
  const result = await query
    .eq("provider", CHANNEL_PROVIDER_WEBCHAT)
    .eq("webchat_public_id", input.sessionRef)
    .is("archived_at", null)
    .maybeSingle();

  if (result.error) return null;
  return result.data as { id: string; status: string } | null;
}

export const webchatAdapter: ChannelAdapter = {
  provider: CHANNEL_PROVIDER_WEBCHAT,

  resolveRecipient(input: RecipientInput): string | null {
    return input.providerConversationId ?? null;
  },

  isConfigured(): boolean {
    return true;
  },

  async checkHealth(
    input: ChannelTenantScope & { sessionRef: string },
  ): Promise<ChannelHealth> {
    const session = await carregarSessao(input);
    if (!session) return { reachable: false, status: null, detail: "sessao_webchat_ausente" };
    return {
      reachable: true,
      status: session.status,
      detail: session.status === "WORKING" ? "widget_habilitado" : "widget_desabilitado",
    };
  },

  codes: {
    notConfigured: "webchat_not_configured",
    sendFailed: "webchat_send_failed",
    unknownError: "webchat_unknown",
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    if (!envelope.providerConversationId || !envelope.to) {
      throw new Error("webchat_recipient_unavailable");
    }
    if (envelope.kind !== "text" || !envelope.body) {
      throw new Error("webchat_text_only");
    }

    await envelope.beforeSend?.();
    const session = await carregarSessao({
      organizationId: envelope.organizationId,
      sessionRef: envelope.sessionRef,
    });
    if (!session) throw new Error("webchat_not_configured");
    if (session.status !== "WORKING") throw new Error("webchat_disabled");

    // O handler central já persistiu a linha outbound em messages. O visitante
    // a recebe pelo polling da sua conversa; nenhum transporte externo é chamado.
    return {
      externalId: `webchat:${envelope.providerConversationId}:${randomUUID()}`,
    };
  },

  async sendTemplate(): Promise<{ externalId: string | null }> {
    throw new Error("webchat_template_not_supported");
  },
};
