import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));

import { QuickRepliesBar } from "@/components/inbox/composer/QuickRepliesBar";

function templates(count: number): MessageTemplate[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `t-${index}`,
    title: `Resposta ${index}`,
    body: `Texto ${index}`,
    shortcut: null,
    owner_user_id: "user-a",
    mostrar_na_barra: true,
  }));
}

describe("QuickRepliesBar", () => {
  beforeEach(() => localStorage.clear());

  it("expande, recolhe e mantém a escolha no reload do mesmo usuário", () => {
    const all = templates(7);
    const onPick = vi.fn();
    const first = render(
      <QuickRepliesBar userId="user-a" templates={all} disabled={false} onPick={onPick} />,
    );
    expect(screen.getAllByRole("button", { name: /^Resposta/ })).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Mais respostas (1)" }));
    expect(screen.getAllByRole("button", { name: /^Resposta/ })).toHaveLength(7);
    first.unmount();

    render(<QuickRepliesBar userId="user-a" templates={all} disabled={false} onPick={onPick} />);
    expect(screen.getAllByRole("button", { name: /^Resposta/ })).toHaveLength(7);
    expect(screen.getByRole("button", { name: "Menos respostas" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    fireEvent.click(screen.getByRole("button", { name: "Menos respostas" }));
    expect(screen.getAllByRole("button", { name: /^Resposta/ })).toHaveLength(6);
  });

  it("não reutiliza a preferência de outro usuário e aplica a resposta escolhida", () => {
    const all = templates(7);
    const onPick = vi.fn();
    const expanded = render(
      <QuickRepliesBar userId="user-a" templates={all} disabled={false} onPick={onPick} />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Mais respostas (1)" }));
    expanded.unmount();

    render(<QuickRepliesBar userId="user-b" templates={all} disabled={false} onPick={onPick} />);
    expect(screen.getAllByRole("button", { name: /^Resposta/ })).toHaveLength(6);
    fireEvent.click(screen.getByRole("button", { name: "Resposta 0" }));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "t-0" }));
  });
});
