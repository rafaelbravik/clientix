import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ params: "visao=lista", replace: vi.fn() }));
const mocks = vi.hoisted(() => ({ useBoard: vi.fn() }));

vi.mock("next/navigation", () => ({
  usePathname: () => "/app/pipelines/pipeline",
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.params),
}));
vi.mock("@/hooks/kanban/useBoard", () => ({ useBoard: mocks.useBoard }));
vi.mock("@/components/kanban/ListaDoFunil", () => ({
  ListaDoFunil: () => <div data-testid="lista-do-funil" />,
}));
vi.mock("@/components/kanban/FilterBar", () => ({ FilterBar: () => <div data-testid="filtros-do-quadro" /> }));
vi.mock("@/components/kanban/KanbanBoard", () => ({ KanbanBoard: () => <div data-testid="quadro" /> }));
vi.mock("@/components/kanban/BulkActionBar", () => ({ BulkActionBar: () => null }));
vi.mock("@/components/kanban/NewLeadDialog", () => ({ NewLeadDialog: () => null }));

import { PipelinePageClient } from "./_client";

describe("PipelinePageClient — aba Lista", () => {
  beforeEach(() => {
    nav.params = "visao=lista";
    nav.replace.mockClear();
    mocks.useBoard.mockReset().mockReturnValue({
      data: undefined,
      isLoading: false,
      error: null,
      pulses: new Map(),
      realtimeStatus: "closed",
      seguranca: { divergencias: 0, ultimaVerificacao: null },
    });
  });

  it("não pede o snapshot completo do Kanban e omite filtros e ações de quadro", () => {
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
    expect(screen.queryByTestId("filtros-do-quadro")).not.toBeInTheDocument();
    expect(screen.queryByTestId("quadro")).not.toBeInTheDocument();
  });
});
