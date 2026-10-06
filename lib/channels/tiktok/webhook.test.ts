import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyTikTokSignature } from "./webhook";

describe("verifyTikTokSignature", () => {
  const secret = "test_tiktok_webhook_secret_key_123456";
  const rawBody = JSON.stringify({ event: "message", text: "Olá mundo" });

  it("aceita assinatura válida com timestamp recente", () => {
    const now = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret).update(`${now}.${rawBody}`, "utf8").digest("hex");
    const header = `t=${now},s=${signature}`;

    const ok = verifyTikTokSignature(rawBody, header, secret);
    expect(ok).toBe(true);
  });

  it("recusa se a assinatura for incorreta", () => {
    const now = Math.floor(Date.now() / 1000);
    const header = `t=${now},s=0000000000000000000000000000000000000000000000000000000000000000`;

    const ok = verifyTikTokSignature(rawBody, header, secret);
    expect(ok).toBe(false);
  });

  it("recusa se o timestamp for mais antigo que a tolerância de 300s (anti-replay)", () => {
    const oldTime = Math.floor(Date.now() / 1000) - 301;
    const signature = createHmac("sha256", secret).update(`${oldTime}.${rawBody}`, "utf8").digest("hex");
    const header = `t=${oldTime},s=${signature}`;

    const ok = verifyTikTokSignature(rawBody, header, secret);
    expect(ok).toBe(false);
  });

  it("recusa se o body tiver sido adulterado", () => {
    const now = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret).update(`${now}.${rawBody}`, "utf8").digest("hex");
    const header = `t=${now},s=${signature}`;

    const ok = verifyTikTokSignature(rawBody + " ", header, secret);
    expect(ok).toBe(false);
  });

  it("recusa se o segredo for vazio ou nulo", () => {
    const now = Math.floor(Date.now() / 1000);
    const signature = createHmac("sha256", secret).update(`${now}.${rawBody}`, "utf8").digest("hex");
    const header = `t=${now},s=${signature}`;

    expect(verifyTikTokSignature(rawBody, header, "")).toBe(false);
    expect(verifyTikTokSignature(rawBody, null, secret)).toBe(false);
  });
});
