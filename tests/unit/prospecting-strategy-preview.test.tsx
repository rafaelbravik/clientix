import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import "@testing-library/jest-dom/vitest";
import { StrategyPreview } from "@/components/prospecting/StrategyPreview";
import { estrategiaDoCandidato } from "@/lib/prospecting/estrategia-site";
import type { PreviaSalva } from "@/lib/prospecting/previa";

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (text: string) => text }));

const strategy = estrategiaDoCandidato({ website: "https://empresa.example" });
const preview = { texto: "Prévia <script>alert(1)</script> literal", ver: 1 } as PreviaSalva;

afterEach(() => cleanup());

describe("painel de estratégia e prévia", () => {
  it("mostra verificação pendente e não dispara geração ao renderizar", () => {
    const onGenerate = vi.fn();
    render(<StrategyPreview strategy={strategy} preview={null} previewState="none" busy={false} error={null} onGenerate={onGenerate} />);
    expect(screen.getByText("Verificação pendente")).toBeVisible();
    expect(screen.getByText(strategy.angulo)).toBeVisible();
    expect(onGenerate).not.toHaveBeenCalled();
  });

  it("gera prévia somente após clique e deixa erro separado da auditoria", () => {
    const onGenerate = vi.fn();
    render(<StrategyPreview strategy={strategy} preview={null} previewState="none" busy={false} error="Não foi possível gerar a prévia." onGenerate={onGenerate} />);
    expect(screen.getByText("Verificação pendente")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("Não foi possível gerar a prévia.");
    fireEvent.click(screen.getByRole("button", { name: "Gerar prévia" }));
    expect(onGenerate).toHaveBeenCalledOnce();
    expect(screen.getByText(strategy.angulo)).toBeVisible();
  });

  it("marca preview stale e não renderiza texto antigo como atual", () => {
    render(<StrategyPreview strategy={strategy} preview={preview} previewState="stale" busy={false} error={null} onGenerate={vi.fn()} />);
    expect(screen.getByText("Desatualizada")).toBeVisible();
    expect(screen.getByText("A auditoria ou a versão do agente mudou. Gere uma nova prévia antes de usar o texto anterior.")).toBeVisible();
    expect(screen.queryByText(preview.texto)).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Gerar nova prévia" })).toBeEnabled();
  });

  it("renderiza saída do modelo como texto, sem interpretar HTML", () => {
    const current = { ...preview, texto: "<b>texto simples, sem markup renderizado</b>" };
    render(<StrategyPreview strategy={strategy} preview={current} previewState="ready" busy={false} error={null} onGenerate={vi.fn()} />);
    expect(screen.getByText(current.texto)).toBeVisible();
    expect(document.querySelector("b")).toBeNull();
    expect(screen.getByText("A prévia é um rascunho para revisão. Nenhuma mensagem é enviada.")).toBeVisible();
  });

  it("mostra estado de geração e desabilita ação duplicada", () => {
    render(<StrategyPreview strategy={strategy} preview={null} previewState="none" busy error={null} onGenerate={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Gerando…" })).toBeDisabled();
  });
});
