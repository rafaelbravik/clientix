import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));

import { FormularioDeItem } from "@/app/app/comandas/_client";
import { FormularioDeContrato } from "@/app/app/honorarios/_client";
import { FormularioDeParcela } from "@/app/app/honorarios/_parcelas";

describe("inputs de comanda na moeda da comanda", () => {
  it("converte agrupamento USD para os centésimos esperados", async () => {
    const onIncluir = vi.fn();
    const usuario = userEvent.setup();
    render(<FormularioDeItem tipos={[]} moeda="USD" onIncluir={onIncluir} pendente={false} />);

    await usuario.type(screen.getByTestId("item-descricao"), "Serviço");
    await usuario.type(screen.getByTestId("item-valor"), "1,300");
    await usuario.click(screen.getByTestId("incluir-item"));

    expect(onIncluir).toHaveBeenCalledWith(expect.objectContaining({
      description: "Serviço",
      unit_price_cents: 130000,
    }));
  });
});

describe("inputs de honorários na moeda da organização", () => {
  it("converte valor fixo USD", async () => {
    const onCriar = vi.fn();
    const usuario = userEvent.setup();
    render(<FormularioDeContrato criando={false} moeda="USD" onCriar={onCriar} />);

    await usuario.type(screen.getByTestId("contrato-valor-fixo"), "1,300");
    await usuario.click(screen.getByTestId("criar-contrato"));

    expect(onCriar).toHaveBeenCalledWith(expect.objectContaining({
      modelo: "fixo",
      valor_fixo_cents: 130000,
    }));
  });

  it("converte parcela USD e mantém data e número do fluxo", async () => {
    const onCriar = vi.fn();
    const usuario = userEvent.setup();
    render(
      <FormularioDeParcela
        proximoNumero={1}
        criando={false}
        moeda="USD"
        onCriar={onCriar}
      />,
    );

    await usuario.type(screen.getByTestId("parcela-valor"), "1,300");
    fireEvent.change(screen.getByTestId("parcela-vencimento"), {
      target: { value: "2026-11-01" },
    });
    await usuario.click(screen.getByTestId("criar-parcela"));

    expect(onCriar).toHaveBeenCalledWith({
      numero: 1,
      vencimento: "2026-11-01",
      valor_cents: 130000,
    });
  });
});
