import type { ReactNode } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ podeMover: true }));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => ({ role: "agent" }),
  useUser: () => ({ id: "11111111-1111-4111-8111-111111111111", is_platform_admin: false }),
  usePermission: () => state.podeMover,
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/leads/useLeadTimeline", () => ({
  useLeadTimeline: () => ({
    itens: [],
    chegouAoVivo: true,
    isLoading: false,
    isError: false,
    realtimeStatus: "healthy",
    seguranca: { divergencias: 0 },
  }),
}));
vi.mock("@/components/ui/sheet", () => ({
  Sheet: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SheetContent: ({ children }: { children: ReactNode }) => <aside>{children}</aside>,
  SheetHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  SheetTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  const SelectTrigger = () => null;
  const SelectContent = ({ children }: { children: ReactNode }) => children;
  const SelectItem = ({ value, children }: { value: string; children: ReactNode }) =>
    React.createElement("option", { value }, children);
  return {
    Select: ({
      value,
      onValueChange,
      disabled = false,
      children,
    }: {
      value: string;
      onValueChange: (value: string) => void;
      disabled?: boolean;
      children: ReactNode;
    }) => {
      const filhos = React.Children.toArray(children) as Array<{
        type: unknown;
        props: Record<string, unknown>;
      }>;
      const trigger = filhos.find(
        (filho) => (filho.type as { name?: string }).name === "SelectTrigger",
      );
      const content = filhos.find(
        (filho) => (filho.type as { name?: string }).name === "SelectContent",
      );
      return React.createElement(
        "select",
        {
          "aria-label": trigger?.props["aria-label"],
          value,
          disabled,
          onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onValueChange(event.target.value),
        },
        content?.props.children as ReactNode,
      );
    },
    SelectTrigger,
    SelectValue: () => null,
    SelectContent,
    SelectItem,
  };
});
vi.mock("./ContatoDoNegocio", () => ({ ContatoDoNegocio: () => null }));
vi.mock("./ConversaNoDossie", () => ({ ConversaNoDossie: () => null }));
vi.mock("./LeadFieldsForm", () => ({ LeadFieldsForm: () => null }));
vi.mock("./ScoreSlot", () => ({ ScoreSlot: () => null }));
vi.mock("./LeadTimeline", () => ({ LeadTimeline: () => null }));
vi.mock("./PropostasDoNegocio", () => ({ PropostasDoNegocio: () => null }));
vi.mock("./OwnerBadge", () => ({ OwnerBadge: () => null }));

import type { Stage } from "@/lib/kanban/types";
import type { Lead } from "@/lib/types/leads";
import { LeadDossier } from "./LeadDossier";

const ATUAL = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DESTINO = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ARQUIVADA = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

const etapas: Stage[] = [
  {
    id: ATUAL,
    organization_id: "22222222-2222-4222-8222-222222222222",
    pipeline_id: "44444444-4444-4444-8444-444444444444",
    name: "Qualificação",
    slug: "qualificacao",
    position: 1,
    color: null,
    is_won: false,
    is_lost: false,
    is_archived: false,
    expected_duration_hours: null,
  },
  {
    id: DESTINO,
    organization_id: "22222222-2222-4222-8222-222222222222",
    pipeline_id: "44444444-4444-4444-8444-444444444444",
    name: "Proposta",
    slug: "proposta",
    position: 2,
    color: null,
    is_won: false,
    is_lost: false,
    is_archived: false,
    expected_duration_hours: null,
  },
  {
    id: ARQUIVADA,
    organization_id: "22222222-2222-4222-8222-222222222222",
    pipeline_id: "44444444-4444-4444-8444-444444444444",
    name: "Antiga",
    slug: "antiga",
    position: 3,
    color: null,
    is_won: false,
    is_lost: false,
    is_archived: true,
    expected_duration_hours: null,
  },
];

function renderDossier(podeMover = true) {
  state.podeMover = podeMover;
  const lead = {
    id: "55555555-5555-4555-8555-555555555555",
    organization_id: "22222222-2222-4222-8222-222222222222",
    pipeline_id: "44444444-4444-4444-8444-444444444444",
    stage_id: ATUAL,
    contact_id: null,
    title: "Cliente de teste",
    description: null,
    status: "open",
    lost_reason: null,
    position_in_stage: 1000,
    value_cents: null,
    currency: "BRL",
    owner_user_id: null,
    owner_kind: null,
    owner_agent_id: null,
    assigned_at: null,
    last_activity_at: null,
    updated_at: "2026-10-25T12:00:00.000Z",
  } as Lead;
  const onMudarEtapa = vi.fn();
  render(
    <LeadDossier
      open
      onOpenChange={vi.fn()}
      lead={lead}
      pipelineId={lead.pipeline_id}
      stageName="Qualificação"
      stages={etapas}
      onMudarEtapa={onMudarEtapa}
    />,
  );
  return { onMudarEtapa };
}

beforeEach(() => {
  state.podeMover = true;
});

describe("LeadDossier — etapa do funil", () => {
  it("mostra etapa atual e lista apenas etapas válidas", () => {
    renderDossier();
    const select = screen.getByRole("combobox", { name: "Etapa do funil" }) as HTMLSelectElement;

    expect(select.value).toBe(ATUAL);
    expect(screen.getByRole("option", { name: "Qualificação" })).toBeTruthy();
    expect(screen.getByRole("option", { name: "Proposta" })).toBeTruthy();
    expect(screen.queryByRole("option", { name: "Antiga" })).toBeNull();
  });

  it("usuário autorizado vê controle e selecionar outra etapa chama a pipeline recebida", () => {
    const { onMudarEtapa } = renderDossier();
    fireEvent.change(screen.getByRole("combobox", { name: "Etapa do funil" }), {
      target: { value: DESTINO },
    });

    expect(onMudarEtapa).toHaveBeenCalledOnce();
    expect(onMudarEtapa).toHaveBeenCalledWith(DESTINO);
  });

  it("usuário sem pipeline.move_card vê somente o nome estático", () => {
    renderDossier(false);

    expect(screen.getByText("Qualificação")).toBeTruthy();
    expect(screen.queryByRole("combobox", { name: "Etapa do funil" })).toBeNull();
  });

  it("selecionar a mesma etapa não solicita uma mutação", () => {
    const { onMudarEtapa } = renderDossier();
    fireEvent.change(screen.getByRole("combobox", { name: "Etapa do funil" }), {
      target: { value: ATUAL },
    });

    expect(onMudarEtapa).not.toHaveBeenCalled();
  });
});
