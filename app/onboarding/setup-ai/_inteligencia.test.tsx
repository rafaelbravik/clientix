import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));
vi.mock("@/app/actions/onboarding/chaveDaIa", () => ({ salvarChaveDaIa: vi.fn() }));
vi.mock("sonner", () => ({ toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() } }));

import { InteligenciaDele } from "./_inteligencia";

const inicial = { origem: "nenhuma" as const, provedor: "anthropic", rotulo: "Anthropic", final: null };

afterEach(cleanup);

describe("onboarding da assinatura ChatGPT", () => {
  it("oferece um caminho separado do campo de chave somente com o módulo ligado", () => {
    render(<InteligenciaDele inicial={inicial} assinaturaNoOnboarding />);

    const link = screen.getByRole("link", { name: "Conectar assinatura do ChatGPT" });
    expect(link).toHaveAttribute("href", "/app/ai/credentials");
    expect(screen.getByText(/A publicação por assinatura ainda não está disponível/)).toBeTruthy();

    const seletor = screen.getByLabelText("Qual você contratou");
    expect(within(seletor).queryByRole("option", { name: /assinatura do chatgpt/i })).toBeNull();
    expect(screen.queryByLabelText("A chave")).not.toBeNull();
  });

  it("não oferece assinatura quando login_codex está desligado", () => {
    render(<InteligenciaDele inicial={inicial} assinaturaNoOnboarding={false} />);

    expect(screen.queryByRole("link", { name: "Conectar assinatura do ChatGPT" })).toBeNull();
    expect(within(screen.getByLabelText("Qual você contratou"))
      .queryByRole("option", { name: /assinatura do chatgpt/i })).toBeNull();
  });
});
