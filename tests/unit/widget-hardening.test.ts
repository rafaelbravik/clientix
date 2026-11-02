import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/api/v1/widget/chat/route";
import { POST } from "@/app/api/v1/widget/chat/messages/route";
import { gerarTokenDeAcessoWidget } from "@/lib/chat-widget/token";
import { __limparMemoriaRateLimitParaTeste } from "@/lib/ai/dispatcher/rate-limit";

const cookieSecurity = vi.hoisted(() => ({ fn: vi.fn(() => false) }));
vi.mock("@/lib/supabase/cookie-secure", () => ({ cookieSecure: cookieSecurity.fn }));

const ORG_A = "org-aaaa-1111-2222-333333333333";
const ORG_B = "org-bbbb-1111-2222-333333333333";
const CONV_A = "conv-aaaa-1111-2222-333333333333";
const CONV_B = "conv-bbbb-1111-2222-333333333333";
const WIDGET_A = "aaaaaaaa-1111-4111-8111-111111111111";
const WIDGET_B = "bbbbbbbb-2222-4222-8222-222222222222";

let capturedInserts: Record<string, unknown>[] = [];
let capturedUpdates: Record<string, unknown>[] = [];
let selectedMessageColumns: string[] = [];
let selectedInsertedMessageColumns: string[] = [];
let rpcCalls: string[] = [];
let mockedProvider = "waha";
let mockedWidgetPublicId: string | null = null;
let mockedSessionStatus = "WORKING";

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: (table: string) => {
      if (table === "conversations") {
        return {
          select: () => ({
            eq: (col1: string, val1: string) => ({
              eq: (col2: string, val2: string) => ({
                maybeSingle: async () => {
                  // Simula banco com isolamento por conversationId e organizationId
                  if (val1 === CONV_A && val2 === ORG_A) {
                    return {
                      data: {
                        id: CONV_A,
                        organization_id: ORG_A,
                        protocolo: "PROT-ORG-A-001",
                        status: "open",
                        contact_id: "contact-a",
                        channel_session_id: "channel-a",
                        contacts: { id: "contact-a", display_name: "Cliente A", name: "Cliente A" },
                        channel_sessions: {
                          display_name: "Canal A",
                          provider: mockedProvider,
                          status: mockedSessionStatus,
                          webchat_public_id: mockedWidgetPublicId,
                          archived_at: null,
                        },
                      },
                      error: null,
                    };
                  }
                  if (val1 === CONV_B && val2 === ORG_B) {
                    return {
                      data: {
                        id: CONV_B,
                        organization_id: ORG_B,
                        protocolo: "PROT-ORG-B-002",
                        status: "open",
                        contact_id: "contact-b",
                        channel_session_id: "channel-b",
                        contacts: { id: "contact-b", display_name: "Cliente B", name: "Cliente B" },
                        channel_sessions: {
                          display_name: "Canal B",
                          provider: mockedProvider,
                          status: mockedSessionStatus,
                          webchat_public_id: mockedWidgetPublicId,
                          archived_at: null,
                        },
                      },
                      error: null,
                    };
                  }
                  return { data: null, error: null };
                },
              }),
            }),
          }),
          update: (fields: Record<string, unknown>) => {
            capturedUpdates.push(fields);
            return {
              eq: () => ({
                eq: async () => ({ error: null }),
              }),
            };
          },
        };
      }
      if (table === "organizations") {
        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({
                data: {
                  name: "Empresa Teste",
                  settings: { branding: { app_name: "Atendimento Pro", accent_color: "#10b981" } },
                },
                error: null,
              }),
            }),
          }),
        };
      }
      if (table === "messages") {
        return {
          select: (columns: string) => {
            selectedMessageColumns.push(columns);
            return {
              eq: () => ({
                eq: () => ({
                  order: () => ({
                    limit: async () => ({
                      data: [
                        {
                          id: "msg-1",
                          direction: "inbound",
                          body: "Mensagem anterior",
                          kind: "text",
                          sent_at: new Date().toISOString(),
                          status: "delivered",
                        },
                      ],
                      error: null,
                    }),
                  }),
                }),
              }),
            };
          },
          insert: (row: Record<string, unknown>) => {
            capturedInserts.push(row);
            return {
              select: (columns: string) => {
                selectedInsertedMessageColumns.push(columns);
                return {
                  single: async () => ({
                    data: {
                      id: row.id,
                      direction: row.direction,
                      body: row.body,
                      kind: row.type,
                      sent_at: row.sent_at,
                      status: row.status,
                    },
                    error: null,
                  }),
                };
              },
            };
          },
        };
      }
      return {};
    },
    rpc: async (fn: string) => {
      rpcCalls.push(fn);
      return { data: null, error: null };
    },
  }),
}));

