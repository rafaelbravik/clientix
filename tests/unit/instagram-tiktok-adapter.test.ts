import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { instagramAdapter } from "@/lib/channels/adapters/instagram";
import { tiktokAdapter } from "@/lib/channels/adapters/tiktok";
import { matchCommentRule, type CommentRule } from "@/lib/channels/instagram/comment-to-dm";
import { capabilitiesOf } from "@/lib/channels/capabilities";
import { resolveSessionRef } from "@/lib/channels/session-ref";
import { ehCanalDeConversa } from "@/lib/channels/canais-de-conversa";

describe("Etapa 6: Instagram Direct & TikTok Messaging", () => {
  describe("Capabilities & Session Ref", () => {
    it("deve retornar capabilities corretas para Instagram e TikTok", () => {
      const capsInsta = capabilitiesOf("instagram");
      expect(capsInsta.freeformOutsideWindow).toBe(false);
      expect(capsInsta.requiresTemplates).toBe(false);
      expect(capsInsta.groups).toBe("none");

      const capsTiktok = capabilitiesOf("tiktok");
      expect(capsTiktok.freeformOutsideWindow).toBe(false);
      expect(capsTiktok.requiresTemplates).toBe(false);
      expect(capsTiktok.groups).toBe("none");
    });

    it("deve resolver sessionRef de Instagram e TikTok", () => {
      expect(
        resolveSessionRef({ provider: "instagram", instagram_account_id: "ig_12345" }),
      ).toBe("ig_12345");

      expect(
        resolveSessionRef({ provider: "tiktok", tiktok_business_id: "tt_67890" }),
      ).toBe("tt_67890");
    });

    it("deve reconhecer instagram e tiktok como canais de conversa válidos", () => {
      expect(ehCanalDeConversa("instagram")).toBe(true);
      expect(ehCanalDeConversa("tiktok")).toBe(true);
      expect(ehCanalDeConversa("invalido")).toBe(false);
    });
  });

  describe("Instagram Adapter - resolveRecipient", () => {
    it("deve extrair recipient do waIdentity prefixado com instagram:", () => {
      const res = instagramAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: "instagram:178414000123456",
      });
      expect(res).toBe("178414000123456");
    });

    it("deve extrair recipient de phoneNumber numérico se waIdentity for nulo", () => {
      const res = instagramAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: "987654321",
        waIdentity: null,
      });
      expect(res).toBe("987654321");
    });

    it("deve retornar null para grupos", () => {
      const res = instagramAdapter.resolveRecipient({
        isGroup: true,
        groupChatId: "group_123",
        phoneNumber: null,
        waIdentity: null,
      });
      expect(res).toBeNull();
    });
  });

  describe("TikTok Adapter - resolveRecipient", () => {
    it("deve extrair recipient do waIdentity prefixado com tiktok:", () => {
      const res = tiktokAdapter.resolveRecipient({
        isGroup: false,
        groupChatId: null,
        phoneNumber: null,
        waIdentity: "tiktok:user_tt_9999",
      });
      expect(res).toBe("user_tt_9999");
    });

    it("deve retornar null para grupos", () => {
      const res = tiktokAdapter.resolveRecipient({
        isGroup: true,
        groupChatId: "group_tt",
        phoneNumber: null,
        waIdentity: null,
      });
      expect(res).toBeNull();
    });
  });

  describe("Automação Comment-to-DM (matchCommentRule)", () => {
    const baseRule: CommentRule = {
      id: "rule-1",
      name: "Promoção Quero",
      active: true,
      post_id: null,
      keyword_mode: "contains",
      keywords: ["quero", "eu quero", "preço"],
      reply_comment: "Te mandei no direct! 🚀",
      dm_message: "Olá! Vi seu comentário no post. Aqui está o link com desconto: https://empresa.com",
      agent_id: "agent-123",
    };

    it("deve dar match quando o comentário contém uma das palavras-chave (contains)", () => {
      expect(matchCommentRule(baseRule, "post_1", "Eu quero saber mais sobre isso")).toBe(true);
      expect(matchCommentRule(baseRule, "post_1", "qual o PREÇO?")).toBe(true);
      expect(matchCommentRule(baseRule, "post_1", "Parabéns pelo post lindo")).toBe(false);
    });

    it("deve respeitar modo exact", () => {
      const exactRule: CommentRule = {
        ...baseRule,
        keyword_mode: "exact",
        keywords: ["quero", "cupom"],
      };

      expect(matchCommentRule(exactRule, "post_1", "quero")).toBe(true);
      expect(matchCommentRule(exactRule, "post_1", "  QUERO  ")).toBe(true);
      expect(matchCommentRule(exactRule, "post_1", "eu quero")).toBe(false);
    });

    it("deve disparar para qualquer comentário quando keyword_mode for any", () => {
      const anyRule: CommentRule = {
        ...baseRule,
        keyword_mode: "any",
        keywords: [],
      };

      expect(matchCommentRule(anyRule, "post_1", "qualquer coisa")).toBe(true);
      expect(matchCommentRule(anyRule, "post_1", "🔥🔥🔥")).toBe(true);
    });

    it("deve rejeitar se post_id for especificado e não casar", () => {
      const specificPostRule: CommentRule = {
        ...baseRule,
        post_id: "post_especifico_123",
      };

      expect(matchCommentRule(specificPostRule, "post_especifico_123", "quero")).toBe(true);
      expect(matchCommentRule(specificPostRule, "outro_post_456", "quero")).toBe(false);
    });

    it("deve rejeitar se a regra estiver inativa", () => {
      const inactiveRule: CommentRule = {
        ...baseRule,
        active: false,
      };

      expect(matchCommentRule(inactiveRule, "post_1", "quero")).toBe(false);
    });
  });
});
