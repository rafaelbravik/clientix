import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({
  useT: () => (texto: string) => texto,
}));

import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";

describe("alvo de toque para fechar a ficha do contato", () => {
  it("aceita classes de dimensão específicas para o botão de fechar", async () => {
    render(
      <Sheet open>
        <SheetContent closeButtonClassName="grid size-11 place-items-center p-0">
          <SheetTitle>Ficha do contato</SheetTitle>
        </SheetContent>
      </Sheet>,
    );

    expect(await screen.findByRole("button", { name: "Fechar" })).toHaveClass(
      "size-11",
      "grid",
      "place-items-center",
      "p-0",
    );
  });
});
