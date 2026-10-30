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
const FILTROS_VAZIOS = { owner: "any", status: "all" } as const;

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
    render(<ListaDoFunil pipelineId="pipeline-a" fieldDefs={[]} filters={FILTROS_VAZIOS} />);
    expect(screen.getByText("Qualificação")).toBeInTheDocument();
    expect(screen.getByText("Última atividade")).toBeInTheDocument();
    expect(hooks.useLeadsPaginados).toHaveBeenCalledWith(
      "pipeline-a",
      1,
      50,
      FILTROS_VAZIOS,
    );
    fireEvent.click(screen.getByRole("button", { name: "Abrir dossiê do negócio: Negócio três" }));
    expect(screen.getByTestId("lead-dossier")).toHaveTextContent("Negócio três");
    expect(dossier.props).toHaveBeenCalledWith(expect.objectContaining({ lead, pipelineId: "pipeline-a" }));
  });

  it("página seguinte usa a página da URL e não filtra somente os itens renderizados", () => {
    render(<ListaDoFunil pipelineId="pipeline-a" fieldDefs={[]} filters={FILTROS_VAZIOS} />);
    fireEvent.click(screen.getByRole("button", { name: "Próxima" }));
    expect(nav.replace).toHaveBeenCalledWith("?visao=lista&pagina=2", { scroll: false });
  });

  it("avisa só sobre filtros ainda não suportados; owner/status não entram no aviso", () => {
    render(
      <ListaDoFunil
        pipelineId="pipeline-a"
        fieldDefs={[]}
        filters={{ owner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "won" }}
      />,
    );
    expect(screen.queryByRole("status")).not.toBeInTheDocument();

    render(
      <ListaDoFunil
        pipelineId="pipeline-a"
        fieldDefs={[]}
        filters={{ owner: "any", status: "all", search: "cliente", overdueOnly: true }}
      />,
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Na Lista, estes filtros ainda não se aplicam: Busca, Apenas atrasados. No Quadro, eles continuam funcionando.",
    );
  });

  it("diferencia lista vazia com filtro aplicado da lista vazia sem filtro", () => {
    hooks.useLeadsPaginados.mockReturnValue({
      data: { data: [], meta: { page: 1, per_page: 50, total: 0, has_more: false } },
      leads: [],
      pageInfo: { page: 1, per_page: 50, total: 0, has_more: false },
      isLoading: false,
      isError: false,
    });
    const { rerender } = render(
      <ListaDoFunil
        pipelineId="pipeline-a"
        fieldDefs={[]}
        filters={{ owner: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", status: "won" }}
      />,
    );
    const vazioComFiltro = screen.getByText("Nenhum negócio com este filtro.");
    expect(vazioComFiltro).toBeInTheDocument();
    expect(vazioComFiltro.closest("table")).toBeNull();

    rerender(<ListaDoFunil pipelineId="pipeline-a" fieldDefs={[]} filters={FILTROS_VAZIOS} />);
    const vazioSemFiltro = screen.getByText("Nenhum negócio neste funil.");
    expect(vazioSemFiltro).toBeInTheDocument();
    expect(vazioSemFiltro.closest("table")).toBeNull();
  });
});
