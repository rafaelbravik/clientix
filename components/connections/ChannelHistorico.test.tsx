import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  invalidate: vi.fn(),
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
  queryData: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ isLoading: false, isError: false, data: mocks.queryData }),
  useQueryClient: () => ({ invalidateQueries: mocks.invalidate }),
}));
vi.mock("@/lib/api/client", () => ({ apiClient: { get: mocks.get, post: mocks.post } }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (value: string) => value }));
vi.mock("sonner", () => ({ toast: { success: mocks.toastSuccess, error: mocks.toastError } }));

import { ChannelHistorico } from "./ChannelHistorico";

describe("ChannelHistorico", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.queryData = { history_supported: true, reason_code: null, import: null };
  });

  it("pede prévia e exige confirmação explícita antes de iniciar", async () => {
    mocks.get.mockResolvedValue({ data: {
      history_supported: true,
      reason_code: null,
      import: null,
      preview: { range_days: 90, range_start: "2026-07-27T00:00:00.000Z", conversations: 2, messages: 14, audios: 1, images: 3, partial: false },
    } });
    mocks.post.mockResolvedValue({ data: {} });

    render(<ChannelHistorico channelId="session-1" status="WORKING" />);
    fireEvent.click(screen.getByRole("button", { name: "Ver prévia" }));
    await screen.findByText(/2 conversas/);
    fireEvent.click(screen.getByRole("button", { name: "Importar este período" }));

    await waitFor(() => expect(mocks.post).toHaveBeenCalledWith(
      "/api/v1/channel-sessions/session-1/historico",
      { range_days: 90, preview_confirmed: true },
    ));
    expect(mocks.invalidate).toHaveBeenCalledWith({ queryKey: ["whatsapp-history", "session-1"] });
  });

  it("mostra progresso e código sanitizado sem expor cursor ou identificadores técnicos", () => {
    mocks.queryData = {
      history_supported: true,
      reason_code: null,
      import: {
        id: "job-interno",
        status: "running",
        range_days: 90,
        range_start: "2026-07-27T00:00:00.000Z",
        imported_count: 12,
        skipped_count: 2,
        failed_count: 0,
        last_error_code: null,
        started_at: "2026-10-25T00:00:00.000Z",
        finished_at: null,
        updated_at: "2026-10-25T00:00:00.000Z",
      },
    };
    render(<ChannelHistorico channelId="session-1" status="WORKING" />);
    expect(screen.getByText("Importação em andamento")).toBeTruthy();
    expect(screen.getByText(/12 mensagens importadas/)).toBeTruthy();
    expect(screen.queryByText("job-interno")).toBeNull();
  });
});
