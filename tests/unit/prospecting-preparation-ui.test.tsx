import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { ProspectingClient } from "@/app/app/prospecting/_client";
import { estrategiaDoCandidato } from "@/lib/prospecting/estrategia-site";

const mocks = vi.hoisted(() => ({
  state: null as unknown,
  refetch: vi.fn(),
  post: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mocks.state, error: null, refetch: mocks.refetch }),
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));
vi.mock("@/hooks/auth/AuthProvider", () => ({ useActiveOrg: () => ({ orgId: "org-a" }) }));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn(), post: mocks.post } }));
vi.mock("@/app/app/prospecting/_create-agent", () => ({ ProspectingAgentBuilder: () => null }));

const emptyState = {
  configured: true,
  provider: "apify",
  provider_status: "apify_ready",
  campaigns: [],
  candidates: [],
  agents: [],
  channels: [],
  stages: [],
};

afterEach(() => cleanup());
beforeEach(() => {
  vi.clearAllMocks();
  mocks.state = structuredClone(emptyState);
  mocks.post.mockResolvedValue(undefined);
  mocks.refetch.mockResolvedValue(undefined);
});

describe("opções e estados do preparo automático da prospecção", () => {
  it("mantém prévia dependente de avaliação do site e grava as duas opções da busca", async () => {
    render(<ProspectingClient />);
    const avaliar = screen.getByRole("checkbox", { name: /Avaliar site dos prospects/ });
    const previa = screen.getByRole("checkbox", { name: /Gerar prévia de abordagem com IA/ });
    expect(avaliar).toBeChecked();
    expect(previa).toBeChecked();
    fireEvent.click(avaliar);
    expect(previa).not.toBeChecked();
    expect(previa).toBeDisabled();
    fireEvent.click(avaliar);
    expect(previa).toBeEnabled();
    fireEvent.click(screen.getByRole("textbox", { name: "Público ou segmento" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Público ou segmento" }), {
      target: { value: "Clínicas" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "Cidade ou região" }), {
      target: { value: "Campinas, SP" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Buscar empresas" }));
    await waitFor(() => expect(mocks.post).toHaveBeenCalled());
    expect(mocks.post.mock.calls[0]?.[1]).toMatchObject({
      action: "search",
      search: { avaliar_site: true, gerar_previa: false },
    });
    expect(
      screen.getByText(
        "O uso de IA das prévias é contabilizado separadamente e não está incluído no custo da busca informado pela Apify.",
      ),
    ).toBeVisible();
  });

  it("distingue preparo pendente de busca concluída e mostra progressos separados", () => {
    mocks.state = {
      ...structuredClone(emptyState),
      campaigns: [
        {
          id: "campaign-a",
          name: "Clínicas · Campinas",
          status: "draft",
          search_status: "succeeded",
          error: null,
          config: null,
          search: { avaliar_site: true, gerar_previa: true },
          result_count: 1,
          skipped_count: 0,
          cost_usd: null,
          next_send_at: "2026-11-01T12:00:00.000Z",
        },
      ],
      candidates: [
        {
          id: "candidate-a",
          campaign_id: "campaign-a",
          data: {
            key: "place-a",
            name: "Empresa sintética",
            phone: null,
            website: "https://empresa.example/",
            category: null,
            address: null,
            maps_url: null,
            rating: 4.8,
            reviews: 42,
            emails: [],
            socials: [],
            site: null,
          },
          progress: "new",
          message_status: null,
          error: null,
          conversation_id: null,
          agent_version_id: null,
          strategy: estrategiaDoCandidato({ website: "https://empresa.example/" }),
          preview: null,
          site_state: "pending",
          preview_state: "pending",
        },
      ],
    };
    render(<ProspectingClient />);
    fireEvent.click(screen.getByRole("button", { name: /Clínicas · Campinas/ }));
    expect(screen.getByRole("region", { name: "Preparação de prospects" })).toBeVisible();
    expect(
      screen.getByText("A busca, a auditoria de sites e as prévias têm estados separados."),
    ).toBeVisible();
    expect(screen.getAllByText(/pendentes/).length).toBeGreaterThan(0);
    expect(screen.getByText("Preparação pendente")).toBeInTheDocument();
  });
});
