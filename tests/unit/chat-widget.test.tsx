import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  gerarTokenDeAcessoWidget,
  validarTokenDeAcessoWidget,
} from "@/lib/chat-widget/token";
import {
  gerarLinkDoWidget,
  gerarMensagemDeConviteWidget,
} from "@/lib/chat-widget/convite";
import { ChatWidgetClient } from "@/app/chat/[token]/_client";

describe("Chat Web Widget - Token e Acesso Seguro", () => {
  it("deve gerar e validar um token de acesso com sucesso", () => {
    const convId = "11111111-2222-3333-4444-555555555555";
    const orgId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

    const token = gerarTokenDeAcessoWidget(convId, orgId);
    expect(token).toBeDefined();
    expect(token).toContain(".");

    const res = validarTokenDeAcessoWidget(token);
    expect(res.valido).toBe(true);
    expect(res.payload?.conversationId).toBe(convId);
    expect(res.payload?.organizationId).toBe(orgId);
    expect(res.payload?.createdAt).toBeTypeOf("number");
  });

  it("deve rejeitar tokens forjados ou corrompidos", () => {
    const tokenValido = gerarTokenDeAcessoWidget("c1", "o1");
    const [payload, sig] = tokenValido.split(".");

    // Assinatura adulterada
    const tokenAdulterado = `${payload}.assinaturaFalsa123456`;
    const resAdulterado = validarTokenDeAcessoWidget(tokenAdulterado);
    expect(resAdulterado.valido).toBe(false);

    // Payload adulterado
    const outroPayload = Buffer.from(
      JSON.stringify({ conversationId: "c2", organizationId: "o1", createdAt: Date.now() }),
    ).toString("base64url");
    const tokenPayloadTrocado = `${outroPayload}.${sig}`;
    const resPayloadTrocado = validarTokenDeAcessoWidget(tokenPayloadTrocado);
    expect(resPayloadTrocado.valido).toBe(false);

    // Token vazio ou inválido
    expect(validarTokenDeAcessoWidget("").valido).toBe(false);
    expect(validarTokenDeAcessoWidget("sem-ponto").valido).toBe(false);
  });

  it("deve gerar link e mensagem de convite corretos", () => {
    const convId = "conv-123";
    const orgId = "org-456";
    const baseUrl = "https://crm.cliente.com.br";

    const link = gerarLinkDoWidget(baseUrl, convId, orgId);
    expect(link.startsWith("https://crm.cliente.com.br/chat/")).toBe(true);

    const msgComProt = gerarMensagemDeConviteWidget(link, "PROT-20261001-0001");
    expect(msgComProt).toContain(link);
    expect(msgComProt).toContain("PROT-20261001-0001");

    const msgSemProt = gerarMensagemDeConviteWidget(link);
    expect(msgSemProt).toContain(link);
    expect(msgSemProt).not.toContain("protocolo");
  });

  it("deve limpar estado de erro quando o polling recupera com sucesso após falha temporária", () => {
    // Simula a lógica de transição de estado de carregarChat
    let erro: string | null = null;
    let data: unknown = null;

    function onCarregarChat(res: { ok: boolean; status: number; data?: unknown }, isBackground = false) {
      if (!res.ok) {
        if (res.status === 401 || res.status === 403 || res.status === 404) {
          erro = "Este link de atendimento é inválido ou expirou.";
          return "fatal";
        }
        if (!isBackground) {
          erro = "Serviço de atendimento temporariamente indisponível.";
        }
        return "transient";
      }
      if (res.ok && res.data) {
        data = res.data;
        erro = null; // garante a limpeza do erro anterior
      }
      return "ok";
    }

    // 1. Falha inicial temporária
    const status1 = onCarregarChat({ ok: false, status: 503 }, false);
    expect(status1).toBe("transient");
    expect(erro).toBe("Serviço de atendimento temporariamente indisponível.");
    expect(data).toBeNull();

    // 2. Recuperação bem sucedida via polling subsequente
    const status2 = onCarregarChat({ ok: true, status: 200, data: { conversation: { id: "c1" } } }, true);
    expect(status2).toBe("ok");
    expect(erro).toBeNull();
    expect(data).toEqual({ conversation: { id: "c1" } });
  });

  it("renderiza o componente visual no DOM, exibe mensagem de erro na falha inicial e limpa o erro ao recuperar com sucesso", async () => {
    // Mock do scrollIntoView para ambiente jsdom
    window.HTMLElement.prototype.scrollIntoView = vi.fn();
    vi.useFakeTimers({ shouldAdvanceTime: true });

    let callCount = 0;
    const fetchMock = vi.fn(async () => {
      callCount++;
      if (callCount === 1) {
        return {
          ok: false,
          status: 503,
          json: async () => ({ ok: false, error: "service_unavailable" }),
        } as unknown as Response;
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          ok: true,
          data: {
            conversation: {
              id: "conv-teste-1",
              protocolo: "PROT-20261003-9999",
              status: "open",
              channel_type: "widget",
            },
            organization: {
              name: "Clínica Saúde & Vida",
              logo_url: null,
              primary_color: "#2563eb",
            },
            messages: [
              {
                id: "msg-1",
                direction: "inbound",
                body: "Olá, gostaria de agendar uma consulta.",
                kind: "text",
                sent_at: new Date().toISOString(),
                status: "delivered",
              },
            ],
          },
        }),
      } as unknown as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const { unmount } = render(<ChatWidgetClient token="token-teste-abc" />);

    // 1. Deve exibir visualmente na tela o estado de erro inicial
    expect(await screen.findByText("Atendimento indisponível")).toBeDefined();
    expect(screen.getByText("Serviço de atendimento temporariamente indisponível.")).toBeDefined();

    // 2. Avança o timer para disparar o próximo ciclo de polling (5s)
    await vi.advanceTimersByTimeAsync(5500);

    // 3. O componente visual deve se recuperar: o banner de erro some e o chat aparece no DOM
    await waitFor(() => {
      expect(screen.queryByText("Atendimento indisponível")).toBeNull();
      expect(screen.queryByText("Serviço de atendimento temporariamente indisponível.")).toBeNull();
      expect(screen.getByText("Clínica Saúde & Vida")).toBeDefined();
      expect(screen.getByText(/PROT-20261003-9999/)).toBeDefined();
      expect(screen.getByText("Olá, gostaria de agendar uma consulta.")).toBeDefined();
    });

    unmount();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
});
