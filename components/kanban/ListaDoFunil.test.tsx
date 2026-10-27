import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

const nav = vi.hoisted(() => ({ params: "visao=lista", replace: vi.fn() }));
const hooks = vi.hoisted(() => ({ useLeadsPaginados: vi.fn() }));
const dossier = vi.hoisted(() => ({ props: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: nav.replace }),
  useSearchParams: () => new URLSearchParams(nav.params),
}));
vi.mock("@/hooks/kanban/useLeadsPaginados", () => ({ useLeadsPaginados: hooks.useLeadsPaginados }));
vi.mock("./LeadDossier", () => ({
  LeadDossier: (props: { lead: { title: string } }) => {
    dossier.props(props);
    return <div role="dialog" data-testid="lead-dossier">{props.lead.title}</div>;
  },
}));

import { ListaDoFunil } from "./ListaDoFunil";

const lead = {
  id: "lead-3",
  organization_id: "org-a",
  pipeline_id: "pipeline-a",
  stage_id: "stage-a",
  stage_name: "Qualificação",
  title: "Negócio três",
  status: "open" as const,
  value_cents: 125000,
  currency: "BRL",
  last_activity_at: "2026-10-27T10:30:00.000Z",
} as never;

describe("ListaDoFunil", () => {
  beforeEach(() => {
    nav.params = "visao=lista";
    nav.replace.mockClear();
    dossier.props.mockClear();
    hooks.useLeadsPaginados.mockReturnValue({
      data: { data: [lead], meta: { page: 1, per_page: 50, total: 51, has_more: true } },
      leads: [lead],
      pageInfo: { page: 1, per_page: 50, total: 51, has_more: true },
      isLoading: false,
      isError: false,
    });
  });

  it("mostra colunas da página e abre o mesmo LeadDossier com o registro escolhido", () => {
    render(<ListaDoFunil pipelineId="pipeline-a" fieldDefs={[]} />);
    expect(screen.getByText("Qualificação")).toBeInTheDocument();
    expect(screen.getByText("Última atividade")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Abrir dossiê do negócio: Negócio três" }));
    expect(screen.getByTestId("lead-dossier")).toHaveTextContent("Negócio três");
    expect(dossier.props).toHaveBeenCalledWith(expect.objectContaining({ lead, pipelineId: "pipeline-a" }));
  });

  it("página seguinte usa a página da URL e não filtra somente os itens renderizados", () => {
    render(<ListaDoFunil pipelineId="pipeline-a" fieldDefs={[]} />);
    fireEvent.click(screen.getByRole("button", { name: "Próxima" }));
    expect(nav.replace).toHaveBeenCalledWith("?visao=lista&pagina=2", { scroll: false });
  });
});
