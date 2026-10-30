import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getMock = vi.fn();
const postMock = vi.fn();
vi.mock("@/lib/api/client", () => ({
  apiClient: {
    get: (...args: unknown[]) => getMock(...args),
    post: (...args: unknown[]) => postMock(...args),
  },
}));

vi.mock("@/components/feedback/ApiErrorToast", () => ({
  showApiError: vi.fn(),
}));

import { ReplyReviewPanel } from "@/components/inbox/composer/ReplyReviewPanel";

function renderPanel(disabled = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <ReplyReviewPanel conversationId="conversation-sintetica" disabled={disabled} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  getMock.mockReset().mockResolvedValue({ data: { drafts: [] } });
  postMock.mockReset().mockResolvedValue({});
});

describe("dica do botão ativo de sugestão de resposta", () => {
  it("abre no foco de teclado e fecha ao perder foco sem alterar o botão ou chamar API de escrita", async () => {
    renderPanel();
    const button = await screen.findByRole("button", { name: "Sugerir resposta" });
    const parentBeforeFocus = button.parentElement;

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(button).toHaveAccessibleName("Sugerir resposta");
    expect(button).toHaveAttribute("type", "button");
    expect(button).toHaveClass("inline-flex");

    const user = userEvent.setup();
    await user.tab();
    expect(button).toHaveFocus();
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Sugerir resposta");
    expect(button.parentElement).toBe(parentBeforeFocus);

    await user.tab();
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(postMock).not.toHaveBeenCalled();
  });

  it("abre no hover, fecha ao sair e mantém o fluxo de geração no clique", async () => {
    renderPanel();
    const button = await screen.findByRole("button", { name: "Sugerir resposta" });

    const user = userEvent.setup();
    await user.hover(button);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Sugerir resposta");

    await user.unhover(button);
    await waitFor(() => expect(screen.queryByRole("tooltip")).not.toBeInTheDocument());
    expect(getMock).toHaveBeenCalledTimes(1);
    expect(postMock).not.toHaveBeenCalled();

    await user.click(button);
    await waitFor(() =>
      expect(postMock).toHaveBeenCalledWith(
        "/api/v1/conversations/conversation-sintetica/draft-reply",
        {},
      ),
    );
  });

  it("mantém o botão desabilitado sem disparar geração ou tooltip", async () => {
    renderPanel(true);
    const button = await screen.findByRole("button", { name: "Sugerir resposta" });

    expect(button).toBeDisabled();
    const user = userEvent.setup();
    await user.hover(button);
    await user.click(button);

    expect(screen.queryByRole("tooltip")).not.toBeInTheDocument();
    expect(postMock).not.toHaveBeenCalled();
  });
});
