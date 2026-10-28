import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { filtroDeAudienciaSchema } from "@/lib/campanhas/audiencia";
import { NovaCampanha } from "./_client";

const mocks = vi.hoisted(() => ({
  criar: vi.fn(),
  push: vi.fn(),
}));

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: mocks.push }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/channels/useChannelSessions", () => ({
  useChannelSessions: () => ({
    data: [
      {
        id: "11111111-1111-4111-8111-111111111111",
        provider: "waha",
        display_name: "QA — canal sintético",
        phone_number: null,
        waha_session_name: "qa-synthetic",
      },
    ],
  }),
  channelLabel: (canal: { display_name?: string | null }) =>
    canal.display_name ?? "QA — canal sintético",
}));
vi.mock("@/hooks/campanhas/useCampanhas", () => ({
  useCriarCampanha: () => ({ mutateAsync: mocks.criar }),
  usePreviaDaAudiencia: () => ({ mutateAsync: vi.fn(), isPending: false }),
}));
vi.mock("@/hooks/campanhas/useDestinoDaCampanha", () => ({
  useAgentesPublicados: () => ({ data: [] }),
  useEtapas: () => ({ data: [] }),
  useFunis: () => ({ data: [] }),
}));
vi.mock("@/lib/channels/presentation", () => ({ channelBrand: () => "whatsapp" }));

beforeEach(() => {
  mocks.criar.mockResolvedValue({ id: "22222222-2222-4222-8222-222222222222" });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("NovaCampanha · contrato do filtro CRM", () => {
  it("envia um audience_filter aceito pelo schema ao salvar texto com balões", async () => {
    render(<NovaCampanha />);

    fireEvent.change(screen.getByLabelText("Nome da campanha"), {
      target: { value: "QA — Wave 6 balões" },
    });
    fireEvent.change(screen.getByLabelText("Enviar pelo número"), {
      target: { value: "11111111-1111-4111-8111-111111111111" },
    });
    fireEvent.change(screen.getByLabelText("Com alguma destas etiquetas"), {
      target: { value: "QA — Wave 6 sem destinatários" },
    });
    fireEvent.change(screen.getByLabelText("Texto da mensagem"), {
      target: { value: "Parágrafo 1\n\nParágrafo 2" },
    });
    fireEvent.click(screen.getByRole("checkbox", { name: /Dividir a mensagem em balões/ }));
    fireEvent.click(screen.getByRole("button", { name: "Salvar rascunho" }));

    await waitFor(() => expect(mocks.criar).toHaveBeenCalledTimes(1));

    const corpo = mocks.criar.mock.calls[0]?.[0] as Record<string, unknown>;
    const filtroSerializado = JSON.parse(JSON.stringify(corpo.audience_filter)) as unknown;
    expect(corpo.split_messages).toBe(true);
    expect(filtroDeAudienciaSchema.safeParse(filtroSerializado).success).toBe(true);
  });
});
