import { randomUUID } from "node:crypto";
import { emailConfigurado, sendEmail } from "@/lib/email/roteador";
import type {
  ChannelAdapter,
  ChannelHealth,
  ChannelTenantScope,
  OutboundEnvelope,
  RecipientInput,
} from "../types";

const NAO_CONFIGURADO = "email_not_configured";

export const emailAdapter: ChannelAdapter = {
  provider: "email",

  resolveRecipient(input: RecipientInput): string | null {
    if (input.groupChatId) return null;

    if (input.waIdentity && input.waIdentity.startsWith("email:")) {
      return input.waIdentity.replace(/^email:/, "").trim().toLowerCase();
    }

    if (input.phoneNumber && input.phoneNumber.includes("@")) {
      return input.phoneNumber.trim().toLowerCase();
    }

    return null;
  },

  isConfigured(): boolean {
    return true;
  },

  async checkHealth(
    _input: ChannelTenantScope & { sessionRef: string },
  ): Promise<ChannelHealth> {
    const configurado = await emailConfigurado();
    return {
      reachable: true,
      status: configurado ? "WORKING" : "FAILED",
      detail: configurado ? "transporte_ativo" : "transporte_nao_configurado",
    };
  },

  codes: {
    notConfigured: NAO_CONFIGURADO,
    sendFailed: "email_send_failed",
    unknownError: "email_unknown",
  },

  async send(envelope: OutboundEnvelope): Promise<{ externalId: string | null }> {
    const configurado = await emailConfigurado();
    if (!configurado) {
      throw new Error(`${NAO_CONFIGURADO}: nenhum transporte de e-mail (SMTP ou Resend) configurado.`);
    }

    const to = envelope.to;
    if (!to || !to.includes("@")) {
      throw new Error("email_recipient_invalid: endereço de e-mail do destinatário inválido.");
    }

    const rawBody = envelope.body || "";
    let subject = "Atendimento";
    let bodyText = rawBody;

    const matchSubject = rawBody.match(/^Assunto:\s*([^\n]+)\n\n([\s\S]*)$/i);
    if (matchSubject && matchSubject[1]) {
      subject = matchSubject[1].trim();
      bodyText = matchSubject[2] || "";
    }

    const res = await sendEmail({
      to,
      subject,
      text: bodyText,
      html: `<div style="font-family: sans-serif; line-height: 1.5; color: #333;">${bodyText.replace(/\n/g, "<br />")}</div>`,
    });

    if (!res.ok) {
      throw new Error(`email_send_failed: ${res.error || "erro_desconhecido"}`);
    }

    return {
      externalId: res.id || `email_${randomUUID()}`,
    };
  },
};
