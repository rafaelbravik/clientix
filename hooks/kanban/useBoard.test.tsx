import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/api/client", () => ({ apiClient: { get: vi.fn() } }));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: () => ({ status: "closed", ultimaEntrega: { current: null } }),
}));
vi.mock("@/hooks/realtime/useRefetchDeSeguranca", () => ({
  useRefetchDeSeguranca: () => ({ divergencias: 0, ultimaVerificacao: null }),
}));

import { apiClient } from "@/lib/api/client";
import { useBoard } from "./useBoard";

describe("useBoard desligado", () => {
  beforeEach(() => vi.clearAllMocks());

  it("não consulta /board quando a Lista passa pipelineId null", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useBoard(null), { wrapper });
    await Promise.resolve();
    expect(apiClient.get).not.toHaveBeenCalled();
    queryClient.clear();
  });
});