describe("AUD-02: Web Widget Hardening & RLS Cross-Tenant Suite", () => {
  beforeEach(() => {
    capturedInserts = [];
    capturedUpdates = [];
    selectedMessageColumns = [];
    selectedInsertedMessageColumns = [];
    rpcCalls = [];
    mockedProvider = "waha";
    mockedWidgetPublicId = null;
    mockedSessionStatus = "WORKING";
    cookieSecurity.fn.mockReset();
    cookieSecurity.fn.mockReturnValue(false);
    __limparMemoriaRateLimitParaTeste();
  });

  it("1. GET /api/v1/widget/chat aceita token via Authorization: Bearer e injeta cookie HttpOnly", async () => {
    const token = gerarTokenDeAcessoWidget(CONV_A, ORG_A);

    const req = new NextRequest("http://localhost/api/v1/widget/chat", {
      method: "GET",
      headers: {
        authorization: `Bearer ${token}`,
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.conversation.id).toBe(CONV_A);
    expect(json.data.conversation.protocolo).toBe("PROT-ORG-A-001");
    expect(selectedMessageColumns[0]).toContain("kind:type");

    // Verifica que o cookie HttpOnly foi devidamente configurado na resposta
    const setCookie = res.headers.get("set-cookie");
    expect(setCookie).toBeDefined();
    expect(setCookie).toContain("__clientix_widget=");
    expect(setCookie?.toLowerCase()).toContain("httponly");
    expect(setCookie?.toLowerCase()).toContain("samesite=lax");
    expect(setCookie?.toLowerCase()).not.toContain("; secure");
    expect(cookieSecurity.fn).toHaveBeenCalledOnce();
  });

  it("configura Secure no cookie do widget conforme o ingress HTTPS canônico", async () => {
    cookieSecurity.fn.mockReturnValue(true);
    const token = gerarTokenDeAcessoWidget(CONV_A, ORG_A);
    const req = new NextRequest("https://clientix.example/api/v1/widget/chat", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });

    const res = await GET(req);

    expect(res.status).toBe(200);
    expect(res.headers.get("set-cookie")?.toLowerCase()).toContain("; secure");
    expect(cookieSecurity.fn).toHaveBeenCalledOnce();
  });

  it("2. GET /api/v1/widget/chat aceita autenticação via cookie HttpOnly (após limpeza de URL)", async () => {
    const token = gerarTokenDeAcessoWidget(CONV_A, ORG_A);

    const req = new NextRequest("http://localhost/api/v1/widget/chat", {
      method: "GET",
      headers: {
        cookie: `__clientix_widget=${token}`,
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.conversation.id).toBe(CONV_A);
  });

  it("3. GET /api/v1/widget/chat mantém compatibilidade com links antigos via query string", async () => {
    const token = gerarTokenDeAcessoWidget(CONV_A, ORG_A);

    const req = new NextRequest(`http://localhost/api/v1/widget/chat?token=${token}`, {
      method: "GET",
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.conversation.id).toBe(CONV_A);
  });

  it("3.1 tokens WebChat curtos não são aceitos em query string", async () => {
    mockedProvider = "webchat";
    mockedWidgetPublicId = WIDGET_A;
    const token = gerarTokenDeAcessoWidget(CONV_A, ORG_A, { widgetPublicId: WIDGET_A });

    const req = new NextRequest(`http://localhost/api/v1/widget/chat?token=${token}`, {
      method: "GET",
    });

    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("4. Rejeição de tokens inválidos ou adulterados", async () => {
    const token = gerarTokenDeAcessoWidget(CONV_A, ORG_A);
    const adulterado = token.slice(0, -6) + "xxxxxx";

    const req = new NextRequest("http://localhost/api/v1/widget/chat", {
      method: "GET",
      headers: {
        authorization: `Bearer ${adulterado}`,
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(401);
  });

  it("5. Isolamento Cross-Tenant Estrito: Token da Org A NÃO consegue acessar dados da Org B", async () => {
    // Gera token forjando conversa B mas assinado para Org A
    const tokenCruzado = gerarTokenDeAcessoWidget(CONV_B, ORG_A);

    const req = new NextRequest("http://localhost/api/v1/widget/chat", {
      method: "GET",
      headers: {
        authorization: `Bearer ${tokenCruzado}`,
      },
    });

    const res = await GET(req);
    // Deve retornar 404 porque no banco a CONV_B pertence à ORG_B, não à ORG_A
    expect(res.status).toBe(404);
  });

  it("6. POST /messages com payload legítimo funciona via Bearer e chama fn_service_inbound", async () => {
    const token = gerarTokenDeAcessoWidget(CONV_A, ORG_A);

    const req = new NextRequest("http://localhost/api/v1/widget/chat/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ body: "Olá, suporte!" }),
    });

    const res = await POST(req);
    expect(res.status).toBe(200);
    expect(capturedInserts.length).toBe(1);
    expect(capturedInserts[0]?.body).toBe("Olá, suporte!");
    expect(capturedInserts[0]?.type).toBe("text");
    expect(capturedInserts[0]).not.toHaveProperty("kind");
    expect(selectedInsertedMessageColumns[0]).toContain("kind:type");
    expect(capturedInserts[0]?.organization_id).toBe(ORG_A);
    expect(capturedInserts[0]?.conversation_id).toBe(CONV_A);
    expect(rpcCalls).toContain("fn_service_inbound");
  });

  it("7. Rate limit: Protege contra flood de mensagens disparando 429 Too Many Requests", async () => {
    const token = gerarTokenDeAcessoWidget(CONV_A, ORG_A);

    // Envia 20 mensagens (limite da janela)
    for (let i = 0; i < 20; i++) {
      const req = new NextRequest("http://localhost/api/v1/widget/chat/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ body: `Mensagem ${i}` }),
      });
      const res = await POST(req);
      expect(res.status).toBe(200);
    }

    // A 21ª requisição deve estourar o limite e retornar 429
    const reqFlood = new NextRequest("http://localhost/api/v1/widget/chat/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ body: "Mensagem 21 flood" }),
    });
    const resFlood = await POST(reqFlood);
    expect(resFlood.status).toBe(429);
    const jsonFlood = await resFlood.json();
    expect(jsonFlood.error.code).toBe("rate_limited");
    expect(resFlood.headers.get("retry-after")).toBe("60");
  });

  it("8. Payload Too Large: Rejeita corpos de mensagem acima de 64KB com status 413 (com Content-Length)", async () => {
    const token = gerarTokenDeAcessoWidget(CONV_A, ORG_A);
    const largeBody = "X".repeat(70 * 1024);

    const req = new NextRequest("http://localhost/api/v1/widget/chat/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(Buffer.byteLength(largeBody, "utf8")),
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ body: largeBody }),
    });

    const res = await POST(req);
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error.code).toBe("payload_too_large");
  });

  it("9. Payload Too Large: Rejeita corpos de mensagem acima de 64KB mesmo SEM Content-Length (inspeção de stream)", async () => {
    const token = gerarTokenDeAcessoWidget(CONV_A, ORG_A);
    const largeBody = "Y".repeat(70 * 1024);

    // Cria stream simulando chunked transfer sem header Content-Length
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(JSON.stringify({ body: largeBody })));
        controller.close();
      },
    });

    const req = new NextRequest("http://localhost/api/v1/widget/chat/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: stream,
      duplex: "half",
    } as unknown as ConstructorParameters<typeof NextRequest>[1]);

    const res = await POST(req);
    expect(res.status).toBe(413);
    const json = await res.json();
    expect(json.error.code).toBe("payload_too_large");
  });

  it("10. Precedência Estrita: Bearer inválido NÃO faz fallback silencioso para Cookie válido", async () => {
    const tokenValido = gerarTokenDeAcessoWidget(CONV_A, ORG_A);

    const req = new NextRequest("http://localhost/api/v1/widget/chat", {
      method: "GET",
      headers: {
        authorization: "Bearer token-invalido-forjado",
        cookie: `__clientix_widget=${tokenValido}`,
      },
    });

    const res = await GET(req);
    // Deve falhar com 401 porque a credencial prioritária explícita (Bearer) foi inválida
    expect(res.status).toBe(401);
  });

  it("11. Token Expirado no Cookie é Rejeitado com 401", async () => {
    // Forja token com timestamp de 31 dias atrás
    const payload = {
      conversationId: CONV_A,
      organizationId: ORG_A,
      createdAt: Date.now() - 31 * 24 * 60 * 60 * 1000,
    };
    const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
    // Assina com o segredo correto
    const crypto = await import("node:crypto");
    const secret = process.env.SUPABASE_JWT_SECRET || process.env.INTERNAL_CRON_SECRET || process.env.APP_SECRET || "clientix-widget-dev-only-salt-2026";
    const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
    const tokenExpirado = `${payloadB64}.${sig}`;

    const req = new NextRequest("http://localhost/api/v1/widget/chat", {
      method: "GET",
      headers: {
        cookie: `__clientix_widget=${tokenExpirado}`,
      },
    });

    const res = await GET(req);
    expect(res.status).toBe(401);
    const json = await res.json();
    expect(json.error.details.motivo).toBe("token_expirado");
  });

  it("12. Token curto do WebChat só lê conversa do widget que o emitiu", async () => {
    mockedProvider = "webchat";
    mockedWidgetPublicId = WIDGET_A;
    const token = gerarTokenDeAcessoWidget(CONV_A, ORG_A, { widgetPublicId: WIDGET_A });
    const req = new NextRequest("http://localhost/api/v1/widget/chat", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });

    const res = await GET(req);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("13. Widget A não acessa conversa vinculada ao widget B", async () => {
    mockedProvider = "webchat";
    mockedWidgetPublicId = WIDGET_B;
    const token = gerarTokenDeAcessoWidget(CONV_A, ORG_A, { widgetPublicId: WIDGET_A });
    const req = new NextRequest("http://localhost/api/v1/widget/chat", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });

    expect((await GET(req)).status).toBe(404);
  });

  it("14. Widget desabilitado revoga leitura de sessões já emitidas", async () => {
    mockedProvider = "webchat";
    mockedWidgetPublicId = WIDGET_A;
    mockedSessionStatus = "STOPPED";
    const token = gerarTokenDeAcessoWidget(CONV_A, ORG_A, { widgetPublicId: WIDGET_A });
    const req = new NextRequest("http://localhost/api/v1/widget/chat", {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
    });

    expect((await GET(req)).status).toBe(404);
  });

  it("15. Token WebChat vinculado não pode enviar para conversa de outro widget", async () => {
    mockedProvider = "webchat";
    mockedWidgetPublicId = WIDGET_B;
    const token = gerarTokenDeAcessoWidget(CONV_A, ORG_A, { widgetPublicId: WIDGET_A });
    const req = new NextRequest("http://localhost/api/v1/widget/chat/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ body: "não deve atravessar tenants" }),
    });

    expect((await POST(req)).status).toBe(404);
    expect(capturedInserts).toHaveLength(0);
  });
});
