import { beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ params: "visao=lista", replace: vi.fn() }));
const mocks = vi.hoisted(() => ({
  useBoard: vi.fn(),
  filterBarProps: vi.fn(),
  listProps: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/pipelines/pipeline",
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.params),
}));
vi.mock("@/hooks/kanban/useBoard", () => ({ useBoard: mocks.useBoard }));
vi.mock("@/components/kanban/ListaDoFunil", () => ({
  ListaDoFunil: (props: { filters: { owner?: string; status?: string } }) => {
    mocks.listProps(props);
    return <div data-testid="lista-do-funil" />;
  },
}));
vi.mock("@/components/kanban/FilterBar", () => ({
  FilterBar: (props: {
    filters: { owner?: string; status?: string };
    onChange: (next: { owner?: string; status?: string }) => void;
  }) => {
    mocks.filterBarProps(props);
    return <div data-testid="barra-de-filtros" />;
  },
}));
vi.mock("@/components/kanban/KanbanBoard", () => ({ KanbanBoard: () => <div data-testid="quadro" /> }));
vi.mock("@/components/kanban/BulkActionBar", () => ({ BulkActionBar: () => null }));
vi.mock("@/components/kanban/NewLeadDialog", () => ({ NewLeadDialog: () => null }));

import { PipelinePageClient } from "./_client";

describe("PipelinePageClient — aba Lista", () => {
  beforeEach(() => {
    nav.params = "visao=lista&pagina=4&owner=aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa&status=lost";
    nav.replace.mockClear();
    mocks.filterBarProps.mockClear();
    mocks.listProps.mockClear();
    mocks.useBoard.mockReset().mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
      pulses: new Map(),
      realtimeStatus: "closed",
      seguranca: { divergencias: 0, ultimaVerificacao: null },
    });
  });

  it("mantém a barra existente na Lista e repassa filtros sem carregar o snapshot do Kanban", () => {
    render(
      <PipelinePageClient
        pipelineId="44444444-4444-4444-8444-444444444444"
        initialName="Vendas"
        initialSettings={null}
        role="agent"
      />,
    );

    expect(mocks.useBoard).toHaveBeenCalledWith(null);
    expect(screen.getByTestId("lista-do-funil")).toBeInTheDocument();
    expect(screen.getAllByTestId("barra-de-filtros")).toHaveLength(1);
    expect(screen.queryByTestId("quadro")).not.toBeInTheDocument();
    expect(mocks.listProps).toHaveBeenCalledWith({
      pipelineId: "44444444-4444-4444-8444-444444444444",
      fieldDefs: [],
      filters: { owner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "lost" },
    });
    expect(mocks.filterBarProps).toHaveBeenCalledWith(
      expect.objectContaining({
        filters: { owner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "lost" },
      }),
    );
  });

  it("aplicar filtros na Lista preserva a aba e redefine a página", () => {
    render(
      <PipelinePageClient
        pipelineId="44444444-4444-4444-8444-444444444444"
        initialName="Vendas"
        initialSettings={null}
        role="agent"
      />,
    );

    const onChange = mocks.filterBarProps.mock.calls[0]?.[0].onChange as (
      next: { owner?: string; status?: string },
    ) => void;
    act(() => onChange({ owner: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", status: "won" }));

    expect(nav.replace).toHaveBeenCalledWith(
      "/app/pipelines/pipeline?owner=bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb&status=won&visao=lista",
      { scroll: false },
    );
  });
});
