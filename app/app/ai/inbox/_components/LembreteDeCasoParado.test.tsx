import { beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";

import { atualizarLembreteDeCasoParado } from "@/app/actions/settings/atualizarLembreteDeCasoParado";
import { LembreteDeCasoParado } from "./LembreteDeCasoParado";

vi.mock("@/app/actions/settings/atualizarLembreteDeCasoParado", () => ({
  atualizarLembreteDeCasoParado: vi.fn(async () => ({ ok: true })),
}));
const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: routerPush }) }));
vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("LembreteDeCasoParado", () => {
  beforeEach(() => vi.clearAllMocks());

  it("expõe estado, faixa de cadência e salva os valores editados", async () => {
    render(<LembreteDeCasoParado config={{ enabled: true, interval_hours: 24, limit: 3 }} />);
    expect(screen.getByLabelText("Ativar lembretes de caso parado")).toBeChecked();

    fireEvent.click(screen.getByLabelText("Ativar lembretes de caso parado"));
    fireEvent.change(screen.getByLabelText("Intervalo entre lembretes (horas)"), { target: { value: "12" } });
    fireEvent.change(screen.getByLabelText("Máximo por espera humana"), { target: { value: "5" } });
    fireEvent.click(screen.getByRole("button", { name: "Salvar configuração" }));

    await waitFor(() => expect(atualizarLembreteDeCasoParado).toHaveBeenCalledWith({
      enabled: false,
      interval_hours: 12,
      limit: 5,
    }));
  });

  it("envia a pessoa ao challenge quando a action exige MFA", async () => {
    vi.mocked(atualizarLembreteDeCasoParado).mockResolvedValue({ ok: false, error: "mfa_required" });
    render(<LembreteDeCasoParado config={{ enabled: true, interval_hours: 24, limit: 3 }} />);

    fireEvent.click(screen.getByRole("button", { name: "Salvar configuração" }));
    await waitFor(() => expect(routerPush).toHaveBeenCalledWith("/login/mfa?next=/app/ai/inbox"));
  });
});
