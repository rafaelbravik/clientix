import { beforeEach, describe, expect, it } from "vitest";
import {
  chaveDaPreferenciaDaBarra,
  lerBarraExpandida,
  respostasMostradas,
  respostasVisiveisNaBarra,
  salvarBarraExpandida,
} from "@/lib/inbox/barra-de-respostas";
import type { MessageTemplate } from "@/hooks/inbox/useMessageTemplates";

function template(id: number, mostrar_na_barra?: boolean): MessageTemplate {
  return {
    id: `template-${id}`,
    title: `Resposta ${id}`,
    body: `Texto ${id}`,
    shortcut: null,
    owner_user_id: "user-a",
    ...(mostrar_na_barra === undefined ? {} : { mostrar_na_barra }),
  };
}

describe("preferências da barra de respostas rápidas", () => {
  beforeEach(() => localStorage.clear());

  it("inclui registros antigos e defaults true, ocultando somente false", () => {
    expect(
      respostasVisiveisNaBarra([template(1), template(2, true), template(3, false)]).map(
        (t) => t.id,
      ),
    ).toEqual(["template-1", "template-2"]);
  });

  it("recolhida mostra seis respostas e informa quantas faltam", () => {
    const result = respostasMostradas(
      Array.from({ length: 8 }, (_, i) => template(i + 1)),
      false,
    );
    expect(result.visiveis).toHaveLength(6);
    expect(result.restantes).toBe(2);
  });

  it("expandida mostra todas e recolhida não persiste entre usuários", () => {
    const todos = Array.from({ length: 8 }, (_, i) => template(i + 1));
    expect(respostasMostradas(todos, true).visiveis).toHaveLength(8);
    salvarBarraExpandida("user-a", true);
    expect(lerBarraExpandida("user-a")).toBe(true);
    expect(lerBarraExpandida("user-b")).toBe(false);
    expect(localStorage.getItem(chaveDaPreferenciaDaBarra("user-a"))).toBe("expanded");
  });

  it("fail-soft se localStorage estiver indisponível", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    } as unknown as Storage;
    expect(lerBarraExpandida("user-a", storage)).toBe(false);
    expect(() => salvarBarraExpandida("user-a", true, storage)).not.toThrow();
  });
});
