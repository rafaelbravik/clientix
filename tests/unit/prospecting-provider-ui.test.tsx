import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  activeOrgId: "org-a",
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: mocks.get, post: mocks.post } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ orgId: mocks.activeOrgId }),
}));

import { ProspectingClient } from "@/app/app/prospecting/_client";

function state(overrides: Record<string, unknown> = {}) {
  return {
    configured: false,
    provider: "apify",
    provider_status: "apify_missing_credential",
    campaigns: [],
    candidates: [],
    agents: [],
    channels: [],
    stages: [],
    ...overrides,
  };
}

function open(stateForOrg = state()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: Infinity } },
  });
  mocks.get.mockResolvedValue({ data: structuredClone(stateForOrg) });
  mocks.post.mockResolvedValue({ data: {} });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProspectingClient />
    </QueryClientProvider>,
  );
  return { ...view, queryClient };
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.activeOrgId = "org-a";
});

describe("prospecting provider surface", () => {
  it("explains Apify's external billing and keeps unavailable local HTTP disabled", async () => {
    open();
    expect(
      await screen.findByText("Configure a chave da Apify para iniciar uma busca."),
    ).toBeVisible();
    expect(screen.getByRole("radio", { name: /Google Maps \/ Places via Apify/ })).toBeEnabled();
    expect(screen.getByRole("radio", { name: /Engine local/ })).toBeDisabled();
    expect(screen.getByText(/o Clientix não cobra esse valor.*teto informado/i)).toBeVisible();
    expect(screen.getByLabelText("Teto da busca (US$)")).toHaveValue(1);
    expect(screen.getByRole("button", { name: "Buscar empresas" })).toBeDisabled();
    expect(screen.queryByText(/actor|api\.apify\.com/i)).not.toBeInTheDocument();
  });

  it("shows only provider-reported cost and doesn't invent a missing cost", async () => {
    const campaign = {
      id: "campaign-a",
      name: "Clínicas · São Paulo",
      status: "draft",
      search_status: "succeeded",
      error: null,
      config: null,
      result_count: 3,
      skipped_count: 0,
      cost_usd: "0.42",
      next_send_at: "2026-10-31T12:00:00Z",
    };
    open(
      state({
        configured: true,
        provider_status: "apify_ready",
        campaigns: [campaign],
      }),
    );
    expect(await screen.findByText(/Custo informado pelo provedor: US\$ 0\.42/)).toBeVisible();
    cleanup();

    open(
      state({
        configured: true,
        provider_status: "apify_ready",
        campaigns: [{ ...campaign, cost_usd: null }],
      }),
    );
    expect(await screen.findByText(/O provedor não informou o custo desta busca/)).toBeVisible();
  });

  it("persists the canonical Apify choice and qualifies model-independent cache by tenant", async () => {
    const { queryClient, rerender } = open(
      state({
        provider: "local-http",
        provider_status: "local_http_unavailable",
        configured: true,
      }),
    );
    const apify = await screen.findByRole("radio", { name: /Google Maps \/ Places via Apify/ });
    fireEvent.click(apify);
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith("/api/v1/prospecting", {
        action: "select_provider",
        provider: "apify",
      }),
    );
    expect(
      queryClient
        .getQueryCache()
        .getAll()
        .map((query) => query.queryKey),
    ).toContainEqual(["prospecting", "org-a"]);

    mocks.activeOrgId = "org-b";
    rerender(
      <QueryClientProvider client={queryClient}>
        <ProspectingClient />
      </QueryClientProvider>,
    );
    await waitFor(() =>
      expect(
        queryClient
          .getQueryCache()
          .getAll()
          .map((query) => query.queryKey),
      ).toContainEqual(["prospecting", "org-b"]),
    );
  });

  it("shows a separate unavailable message for a stored local-http provider", async () => {
    open(state({ provider: "local-http", provider_status: "local_http_unavailable" }));
    expect(
      await screen.findByText(/não está configurado ou não foi aprovado para fontes reais/i),
    ).toBeVisible();
    expect(screen.getByRole("radio", { name: /Engine local/ })).toBeChecked();
    expect(screen.getByRole("button", { name: "Buscar empresas" })).toBeDisabled();
    expect(mocks.post).not.toHaveBeenCalled();
  });
});
