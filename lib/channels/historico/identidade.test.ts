import { describe, expect, it } from "vitest";
import type { WahaPayload } from "@/lib/waha/envelope";
import { validarIdentidadeDaConversa } from "./identidade";

const msg = (overrides: Partial<WahaPayload> = {}) => ({
  id: "false_5511999999999@c.us_A1",
  from: "5511999999999@c.us",
  to: "5511888888888@c.us",
  fromMe: false,
  timestamp: 1_797_000_000,
  ...overrides,
}) as WahaPayload;

describe("identidade de conversa histórica", () => {
  it("aceita direct chat por telefone, incluindo o endereço no id composto", () => {
    expect(validarIdentidadeDaConversa({
      chatId: "5511999999999@c.us",
      messages: [msg()],
      localPhone: "+5511888888888",
    })).toMatchObject({ verdict: "IDENTITY_VALID", phone: "+5511999999999" });
  });

  it("aceita LID quando o WAHA confirma o telefone alternativo", () => {
    const lidMessage = msg({
      id: "false_123456789@lid_A2",
      from: "123456789@lid",
      to: "5511888888888@c.us",
      _data: { key: { remoteJid: "123456789@lid", remoteJidAlt: "5511999999999@c.us" } },
    });
    expect(validarIdentidadeDaConversa({
      chatId: "123456789@lid",
      messages: [lidMessage],
      resolvedPhone: "+5511999999999",
      localPhone: "+5511888888888",
    })).toMatchObject({ verdict: "IDENTITY_VALID", phone: "+5511999999999", lid: "123456789" });
  });

  it("aceita LID sem telefone conhecido quando todas as mensagens conservam o mesmo LID", () => {
    const lidMessage = msg({
      id: "true_123456789@lid_A3",
      from: "123456789@lid",
      to: "5511888888888@c.us",
      fromMe: true,
      _data: { key: { remoteJid: "123456789@lid" } },
    });
    expect(validarIdentidadeDaConversa({
      chatId: "123456789@lid",
      messages: [lidMessage],
      localPhone: "+5511888888888",
    }).verdict).toBe("IDENTITY_VALID");
  });

  it("valida o destinatário remoto de mensagem enviada mesmo sem telefone local cadastrado", () => {
    const outgoing = msg({
      id: "true_5511999999999@c.us_A3",
      from: "5511888888888@c.us",
      to: "5511999999999@c.us",
      fromMe: true,
    });
    expect(validarIdentidadeDaConversa({ chatId: "5511999999999@c.us", messages: [outgoing] }).verdict)
      .toBe("IDENTITY_VALID");
  });

  it("recusa a conversa inteira se uma mensagem apontar para outra pessoa", () => {
    const mismatched = msg({
      id: "false_5511666666666@c.us_A4",
      from: "5511666666666@c.us",
    });
    expect(validarIdentidadeDaConversa({
      chatId: "5511999999999@c.us",
      messages: [msg(), mismatched],
      localPhone: "+5511888888888",
    }).verdict).toBe("IDENTITY_MISMATCH");
  });

  it("falha fechado para identidade ausente, JID malformado ou grupo", () => {
    expect(validarIdentidadeDaConversa({ chatId: "5511999999999@c.us", messages: [msg({ from: null, to: null, id: "bare" })] }).verdict)
      .toBe("IDENTITY_AMBIGUOUS");
    expect(validarIdentidadeDaConversa({ chatId: "5511999999999abc@c.us", messages: [msg()] }).verdict)
      .toBe("IDENTITY_AMBIGUOUS");
    expect(validarIdentidadeDaConversa({ chatId: "120363@g.us", messages: [msg()] }).verdict)
      .toBe("IDENTITY_AMBIGUOUS");
  });
});
