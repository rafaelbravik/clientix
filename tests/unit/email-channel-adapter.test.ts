import { describe, it, expect } from "vitest";
import { emailAdapter } from "@/lib/channels/adapters/email";
import { CHANNEL_CAPABILITIES, CHANNEL_PROVIDER_EMAIL } from "@/lib/channels/capabilities";
import { resolveSessionRef } from "@/lib/channels/session-ref";
import { CANAIS_DE_CONVERSA, ehCanalDeConversa } from "@/lib/channels/canais-de-conversa";
import { verifyInboundWebhookSignature, acceptsInboundWebhook } from "@/lib/channels/inbound";
import { parseEmailAddress } from "@/lib/channels/email/ingest";

describe("Canal E-mail no Inbox - Adapter e Configurações", () => {
  it("deve resolver destinatário para endereço de e-mail válido", () => {
    expect(
      emailAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "cliente@dominio.com.br",
        waIdentity: null,
      }),
    ).toBe("cliente@dominio.com.br");

    expect(
      emailAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: "email:suporte@cliente.com",
      }),
    ).toBe("suporte@cliente.com");

    expect(
      emailAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "11999999999", // Não é e-mail
        waIdentity: null,
      }),
    ).toBeNull();

    expect(
      emailAdapter.resolveRecipient({
        isGroup: true,
        groupChatId: "grupo123",
        phoneNumber: null,
        waIdentity: null,
      }),
    ).toBeNull();
  });

  it("deve possuir capabilities condizentes com o canal de E-mail", () => {
    const caps = CHANNEL_CAPABILITIES.email;
    expect(caps).toBeDefined();
    expect(caps.freeformOutsideWindow).toBe(true);
    expect(caps.requiresTemplates).toBe(false);
    expect(caps.canManageTemplates).toBe(false);
    expect(caps.banRisk).toBe(false);
    expect(caps.costPerMessage).toBe(false);
    expect(caps.alteraMensagemEnviada).toBe(false);
  });

  it("deve reconhecer email como canal de conversa válido", () => {
    expect(CANAIS_DE_CONVERSA).toContain("email");
    expect(ehCanalDeConversa("email")).toBe(true);
  });

  it("deve resolver sessionRef a partir de email_address", () => {
    const ref = resolveSessionRef({
      provider: "email",
      email_address: "atendimento@empresa.com.br",
    });
    expect(ref).toBe("atendimento@empresa.com.br");
  });

  it("deve fazer parse correto do formato de remetente de e-mail (Nome + Endereço)", () => {
    const r1 = parseEmailAddress("Rafael Bravik <rafael@empresa.com.br>");
    expect(r1.name).toBe("Rafael Bravik");
    expect(r1.email).toBe("rafael@empresa.com.br");

    const r2 = parseEmailAddress('"Maria Souza" <maria@dominio.com>');
    expect(r2.name).toBe("Maria Souza");
    expect(r2.email).toBe("maria@dominio.com");

    const r3 = parseEmailAddress("simples@dominio.com");
    expect(r3.name).toBe("simples@dominio.com");
    expect(r3.email).toBe("simples@dominio.com");
  });

  it("deve validar assinatura/segredo do webhook de entrada de e-mail", () => {
    expect(acceptsInboundWebhook("email")).toBe(true);

    const secretValido = "secret_webhook_email_token_123456";
    const headersCorretos = new Headers({
      "x-webhook-secret": secretValido,
    });
    const headersErrados = new Headers({
      "x-webhook-secret": "secret_incorreto_xyz",
    });

    expect(
      verifyInboundWebhookSignature("email", "{}", headersCorretos, secretValido),
    ).toBe(true);

    expect(
      verifyInboundWebhookSignature("email", "{}", headersErrados, secretValido),
    ).toBe(false);

    // Se a sessão não tiver segredo configurado, deve rejeitar (fail-closed conforme regra de segurança)
    expect(
      verifyInboundWebhookSignature("email", "{}", new Headers(), null),
    ).toBe(false);
  });
});
