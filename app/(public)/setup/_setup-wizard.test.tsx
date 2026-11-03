import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));

import { SetupWizard } from "./_setup-wizard";

const TOKEN = "bootstrap-token-de-teste-256-bits".padEnd(64, "x");
const PASSWORD = "Senha-segura-123!";

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: async () => ({ data: { initialized: true } }),
  });
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("assistente de configuração inicial", () => {
  it("percorre as etapas, oculta a senha na revisão e conclui a inicialização", async () => {
    render(<SetupWizard />);

    expect(screen.getByRole("heading", { name: "Configurar Clientix" })).toBeInTheDocument();
    expect(screen.getByRole("progressbar", { name: "Progresso da configuração" })).toHaveAttribute(
      "aria-valuenow",
      "1",
    );

    fireEvent.change(screen.getByLabelText("Token de configuração"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Começar configuração" }));

    fireEvent.change(screen.getByLabelText("Nome completo"), { target: { value: "Rafael Exemplo" } });
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "rafael@example.test" } });
    fireEvent.change(screen.getByLabelText("Senha"), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText("Confirmar senha"), { target: { value: PASSWORD } });
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));

    fireEvent.change(screen.getByLabelText("Nome da instalação"), { target: { value: "Clientix Agência Demo" } });
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));

    expect(screen.getByText("Rafael Exemplo")).toBeInTheDocument();
    expect(screen.getByText("rafael@example.test")).toBeInTheDocument();
    expect(screen.getByText("Clientix Agência Demo")).toBeInTheDocument();
    expect(screen.queryByText(PASSWORD)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Finalizar configuração" }));

    await waitFor(() => expect(screen.getByText("Configuração concluída")).toBeInTheDocument());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/setup/initialize",
      expect.objectContaining({ method: "POST", cache: "no-store" }),
    );
    const body = JSON.parse(fetchMock.mock.calls[0]?.[1]?.body as string) as Record<string, string>;
    expect(body).toMatchObject({
      bootstrap_token: TOKEN,
      full_name: "Rafael Exemplo",
      email: "rafael@example.test",
      password: PASSWORD,
      password_confirmation: PASSWORD,
      platform_name: "Clientix Agência Demo",
    });
    expect(screen.getByRole("link", { name: "Entrar no painel global" })).toHaveAttribute(
      "href",
      "/login?next=%2Fadmin",
    );
  });

  it("não avança quando a confirmação de senha difere", () => {
    render(<SetupWizard />);
    fireEvent.change(screen.getByLabelText("Token de configuração"), { target: { value: TOKEN } });
    fireEvent.click(screen.getByRole("button", { name: "Começar configuração" }));
    fireEvent.change(screen.getByLabelText("Nome completo"), { target: { value: "Rafael Exemplo" } });
    fireEvent.change(screen.getByLabelText("E-mail"), { target: { value: "rafael@example.test" } });
    fireEvent.change(screen.getByLabelText("Senha"), { target: { value: PASSWORD } });
    fireEvent.change(screen.getByLabelText("Confirmar senha"), { target: { value: "outra-senha-123!" } });
    fireEvent.click(screen.getByRole("button", { name: "Continuar" }));

    expect(screen.getByRole("alert")).toHaveTextContent("As senhas não coincidem.");
    expect(screen.getByLabelText("Confirmar senha")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
