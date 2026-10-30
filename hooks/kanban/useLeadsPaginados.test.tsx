import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  orgId: "org-a" as string | null,
  realtimeOptions: null as null | { onChange: (payload: unknown) => void },
}));

vi.mock("@/hooks/auth/AuthProvider", () => ({
  useActiveOrg: () => mocks.orgId ? { orgId: mocks.orgId } : null,
}));
vi.mock("@/hooks/realtime/useRealtimeChannel", () => ({
  useRealtimeChannel: (options: { onChange: (payload: unknown) => void }) => {
    mocks.realtimeOptions = options;
    return { status: "subscribed", ultimaEntrega: { current: null } };
  },
}));
vi.mock("@/lib/api/client", () => ({
  apiClient: { get: vi.fn(async () => ({ data: [], meta: { page: 1, per_page: 50, total: 0, has_more: false } })) },
}));

import { apiClient } from "@/lib/api/client";
import { useLeadsPaginados, chaveDaListaDoFunil } from "./useLeadsPaginados";

const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

describe("useLeadsPaginados", () => {
  it("carrega só a página pedida e escopa a chave de cache por organização", async () => {
    mocks.orgId = "org-a";
    mocks.realtimeOptions = null;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useLeadsPaginados("pipeline-a", 2, 25), { wrapper });
    await vi.waitFor(() => expect(apiClient.get).toHaveBeenCalledWith(
      "/api/v1/pipelines/pipeline-a/leads?page=2&per_page=25",
    ));
    expect(chaveDaListaDoFunil("org-a", "pipeline-a", 2, 25)).not.toEqual(
      chaveDaListaDoFunil("org-b", "pipeline-a", 2, 25),
    );
    expect(mocks.realtimeOptions).not.toBeNull();
    queryClient.clear();
  });

  it("inclui filtros na query e separa o cache por owner/status de forma determinística", async () => {
    mocks.orgId = "org-a";
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(
      () => useLeadsPaginados("pipeline-a", 1, 50, { owner: OWNER_A, status: "won" }),
      { wrapper },
    );
    await vi.waitFor(() => expect(apiClient.get).toHaveBeenCalledWith(
      `/api/v1/pipelines/pipeline-a/leads?page=1&per_page=50&owner=${OWNER_A}&status=won`,
    ));

    const ownerA = chaveDaListaDoFunil("org-a", "pipeline-a", 1, 50, `owner=${OWNER_A}`);
    const ownerB = chaveDaListaDoFunil("org-a", "pipeline-a", 1, 50, `owner=${OWNER_B}`);
    const statusWon = chaveDaListaDoFunil("org-a", "pipeline-a", 1, 50, "status=won");
    expect(ownerA).not.toEqual(ownerB);
    expect(ownerA).not.toEqual(statusWon);
    expect(chaveDaListaDoFunil("org-a", "pipeline-a", 1, 50, `owner=${OWNER_A}`)).toEqual(ownerA);
    queryClient.clear();
  });

  it("evento do funil invalida todas as páginas daquele tenant", async () => {
    mocks.orgId = "org-a";
    mocks.realtimeOptions = null;
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const wrapper = ({ children }: { children: React.ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );

    renderHook(() => useLeadsPaginados("pipeline-a", 1, 50), { wrapper });
    await vi.waitFor(() => expect(mocks.realtimeOptions).not.toBeNull());
    const options = mocks.realtimeOptions as { onChange: (payload: unknown) => void } | null;
    options?.onChange({});
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: ["pipeline-leads-list", "org-a", "pipeline-a"],
    });
    queryClient.clear();
  });
});
