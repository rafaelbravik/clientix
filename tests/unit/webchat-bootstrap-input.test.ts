import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { POST } from "@/app/api/v1/widget/bootstrap/route";

describe("bootstrap WebChat não aceita ownership fornecida pelo navegador", () => {
  it("recusa organization_id extra em vez de derivar tenant do body", async () => {
    const req = new NextRequest("http://localhost/api/v1/widget/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        widget_public_id: "aaaaaaaa-1111-4111-8111-111111111111",
        organization_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      }),
    });

    const response = await POST(req);
    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe("validation_failed");
  });

  it("recusa identificador de widget inválido", async () => {
    const req = new NextRequest("http://localhost/api/v1/widget/bootstrap", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ widget_public_id: "not-a-uuid" }),
    });

    const response = await POST(req);
    expect(response.status).toBe(422);
  });
});
