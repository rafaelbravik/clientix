import { describe, expect, it } from "vitest";

import {
  componentesDeTemplateMetaSchema,
  midiaDeTemplatePermitida,
} from "./template-input";

const BASE_SUPABASE = "https://storage.clientix.test";
const ORG = "11111111-1111-4111-8111-111111111111";
const BODY = { type: "BODY", text: "Mensagem aprovada" };

describe("entrada de templates Meta oficiais", () => {
  it("aceita somente a composição construída pelo formulário Clientix", () => {
    expect(
      componentesDeTemplateMetaSchema.safeParse([
        { type: "HEADER", format: "TEXT", text: "Olá" },
        { type: "BODY", text: "Oi {{1}}", example: { body_text: [["Ana"]] } },
        { type: "FOOTER", text: "Equipe" },
        { type: "BUTTONS", buttons: [{ type: "QUICK_REPLY", text: "Confirmar" }] },
      ]).success,
    ).toBe(true);
  });

  it.each([
    { components: [{ type: "BODY", text: "Texto" }, { type: "CAROUSEL", cards: [] }] },
    { components: [{ type: "BODY", text: "Texto", internal_id: "nao-permitido" }] },
    { components: [{ type: "BODY", text: "Texto" }, { type: "BODY", text: "Duplicado" }] },
    { components: [{ type: "BODY", text: "Texto" }, { type: "BUTTONS", buttons: [{ type: "FLOW", text: "Abrir" }] }] },
  ])("rejeita componente desconhecido, campo arbitrário ou repetido: %j", ({ components }) => {
    expect(componentesDeTemplateMetaSchema.safeParse(components).success).toBe(false);
  });

  it("aceita imagem somente pela URL assinada do bucket privado e tenant correto", () => {
    const components = [
      { type: "HEADER", format: "IMAGE", example: { header_handle: [`${BASE_SUPABASE}/storage/v1/object/sign/whatsapp-media/${ORG}/templates/22222222-2222-4222-8222-222222222222.png?token=assinatura`] } },
      BODY,
    ];
    expect(midiaDeTemplatePermitida({ components, organizationId: ORG, supabaseUrl: BASE_SUPABASE, acao: "criar" })).toBe(true);
  });

  it("recusa URL externa, path de outro tenant e URL sem assinatura", () => {
    const handles = [
      "https://attacker.test/photo.png",
      `${BASE_SUPABASE}/storage/v1/object/sign/whatsapp-media/22222222-2222-4222-8222-222222222222/templates/33333333-3333-4333-8333-333333333333.png?token=assinatura`,
      `${BASE_SUPABASE}/storage/v1/object/sign/whatsapp-media/${ORG}/templates/22222222-2222-4222-8222-222222222222.png`,
    ];
    for (const handle of handles) {
      const components = [{ type: "HEADER", format: "IMAGE", example: { header_handle: [handle] } }, BODY];
      expect(midiaDeTemplatePermitida({ components, organizationId: ORG, supabaseUrl: BASE_SUPABASE, acao: "criar" })).toBe(false);
    }
  });

  it("edição só mantém handle opaco que já consta no espelho", () => {
    const components = [{ type: "HEADER", format: "IMAGE", example: { header_handle: ["meta-handle-existente"] } }, BODY];
    expect(midiaDeTemplatePermitida({
      components,
      organizationId: ORG,
      supabaseUrl: BASE_SUPABASE,
      acao: "editar",
      handlesExistentes: ["meta-handle-existente"],
    })).toBe(true);
    expect(midiaDeTemplatePermitida({ components, organizationId: ORG, supabaseUrl: BASE_SUPABASE, acao: "editar" })).toBe(false);
  });
});
