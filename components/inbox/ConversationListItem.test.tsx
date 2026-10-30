/**
 * A etiqueta "Grupo" na lista de conversas.
 *
 * `conversations.is_group` já chega no `SELECT_COLS` do handler (schema
 * original) — este teste prende só a LEITURA na tela: quem abre o inbox
 * precisa distinguir uma conversa de grupo de uma individual sem abrir cada
 * uma. Props mínimas copiadas de `ConversationList.tsx`, via
 * `__fixtures__/conversa.ts`.
 */
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { ConversationListItem } from "./ConversationListItem";
import { conversaDeExemplo } from "./__fixtures__/conversa";

describe("ConversationListItem — etiqueta de grupo", () => {
  it("conversa de grupo tem a etiqueta Grupo", () => {
    render(
      <ConversationListItem
        conversation={{ ...conversaDeExemplo.conversation, is_group: true }}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.getByText("Grupo")).toBeInTheDocument();
  });

  it("conversa individual não tem", () => {
    render(
      <ConversationListItem
        conversation={{ ...conversaDeExemplo.conversation, is_group: false }}
        {...conversaDeExemplo.props}
      />,
    );
    expect(screen.queryByText("Grupo")).toBeNull();
  });
});

describe("ConversationListItem — etiquetas escondidas", () => {
  function montarComTags(tags: string[]) {
    const conversation = {
      ...conversaDeExemplo.conversation,
      contacts: {
        ...conversaDeExemplo.conversation.contacts!,
        tags,
      },
    };
    return render(<ConversationListItem conversation={conversation} {...conversaDeExemplo.props} />);
  }

  it("duas etiquetas visíveis não criam +N", () => {
    montarComTags(["retorno", "boleto"]);
    expect(screen.queryByText(/^\+\d+$/)).toBeNull();
  });

  it("+1 revela somente a etiqueta escondida", () => {
    montarComTags(["retorno", "boleto", "urgente"]);
    expect(screen.getByText("+1")).toHaveAttribute("title", "urgente");
  });

  it("+N revela as etiquetas restantes na ordem existente", () => {
    montarComTags(["retorno", "boleto", "venda", "pos-venda"]);
    expect(screen.getByText("+2")).toHaveAttribute("title", "venda, pos-venda");
  });
});
