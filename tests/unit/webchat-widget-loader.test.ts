import { describe, expect, it } from "vitest";

import { GET } from "@/app/chat/widget.js/route";
import { isPublicPath } from "@/lib/auth/public-paths";

describe("contrato do loader público WebChat", () => {
  it("serve JavaScript compatível sem credenciais e usa somente o ID público", async () => {
    const response = GET();
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/javascript");
    expect(body).toContain("script.dataset.widgetId");
    expect(body).toContain("/chat/embed/");
    expect(body).toContain("/^[0-9a-f]{8}-");
    expect(body).not.toMatch(/SUPABASE_SERVICE_ROLE_KEY|INTERNAL_CRON_SECRET|Bearer\s|private.?key/i);
  });

  it("permite a porta pública do iframe e mantém a API sob o guard interno", () => {
    expect(isPublicPath("/chat/widget.js")).toBe(true);
    expect(isPublicPath("/chat/embed/aaaaaaaa-1111-4111-8111-111111111111")).toBe(true);
    expect(isPublicPath("/chat/embed/not-a-uuid")).toBe(false);
    expect(isPublicPath("/api/v1/widget/bootstrap")).toBe(true);
  });
});
