import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  move: vi.fn(),
  moveOptions: null as null | { onCamposFaltando?: (recusa: unknown) => void },
  rename: vi.fn(),
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/kanban/useBoard", () => ({
  useBoard: () => ({ data: undefined, isLoading: false, isError: false, error: null, pulses: new Map() }),
}));
vi.mock("@/hooks/kanban/useMoveCard", () => ({
  useMoveCard: (_pipelineId: string, options: typeof spies.moveOptions) => {
    spies.moveOptions = options;
    return { mutate: spies.move, isPending: false };
  },
}));
vi.mock("@/hooks/kanban/useRenameStage", () => ({ useRenameStage: () => ({ mutate: spies.rename }) }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({ useAssignableMembers: () => ({ data: [] }) }));
vi.mock("@/hooks/leads/useAtRiskLeads", () => ({ useAtRiskLeads: () => ({ data: { items: [] } }) }));
vi.mock("@/hooks/leads/useReactivations", () => ({ useReactivations: () => ({ data: [] }) }));
vi.mock("@/components/kanban/StageColumn", () => ({
  StageColumn: ({ stage, leads, onOpen }: { stage: { name: string }; leads: Array<{ id: string }>; onOpen: (id: string) => void }) => (
    <section>
      <span>{stage.name}</span>
      {leads.map((lead) => (
        <button key={lead.id} type="button" onClick={() => onOpen(lead.id)}>
          Abrir negócio
        </button>
      ))}
    </section>
  ),
}));
vi.mock("@/components/kanban/LeadDossier", () => ({
  LeadDossier: ({
    lead,
    onMudarEtapa,
  }: {
    lead: { stage_id: string };
    onMudarEtapa?: (stageId: string) => void;
  }) => (
    <div>
      <button type="button" onClick={() => onMudarEtapa?.(STAGE_DESTINO)}>
        Etapa de destino
      </button>
      <button type="button" onClick={() => onMudarEtapa?.(lead.stage_id)}>
        Mesma etapa
      </button>
      <button type="button" onClick={() => onMudarEtapa?.(STAGE_PERDA)}>
        Etapa perdida
      </button>
    </div>
  ),
}));
vi.mock("@/components/kanban/CamposObrigatoriosDialog", () => ({
  CamposObrigatoriosDialog: ({ open }: { open: boolean }) =>
    open ? <div role="dialog">Campos obrigatórios</div> : null,
}));
vi.mock("@/components/kanban/LoseLeadDialog", () => ({
  LoseLeadDialog: ({ open, leadId }: { open: boolean; leadId: string }) =>
    open ? <div role="dialog">Motivo de perda · {leadId}</div> : null,
}));
vi.mock("@/components/kanban/RetomarComoNovoNegocioDialog", () => ({
  RetomarComoNovoNegocioDialog: () => null,
}));

import type { BoardData, Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";
import { KanbanBoard } from "./KanbanBoard";

const PIPELINE_ID = "44444444-4444-4444-8444-444444444444";
const STAGE_ATUAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const STAGE_DESTINO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const STAGE_PERDA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const LEAD_ID = "55555555-5555-4555-8555-555555555555";
const FIRST_DEST_LEAD = "66666666-6666-4666-8666-666666666666";
const UPDATED_AT = "2026-10-25T12:00:00.000Z";

function stage(id: string, name: string, is_lost = false): Stage {
  return {
    id,
    organization_id: "22222222-2222-4222-8222-222222222222",
    pipeline_id: PIPELINE_ID,
    name,
    slug: name.toLowerCase(),
    position: 1,
    color: null,
    is_won: false,
    is_lost,
    is_archived: false,
    expected_duration_hours: null,
  };
}

function lead(id: string, stage_id: string, position_in_stage: number): Lead {
  return {
    id,
    organization_id: "22222222-2222-4222-8222-222222222222",
    pipeline_id: PIPELINE_ID,
    stage_id,
    contact_id: null,
    title: id === LEAD_ID ? "Negócio atual" : "Negócio de destino",
    description: null,
    status: "open",
    lost_reason: null,
    position_in_stage,
    value_cents: null,
    currency: "BRL",
    owner_user_id: null,
    owner_kind: null,
    owner_agent_id: null,
    assigned_at: null,
    last_activity_at: null,
    updated_at: UPDATED_AT,
  } as Lead;
}

function boardData(leads: Lead[]): BoardData {
  return {
    pipeline: {
      id: PIPELINE_ID,
      organization_id: "22222222-2222-4222-8222-222222222222",
      name: "Vendas",
      slug: "vendas",
      description: null,
      is_default: true,
      is_archived: false,
      position: 1,
      vocabulary: {},
      settings: {},
    },
    stages: [stage(STAGE_ATUAL, "Qualificação"), stage(STAGE_DESTINO, "Proposta"), stage(STAGE_PERDA, "Perdido", true)],
    leads,
  };
}

function montarBoard() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const fullBoard = boardData([
    lead(LEAD_ID, STAGE_ATUAL, 1000),
    lead(FIRST_DEST_LEAD, STAGE_DESTINO, 250),
  ]);
  queryClient.setQueryData(["board", PIPELINE_ID], fullBoard);
  render(
    <QueryClientProvider client={queryClient}>
      <KanbanBoard
        pipelineId={PIPELINE_ID}
        stages={fullBoard.stages}
        // Simula quadro filtrado: o primeiro card da etapa está no cache,
        // mas não está no recorte apresentado.
        leads={[fullBoard.leads[0]! ]}
        pipeline={fullBoard.pipeline}
      />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  spies.moveOptions = null;
});

describe("KanbanBoard — etapa iniciada pelo dossiê", () => {
  it("usa a mutação canônica, carimbo da origem e posição antes do primeiro card do cache", () => {
    montarBoard();
    fireEvent.click(screen.getByRole("button", { name: "Abrir negócio" }));
    fireEvent.click(screen.getByRole("button", { name: "Etapa de destino" }));

    expect(spies.move).toHaveBeenCalledWith({
      leadId: LEAD_ID,
      stageId: STAGE_DESTINO,
      positionInStage: -750,
      expectedUpdatedAt: UPDATED_AT,
    });
  });

  it("não envia mutation para a etapa atual", () => {
    montarBoard();
    fireEvent.click(screen.getByRole("button", { name: "Abrir negócio" }));
    fireEvent.click(screen.getByRole("button", { name: "Mesma etapa" }));

    expect(spies.move).not.toHaveBeenCalled();
  });

  it("etapa de perda abre o diálogo canônico e exige o motivo antes de mutar", () => {
    montarBoard();
    fireEvent.click(screen.getByRole("button", { name: "Abrir negócio" }));
    fireEvent.click(screen.getByRole("button", { name: "Etapa perdida" }));

    expect(screen.getByRole("dialog").textContent).toContain(LEAD_ID);
    expect(spies.move).not.toHaveBeenCalled();
  });

  it("usa o diálogo existente quando a pipeline recusa campos obrigatórios", () => {
    montarBoard();
    fireEvent.click(screen.getByRole("button", { name: "Abrir negócio" }));
    fireEvent.click(screen.getByRole("button", { name: "Etapa de destino" }));
    const args = spies.move.mock.calls[0]?.[0];
    act(() => {
      spies.moveOptions?.onCamposFaltando?.({
        args,
        faltando: [{ chave: "valor", rotulo: "Valor", tipo: "number" }],
      });
    });

    expect(screen.getByRole("dialog").textContent).toContain("Campos obrigatórios");
  });
});
