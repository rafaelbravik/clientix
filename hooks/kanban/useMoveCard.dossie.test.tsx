import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spies = vi.hoisted(() => ({
  post: vi.fn(),
  showApiError: vi.fn(),
}));

vi.mock("@/lib/api/client", () => ({ apiClient: { post: spies.post } }));
vi.mock("@/components/feedback/ApiErrorToast", () => ({ showApiError: spies.showApiError }));
vi.mock("@/lib/kanban/local-echo", () => ({
  marcarEcoLocal: vi.fn(),
  liberarEcoLocal: vi.fn(),
}));

import { ApiError } from "@/lib/api/types";
import type { BoardData } from "@/lib/kanban/types";
import { useMoveCard } from "./useMoveCard";

const PIPELINE_ID = "11111111-1111-4111-8111-111111111111";
const LEAD_ID = "22222222-2222-4222-8222-222222222222";
const ETAPA_ATUAL = "33333333-3333-4333-8333-333333333333";
const ETAPA_NOVA = "44444444-4444-4444-8444-444444444444";
const UPDATED_AT = "2026-10-25T12:00:00.000Z";

function quadro(): BoardData {
  return {
    pipeline: {} as BoardData["pipeline"],
    stages: [],
    leads: [
      {
        id: LEAD_ID,
        stage_id: ETAPA_ATUAL,
        position_in_stage: 0,
        updated_at: UPDATED_AT,
      } as BoardData["leads"][number],
    ],
  };
}

function montarHook(queryClient: QueryClient) {
  function Wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  }
  return renderHook(() => useMoveCard(PIPELINE_ID), { wrapper: Wrapper });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("useMoveCard reutilizado pelo dossiê", () => {
  it("sucesso grava a resposta canônica no quadro", async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    queryClient.setQueryData(["board", PIPELINE_ID], quadro());
    spies.post.mockResolvedValueOnce({
      data: { id: LEAD_ID, stage_id: ETAPA_NOVA, position_in_stage: -500, updated_at: UPDATED_AT },
    });
    const { result } = montarHook(queryClient);

    await act(async () => {
      await result.current.mutateAsync({
        leadId: LEAD_ID,
        stageId: ETAPA_NOVA,
        positionInStage: -500,
        expectedUpdatedAt: UPDATED_AT,
      });
    });

    const atualizado = queryClient.getQueryData<BoardData>(["board", PIPELINE_ID]);
    expect(atualizado?.leads[0]?.stage_id).toBe(ETAPA_NOVA);
    expect(spies.post).toHaveBeenCalledWith(`/api/v1/leads/${LEAD_ID}/move`, {
      stage_id: ETAPA_NOVA,
      position_in_stage: -500,
      expected_updated_at: UPDATED_AT,
    });
  });

  it("conflito de versão reverte a etapa otimista e mostra o erro canônico", async () => {
    const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
    queryClient.setQueryData(["board", PIPELINE_ID], quadro());
    spies.post.mockRejectedValueOnce(
      new ApiError(409, "conflito_de_versao", undefined, "req-1", "Negócio alterado por outra pessoa."),
    );
    const { result } = montarHook(queryClient);

    await act(async () => {
      await expect(
        result.current.mutateAsync({
          leadId: LEAD_ID,
          stageId: ETAPA_NOVA,
          positionInStage: -500,
          expectedUpdatedAt: UPDATED_AT,
        }),
      ).rejects.toThrow("Negócio alterado por outra pessoa.");
    });

    const revertido = queryClient.getQueryData<BoardData>(["board", PIPELINE_ID]);
    expect(revertido?.leads[0]?.stage_id).toBe(ETAPA_ATUAL);
    expect(spies.showApiError).toHaveBeenCalledWith(expect.any(ApiError));
  });
});
