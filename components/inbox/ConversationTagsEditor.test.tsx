import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const { mutate, vocabulary } = vi.hoisted(() => ({
  mutate: vi.fn(),
  vocabulary: { current: [] as string[] },
}));

vi.mock("@/hooks/inbox/useConversationTags", () => ({
  useUpdateConversationTags: () => ({ mutate, isPending: false }),
  useConversationTagVocabulary: () => ({ data: vocabulary.current }),
}));

import { ConversationTagsEditor } from "@/components/inbox/ConversationTagsEditor";

beforeEach(() => {
  mutate.mockReset();
  vocabulary.current = [];
});

describe("ConversationTagsEditor — existente antes de criar", () => {
  const renderEditor = (tags: string[] = []) =>
    render(<ConversationTagsEditor conversationId="conv-1" orgId="org-1" tags={tags} />);
  const campo = () => screen.getByLabelText("Adicionar tag à conversa");
  const opcoes = () =>
    screen
      .getAllByRole("button")
      .map((button) => (button.textContent ?? "").replace(/\s+/g, " ").trim())
      .filter((label) => label.startsWith("+ ") || label.startsWith("Criar «"));

  it("Enter aplica o valor canônico conhecido, sem criar variante com acento", async () => {
    vocabulary.current = ["carteira-andreia", "carteira-danilo"];
    renderEditor();

    await userEvent.type(campo(), "CARTEIRA-ANDRÉIA{Enter}");

    expect(mutate).toHaveBeenCalledTimes(1);
    expect(mutate).toHaveBeenCalledWith({
      conversation_id: "conv-1",
      tags: ["carteira-andreia"],
    });
  });

  it("mantém ordem das sugestões e põe Criar depois de todas", async () => {
    vocabulary.current = ["carteira-andreia", "carteira-danilo", "vip"];
    renderEditor();

    await userEvent.type(campo(), "carteira");

    expect(opcoes()).toEqual([
      "+ carteira-andreia",
      "+ carteira-danilo",
      "Criar «carteira»",
    ]);
  });

  it("esconde Criar para equivalência existente e mantém a sugestão clicável", async () => {
    vocabulary.current = ["carteira-andreia"];
    renderEditor();

    await userEvent.type(campo(), "Carteira-Andréia");

    expect(screen.getByRole("button", { name: "+ carteira-andreia" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Criar «/ })).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "+ carteira-andreia" }));
    expect(mutate).toHaveBeenCalledWith({ conversation_id: "conv-1", tags: ["carteira-andreia"] });
    expect(document.activeElement).toBe(campo());
  });

  it("clique em Criar usa a mesma normalização da ação de Enter", async () => {
    vocabulary.current = ["vip"];
    renderEditor();

    await userEvent.type(campo(), "  Nova Tag  ");
    await userEvent.click(screen.getByRole("button", { name: "Criar «nova tag»" }));

    expect(mutate).toHaveBeenCalledWith({ conversation_id: "conv-1", tags: ["nova tag"] });
    expect(document.activeElement).toBe(campo());
  });

  it("não oferece criação quando o limite de vinte tags foi atingido", () => {
    renderEditor(Array.from({ length: 20 }, (_, i) => `tag-${i}`));
    expect(campo()).toHaveProperty("disabled", true);
    expect(screen.queryByRole("button", { name: /^Criar «/ })).toBeNull();
  });
});
