import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  organizationId: "org-a" as string | null,
  useQuery: vi.fn(),
}));

vi.mock("@tanstack/react-query", () => ({ useQuery: mocks.useQuery }));
vi.mock("@/hooks/auth/AuthProvider", () => ({
  useOptionalActiveOrg: () => mocks.organizationId ? { orgId: mocks.organizationId } : null,
}));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));

import { CHATGPT_SUBSCRIPTION_PROVIDER } from "@/lib/ai/credenciais/chatgpt-subscription-constants";
import { ModelPicker, providerModelsQueryKey } from "./ModelPicker";

describe("ModelPicker para assinatura ChatGPT", () => {
  beforeEach(() => {
    mocks.organizationId = "org-a";
    mocks.useQuery.mockReturnValue({ data: [], isError: false, isLoading: false, isFetching: false });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("qualifica o cache por organização e provider", () => {
    expect(providerModelsQueryKey("org-a", CHATGPT_SUBSCRIPTION_PROVIDER)).toEqual([
      "ai", "providers", "org-a", CHATGPT_SUBSCRIPTION_PROVIDER, "models",
    ]);
    expect(providerModelsQueryKey("org-a", CHATGPT_SUBSCRIPTION_PROVIDER)).not.toEqual(
      providerModelsQueryKey("org-b", CHATGPT_SUBSCRIPTION_PROVIDER),
    );
    expect(providerModelsQueryKey("org-a", CHATGPT_SUBSCRIPTION_PROVIDER)).not.toEqual(
      providerModelsQueryKey("org-a", "openai"),
    );
  });

  it("trocar de organização seleciona outra chave e não reutiliza o cache anterior", () => {
    const picker = (provider: "openai-assinatura") => (
      <ModelPicker provider={provider} value="" onChange={() => undefined} />
    );
    const view = render(picker(CHATGPT_SUBSCRIPTION_PROVIDER));
    expect(mocks.useQuery.mock.calls.at(-1)?.[0].queryKey).toEqual(
      providerModelsQueryKey("org-a", CHATGPT_SUBSCRIPTION_PROVIDER),
    );

    mocks.organizationId = "org-b";
    view.rerender(picker(CHATGPT_SUBSCRIPTION_PROVIDER));
    expect(mocks.useQuery.mock.calls.at(-1)?.[0].queryKey).toEqual(
      providerModelsQueryKey("org-b", CHATGPT_SUBSCRIPTION_PROVIDER),
    );
  });

  it("catálogo vazio não oferece identificador manual para contornar a lista da conta", () => {
    render(<ModelPicker provider={CHATGPT_SUBSCRIPTION_PROVIDER} value="" onChange={() => undefined} />);
    expect(screen.getByText("A conta está conectada, mas não há modelos disponíveis para seleção.")).toBeTruthy();
    expect(screen.queryByPlaceholderText("Digite o identificador do modelo")).toBeNull();
  });
});
