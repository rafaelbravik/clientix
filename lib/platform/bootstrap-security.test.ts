import { describe, expect, it } from "vitest";
import { bootstrapTokenMatches, isSameOrigin, setupRateLimitSubjectHash } from "./bootstrap-security";

describe("segurança do bootstrap da plataforma", () => {
  it("aceita token configurado e rejeita token incorreto ou curto", () => {
    const token = "a".repeat(64);
    expect(bootstrapTokenMatches(token, token)).toBe(true);
    expect(bootstrapTokenMatches("b".repeat(64), token)).toBe(false);
    expect(bootstrapTokenMatches(token, "curto")).toBe(false);
  });

  it("não guarda o endereço cru no identificador do rate limit", () => {
    const hash = setupRateLimitSubjectHash("192.0.2.10");
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("192.0.2.10");
    expect(setupRateLimitSubjectHash("192.0.2.10")).toBe(hash);
    expect(setupRateLimitSubjectHash(null)).not.toBe(hash);
  });

  it("recusa origem cruzada e origem ausente", () => {
    expect(isSameOrigin("https://crm.example", "https://crm.example/setup")).toBe(true);
    expect(isSameOrigin("https://crm.example.attacker", "https://crm.example/setup")).toBe(false);
    expect(isSameOrigin(null, "https://crm.example/setup")).toBe(false);
  });
});
