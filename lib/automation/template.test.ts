import { describe, it, expect } from "vitest";
import { anexarDefinicoesDeLista } from "@/lib/automation/campos-do-render";
import { evaluateConditions } from "@/lib/automation/conditions";
import { marcacaoDoCrm, renderTemplate } from "@/lib/automation/template";

const ctx = {
  contact: { name: "Ana" },
  lead: { title: "Pedido X", custom_fields: { cupom: "BF10" } },
};

describe("renderTemplate", () => {
  it("variável simples", () => expect(renderTemplate("Oi {{contact.name}}!", ctx)).toBe("Oi Ana!"));
  it("path aninhado", () =>
    expect(renderTemplate("Use {{lead.custom_fields.cupom}}", ctx)).toBe("Use BF10"));
  it("alias {{nome}} resolve contact.name", () =>
    expect(renderTemplate("Oi {{nome}}", ctx)).toBe("Oi Ana"));
  it("variável ausente vira vazio, não '{{...}}' cru", () =>
    expect(renderTemplate("X{{lead.ghost}}Y", ctx)).toBe("XY"));
  it("espaços dentro das chaves tolerados", () =>
    expect(renderTemplate("Oi {{ contact.name }}", ctx)).toBe("Oi Ana"));
  it("{{primeiro_nome}} é a primeira palavra do nome, como no Inbox (#1616)", () =>
    expect(
      renderTemplate("Olá, {{primeiro_nome}}!", { contact: { name: "  Maria  Souza " } }),
    ).toBe("Olá, Maria!"));
  it("{{primeiro_nome}} sem contato vira vazio, para a lacuna continuar visível", () => {
    expect(renderTemplate("Olá, {{primeiro_nome}}!", {})).toBe("Olá, !");
    expect(renderTemplate("{{primeiro_nome}}", { contact: { name: null } })).toBe("");
  });

  const settings = {
    fields: [
      {
        key: "destino",
        label: "Destino",
        type: "select",
        options: [
          { value: "paris-franca", label: "Paris (França)" },
          { value: "aereo-a", label: "Aéreo A" },
          { value: "hotel-b", label: "Hotel B" },
        ],
      },
      {
        key: "preferencias",
        label: "Preferências",
        type: "multiselect",
        options: [
          { value: "aereo-a", label: "Aéreo A" },
          { value: "hotel-b", label: "Hotel B" },
        ],
      },
      {
        key: "nome",
        label: "Nome interno",
        type: "select",
        options: [{ value: "x", label: "Sequestrado" }],
      },
      {
        key: "operadora",
        label: "Operadora",
        type: "select",
        options: [{ value: "nova", label: "Nova" }],
      },
      {
        key: "texto",
        label: "Texto",
        type: "text",
        options: [{ value: "x", label: "Não traduzir" }],
      },
      { key: "sem_opcoes", label: "Sem opções", type: "select" },
    ],
  };

  function contextoComListas(): Record<string, unknown> {
    const context: Record<string, unknown> = {
      contact: { name: "Ana", custom_fields: { destino: "paris-franca" } },
      lead: {
        title: "Pedido X",
        pipeline_id: "pipeline-1",
        custom_fields: {
          destino: "paris-franca",
          preferencias: ["aereo-a", "hotel-b"],
          nome: "x",
          operadora: "operadora-removida",
          texto: "livre",
          sem_opcoes: "antigo",
        },
      },
    };
    anexarDefinicoesDeLista(context, settings);
    return context;
  }

  it("select simples, atalho e caminho explícito usam o rótulo", () => {
    const context = contextoComListas();
    expect(renderTemplate("Sua viagem para {{destino}}", context)).toBe(
      "Sua viagem para Paris (França)",
    );
    expect(renderTemplate("Sua viagem para {{lead.custom_fields.destino}}", context)).toBe(
      "Sua viagem para Paris (França)",
    );
  });

  it("multiselect usa rótulos separados por vírgula e espaço", () => {
    expect(renderTemplate("{{preferencias}}", contextoComListas())).toBe("Aéreo A, Hotel B");
  });

  it("valor que saiu das opções permanece visível", () => {
    expect(renderTemplate("{{operadora}}", contextoComListas())).toBe("operadora-removida");
  });

  it("campos não-lista e definições sem opções mantêm o valor canônico", () => {
    const context = contextoComListas();
    expect(renderTemplate("{{texto}}/{{sem_opcoes}}", context)).toBe("livre/antigo");
  });

  it("fallback só substitui valor vazio", () => {
    const context = contextoComListas();
    context.lead = {
      ...(context.lead as Record<string, unknown>),
      custom_fields: {
        ...(context.lead as { custom_fields: Record<string, unknown> }).custom_fields,
        destino: "",
      },
    };
    expect(renderTemplate('{{destino|"a definir"}}', context)).toBe("a definir");
    expect(renderTemplate('{{lead.custom_fields.destino|"a definir"}}', contextoComListas())).toBe(
      "Paris (França)",
    );
  });

  it("alias CRM nome tem precedência sobre campo personalizado homônimo", () => {
    const context = contextoComListas();
    expect(renderTemplate("{{nome}}", context)).toBe("Ana");
    expect(marcacaoDoCrm("nome", context)).toBe(true);
  });

  it("sem definições preserva o valor original e o join atual de arrays", () => {
    const context = {
      lead: { custom_fields: { destino: "codigo-antigo", preferencias: ["a", "b"] } },
    };
    expect(
      renderTemplate("{{destino}}/{{lead.custom_fields.destino}}/{{preferencias}}", context),
    ).toBe("codigo-antigo/codigo-antigo/a,b");
  });

  it("option inválida não inventa rótulo e campo-map interno não vira variável", () => {
    const context: Record<string, unknown> = {
      lead: { custom_fields: { destino: "paris-franca" } },
    };
    anexarDefinicoesDeLista(context, {
      fields: [
        { key: "destino", label: "Destino", type: "select", options: [{ value: 7, label: null }] },
      ],
    });
    expect(renderTemplate("{{destino}}/{{camposDoFunil}}", context)).toBe("paris-franca/");
    expect(Object.keys(context)).not.toContain("campos-do-funil");
  });

  it("contato.custom_fields permanece renderizável sem alterar aliases", () => {
    const context = contextoComListas();
    expect(renderTemplate("{{contact.custom_fields.destino}}", context)).toBe("Paris (França)");
  });

  it("condições continuam comparando o value canônico", () => {
    const context = contextoComListas();
    expect(
      evaluateConditions(
        [{ field: "lead.custom_fields.destino", op: "eq", value: "paris-franca" }],
        context,
      ),
    ).toBe(true);
    expect(renderTemplate("{{destino}}", context)).toBe("Paris (França)");
  });
});
