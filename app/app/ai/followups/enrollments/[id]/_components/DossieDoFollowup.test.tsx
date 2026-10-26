import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

const deps = vi.hoisted(() => ({ enrollment: vi.fn(), intervene: vi.fn(), cancel: vi.fn() }));

vi.mock("@/hooks/i18n/useLocaleDeData", () => ({
  useLocaleDeData: () => ({}),
  useTagDeIdioma: () => "pt-BR",
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/followup/useFollowupEnrollment", () => ({
  useFollowupEnrollment: deps.enrollment,
  useIntervirNoFollowup: deps.intervene,
}));
vi.mock("@/hooks/followup/useFollowupQueue", () => ({ useCancelFollowupEnrollment: deps.cancel }));

import { DossieDoFollowup } from "./DossieDoFollowup";
import type { FollowupEnrollmentDossie } from "@/hooks/followup/useFollowupEnrollment";

const data: FollowupEnrollmentDossie = {
  id: "enrollment-1",
  status: "dormente",
  current_node_id: "wait-1",
  next_eval_at: "data-invalida-no-teste",
  claimed_until: null,
  motor_ocupado: false,
  started_at: "data-invalida-no-teste",
  completed_at: null,
  updated_at: "2026-10-24T12:00:00.000Z",
  outcome: null,
  cancel_reason: null,
  last_error: null,
  attempts: 0,
  max_attempts: 5,
  steps_taken: 1,
  contact: { id: "contact-1", name: "Contato de teste" },
  flow: { pointer_id: "flow-1", name: "Fluxo de teste", version_id: "version-1" },
  agent_name: null,
  no_atual: null,
  nos: [],
  saidas: [],
  eventos: [],
  eventos_truncados: false,
  plano_de_tempo: null,
  autores: {},
};

beforeEach(() => {
  vi.clearAllMocks();
  deps.enrollment.mockReturnValue({ data, isLoading: false, isError: false });
  deps.intervene.mockReturnValue({ isPending: false, mutate: vi.fn() });
  deps.cancel.mockReturnValue({ isPending: false, mutate: vi.fn() });
});

describe("DossieDoFollowup — cancelamento", () => {
  it("oferece cancelar para um enrollment dormente", () => {
    render(<DossieDoFollowup id={data.id} canWrite />);

    expect(screen.getByTestId("dossie-cancelar")).toBeInTheDocument();
  });

  it("não oferece mutação para usuário sem permissão", () => {
    render(<DossieDoFollowup id={data.id} canWrite={false} />);

    expect(screen.queryByTestId("dossie-cancelar")).not.toBeInTheDocument();
  });
});
