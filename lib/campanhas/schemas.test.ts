import { describe, expect, it } from "vitest";

import { criarCampanhaSchema, editarCampanhaSchema, splitDeCampanhaCompativel } from "./schemas";

const BASE = {
  name: "QA — campanha",
  channel_session_id: "aaaaaaaa-1111-4111-8111-111111111111",
  message_body: "Olá",
  base_legal: "consent" as const,
};

describe("split_messages de campanhas", () => {
  it("usa false como default e permite balões em WhatsApp", () => {
    const padrao = criarCampanhaSchema.safeParse(BASE);
    const ligada = criarCampanhaSchema.safeParse({ ...BASE, split_messages: true });

    expect(padrao.success && padrao.data.split_messages).toBe(false);
    expect(ligada.success).toBe(true);
  });

  it("recusa configuração de balões para Telegram/e-mail", () => {
    expect(criarCampanhaSchema.safeParse({ ...BASE, channel: "telegram", split_messages: true }).success).toBe(false);
    expect(criarCampanhaSchema.safeParse({ ...BASE, channel: "email", email_subject: "Assunto", split_messages: true }).success).toBe(false);
    expect(editarCampanhaSchema.safeParse({ channel: "telegram", split_messages: true }).success).toBe(false);
  });

  it("valida o estado efetivo quando um PATCH omite o canal salvo", () => {
    expect(splitDeCampanhaCompativel("whatsapp", true)).toBe(true);
    expect(splitDeCampanhaCompativel("telegram", true)).toBe(false);
    expect(splitDeCampanhaCompativel("email", false)).toBe(true);
  });
});
