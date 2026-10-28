import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { resolveSlash, TemplateMenu } from "@/components/inbox/composer/TemplateMenu";

describe("resolveSlash", () => {
  it("abre com / no início e captura o query", () => {
    expect(resolveSlash("/fech")).toEqual({ open: true, query: "fech" });
    expect(resolveSlash("/")).toEqual({ open: true, query: "" });
  });
  it("não abre se tem espaço ou não começa com /", () => {
    expect(resolveSlash("/fech agora").open).toBe(false);
    expect(resolveSlash("oi")).toEqual({ open: false, query: "" });
  });
});

describe("TemplateMenu", () => {
  const templates = [
    { id: "1", title: "Saudação", body: "Oi {{primeiro_nome}}", shortcut: "oi" },
    { id: "2", title: "Fechamento", body: "Fechado!", shortcut: "fech" },
    { id: "3", title: "Resposta fora da barra", body: "Continua disponível", shortcut: null, mostrar_na_barra: false },
  ];
  it("filtra por título/shortcut e devolve o escolhido", () => {
    const onPick = vi.fn();
    render(<TemplateMenu open query="fech" templates={templates as never} onPick={onPick} onClose={() => {}} />);
    fireEvent.click(screen.getByText("Fechamento"));
    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: "2" }));
  });

  it("mantém no menu / as respostas ocultas da barra do composer", () => {
    render(<TemplateMenu open query="" templates={templates as never} onPick={() => {}} onClose={() => {}} />);
    expect(screen.getByText("Resposta fora da barra")).toBeInTheDocument();
  });
});
