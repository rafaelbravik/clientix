/**
 * O editor de CAMPOS do funil — o que ele oferece e o que ele deixa editar.
 *
 * O defeito que estes testes trancam: a lista de tipos desta tela era digitada
 * à mão e ficou menor que a de `customFieldSchema`. `multiselect` era aceito
 * pelo schema, gravado pela API e desenhado no dossiê do contato, mas não
 * existia aqui — então um campo desse tipo abria com o seletor EM BRANCO (nenhum
 * `SelectItem` casava com o `value`) e sem a linha de opções, que só aparecia
 * para `select`. Quem administrava via um campo aparentemente corrompido, sem
 * como editar, e o conserto intuitivo (escolher um tipo qualquer para tirar o
 * branco) rebaixava a escolha múltipla para escolha única.
 *
 * Por isso os testes medem o par: a tela OFERECE todo tipo que o schema aceita,
 * e mostra as opções para TODO tipo de lista fechada — não só para `select`.
 */
import { beforeEach, describe, it, expect, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { customFieldSchema } from "@/lib/schemas/settings";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
  usePathname: () => "/app/settings/tenant/pipelines",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("sonner", () => ({
  toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() },
}));
vi.mock("@/app/actions/settings/updatePipelineConfig", () => ({
  updatePipelineConfig: vi.fn(async () => ({ ok: true })),
}));
// As duas seções irmãs falam com a API; este arquivo é sobre os CAMPOS.
vi.mock("./_stages", () => ({
  StagesSection: () => null,
  ancoraDasEtapas: () => "etapas",
}));
vi.mock("./_mapping", () => ({
  AgentMappingSection: () => null,
  ancoraDoMapeamento: () => "mapeamento",
}));

// Polyfills que o Radix Select exige e o jsdom não tem.
window.HTMLElement.prototype.scrollIntoView = vi.fn();
window.HTMLElement.prototype.hasPointerCapture = vi.fn(() => false);
window.HTMLElement.prototype.setPointerCapture = vi.fn();
window.HTMLElement.prototype.releasePointerCapture = vi.fn();
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
};

import { updatePipelineConfig } from "@/app/actions/settings/updatePipelineConfig";
import {
  PipelinesClient,
  TIPOS_DE_CAMPO,
  tipoTemOpcoes,
  type EtapaDoFunil,
  type PipelineRow,
} from "./_client";

/** Um funil de clínica: o campo que importa é a lista de procedimentos, e ela é múltipla. */
const FUNIL: PipelineRow = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "Tratamentos",
  slug: "tratamentos",
  vocabulary: { lead: "Paciente", deal: "Tratamento", won: "Fechado", lost: "Perdido" },
  settings: {
    fields: [
      {
        key: "procedimentos_de_interesse",
        label: "Procedimentos de interesse",
        type: "multiselect",
        options: [
          { value: "clareamento", label: "Clareamento Dental" },
          { value: "implantes", label: "Implantes" },
        ],
      },
    ],
  },
};

describe("tipos de campo que a tela do funil oferece", () => {
  it("oferece TODO tipo que o schema aceita — lista menor deixa campo salvo sem seletor", () => {
    const doSchema = [...customFieldSchema.shape.type.options].sort();
    const daTela = [...TIPOS_DE_CAMPO].sort();
    expect(daTela).toEqual(doSchema);
  });

  it("mostra as opções para toda lista fechada, não só para `select`", () => {
    expect(tipoTemOpcoes("select")).toBe(true);
    expect(tipoTemOpcoes("multiselect")).toBe(true);
    // Um tipo de texto livre não tem lista para editar.
    expect(tipoTemOpcoes("text")).toBe(false);
    expect(tipoTemOpcoes("date")).toBe(false);
  });
});

describe("um campo multiselect já gravado", () => {
  it("abre com rótulo legível e completo, sem trocar o valor técnico", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);

    const seletor = screen.getByLabelText(/Tipo do campo 1/i);
    expect(seletor.textContent?.trim()).toBe("Lista de várias escolhas");
    expect(seletor).toHaveAttribute("title", "Lista de várias escolhas");

    const linha = seletor.closest("div.grid");
    expect(linha?.className).toContain("sm:grid-cols-2");
    expect(linha?.className).toContain("xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_14rem_auto]");
    expect(linha?.className).not.toContain("md:grid-cols-[1fr_1fr_8rem_auto]");
  });

  it("salva o identificador do schema, não o rótulo traduzido", async () => {
    vi.mocked(updatePipelineConfig).mockClear();
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);
    fireEvent.click(screen.getByRole("button", { name: /Salvar vocabulário e campos/i }));

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    const patch = vi.mocked(updatePipelineConfig).mock.calls[0]?.[1];
    expect(patch?.fields?.[0]?.type).toBe("multiselect");
  });

  it("deixa editar as opções — sem isso o campo fica só de leitura", () => {
    render(<PipelinesClient pipelines={[FUNIL]} podeEditarConfig />);

    const opcoes = screen.getByLabelText(/Opções do campo 1/i);
    expect(opcoes).toHaveValue("Clareamento Dental, Implantes");
  });
});

/**
 * Um funil cujo único campo é uma lista fechada AINDA SEM opções — o estado de
 * quem acabou de criar o campo e vai digitar a primeira. Os testes de digitação
 * partem daqui: com a lista já cheia, a vírgula some no meio do valor existente
 * e o defeito fica escondido atrás do texto que já estava lá.
 */
const FUNIL_SEM_OPCOES: PipelineRow = {
  id: "22222222-2222-4222-8222-222222222222",
  name: "Vendas",
  slug: "vendas",
  vocabulary: null,
  settings: {
    fields: [{ key: "dor", label: "Dor", type: "select" }],
  },
};

/**
 * Digita TECLA A TECLA, relendo o valor ATUAL do input antes de acrescentar a
 * seguinte — é o que o navegador faz, e é o que reproduz o defeito. Um único
 * `fireEvent.change` com o texto inteiro passa longe: sem um "valor anterior"
 * sendo relido entre as teclas, o item vazio que a vírgula cria não chega a
 * atrapalhar.
 */
function digitar(input: HTMLInputElement, texto: string): void {
  for (const tecla of texto) {
    fireEvent.change(input, { target: { value: input.value + tecla } });
  }
}

describe("o input de opções de um campo de lista fechada", () => {
  it("não apaga a vírgula recém-digitada — sem ela não há como criar a segunda opção", () => {
    render(<PipelinesClient pipelines={[FUNIL_SEM_OPCOES]} podeEditarConfig />);

    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;
    digitar(opcoes, "Dor,");

    // O item vazio que a vírgula criou sobrevive à digitação, e o `join(", ")`
    // o devolve como o separador visível. Descartá-lo já no `onChange` deixaria
    // o campo em "Dor" — a vírgula some e a próxima palavra cola.
    expect(opcoes).toHaveValue("Dor, ");
  });

  it("mantém o separador entre TODAS as opções ao digitar a lista tecla a tecla", () => {
    render(<PipelinesClient pipelines={[FUNIL_SEM_OPCOES]} podeEditarConfig />);

    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;
    digitar(opcoes, "Dor, Orçamento, Prazo");

    // Com o filtro de vazio no `onChange`, isto sairia "DorOrçamentoPrazo":
    // as vírgulas desaparecem e as palavras colam.
    expect(opcoes).toHaveValue("Dor, Orçamento, Prazo");
  });

  it("não apaga o espaço DENTRO de uma opção de duas palavras ao digitar", () => {
    render(<PipelinesClient pipelines={[FUNIL_SEM_OPCOES]} podeEditarConfig />);

    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;
    digitar(opcoes, "Clareamento Dental, Implantes");

    // Mesma classe da vírgula: aparar o FIM do item a cada tecla apaga o espaço
    // recém-digitado, e a palavra seguinte cola ("ClareamentoDental").
    expect(opcoes).toHaveValue("Clareamento Dental, Implantes");
  });

  it("grava a lista inteira e descarta só o vazio do fim", async () => {
    vi.mocked(updatePipelineConfig).mockClear();
    render(<PipelinesClient pipelines={[FUNIL_SEM_OPCOES]} podeEditarConfig />);

    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;
    // A vírgula final deixa um terceiro item vazio, que o input agora preserva.
    digitar(opcoes, "Dor, Orçamento,");
    fireEvent.click(screen.getByRole("button", { name: /Salvar vocabulário e campos/i }));

    // O save roda dentro de `startTransition`; o mock resolve num microtask.
    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));

    const patch = vi.mocked(updatePipelineConfig).mock.calls[0]?.[1];
    // O vazio morre no `handleSave` (o schema exige `label` não-vazio) e as
    // opções de verdade ficam. Um filtro no `onChange` faria a segunda opção
    // nunca chegar aqui.
    expect(patch?.fields?.[0]?.options?.map((o) => o.label)).toEqual(["Dor", "Orçamento"]);
  });

  it("grava cada opção aparada, com o espaço de dentro e sem o do fim", async () => {
    vi.mocked(updatePipelineConfig).mockClear();
    render(<PipelinesClient pipelines={[FUNIL_SEM_OPCOES]} podeEditarConfig />);

    const opcoes = screen.getByLabelText(/Opções do campo 1/i) as HTMLInputElement;
    // O espaço antes da vírgula sobrevive à digitação (a pessoa ainda pode
    // estar no meio da palavra); é o salvar que o apara.
    digitar(opcoes, "Clareamento Dental , Implantes ,");
    fireEvent.click(screen.getByRole("button", { name: /Salvar vocabulário e campos/i }));

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));

    const patch = vi.mocked(updatePipelineConfig).mock.calls[0]?.[1];
    expect(patch?.fields?.[0]?.options).toEqual([
      { value: "Clareamento Dental", label: "Clareamento Dental" },
      { value: "Implantes", label: "Implantes" },
    ]);
  });
});

/* ────────────────────────────────────────────────────────────────────────── */

/**
 * O EDITOR DE `obrigatorio_em` (CR do mantenedor no PR #1688): a régua nasceu
 * no schema e não tinha TELA — quem operava não conseguia ligar a regra
 * principal do #1536. O que estes casos prendem:
 *
 *  1. a tela OFERECE as etapas do funil + "ao ganhar" + "ao perder" (as três
 *     chaves que `campoExigidoNoDestino` lê — nem mais, para não prometer
 *     gatilho que o servidor não pergunta);
 *  2. a marca vira `obrigatorio_em` no patch gravado pela ÚNICA porta de
 *     escrita do settings (`updatePipelineConfig`);
 *  3. desmarcar tudo APAGA a chave: um funil intocado continua idêntico ao de
 *     antes do #1536 (critério de aceite nº 3), em vez de ganhar `{}` morto.
 */
describe("editor de obrigatorio_em do funil (#1536)", () => {
  const ETAPA_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const ETAPA_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const FUNIL_MARCADO_ID = "33333333-3333-4333-8333-333333333333";
  const ETAPAS: Record<string, EtapaDoFunil[]> = {
    [FUNIL.id]: [
      { id: ETAPA_A, name: "Avaliação", is_archived: false },
      { id: ETAPA_B, name: "Proposta (antiga)", is_archived: true },
    ],
    [FUNIL_MARCADO_ID]: [
      { id: ETAPA_A, name: "Avaliação", is_archived: false },
      { id: ETAPA_B, name: "Proposta (antiga)", is_archived: true },
    ],
  };
  /** Um campo JÁ marcado no settings — o estado de quem abre para desligar. */
  const FUNIL_MARCADO: PipelineRow = {
    id: FUNIL_MARCADO_ID,
    name: "Vendas",
    slug: "vendas-marcado",
    vocabulary: null,
    settings: {
      fields: [
        {
          key: "dor",
          label: "Dor",
          type: "text",
          obrigatorio_em: { etapas: [ETAPA_A], ao_perder: true },
        },
      ],
    },
  };

  const tela = (p: PipelineRow) =>
    render(<PipelinesClient pipelines={[p]} etapas={ETAPAS} podeEditarConfig />);
  const patchSalvo = () => vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1];

  beforeEach(() => vi.mocked(updatePipelineConfig).mockClear());

  it("oferece as etapas do funil + ao ganhar + ao perder, e nada vem marcado", () => {
    tela(FUNIL);

    expect(
      screen.getByLabelText("Exigir em Avaliação — Procedimentos de interesse"),
    ).not.toBeChecked();
    expect(
      screen.getByLabelText("Exigir em Proposta (antiga) — Procedimentos de interesse"),
    ).not.toBeChecked();
    expect(screen.getByLabelText("Ao ganhar — Procedimentos de interesse")).not.toBeChecked();
    expect(screen.getByLabelText("Ao perder — Procedimentos de interesse")).not.toBeChecked();
  });

  it("a marca vira `obrigatorio_em` no patch da porta única de escrita", () => {
    tela(FUNIL);

    fireEvent.click(screen.getByLabelText("Exigir em Avaliação — Procedimentos de interesse"));
    fireEvent.click(screen.getByLabelText("Ao ganhar — Procedimentos de interesse"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));

    expect(updatePipelineConfig).toHaveBeenCalledTimes(1);
    expect(patchSalvo().fields?.[0]?.obrigatorio_em).toEqual({
      etapas: [ETAPA_A],
      ao_ganhar: true,
    });
  });

  it("desmarcar tudo apaga a chave — o funil volta ao comportamento de antes", () => {
    tela(FUNIL_MARCADO);
    expect(screen.getByLabelText("Exigir em Avaliação — Dor")).toBeChecked();
    expect(screen.getByLabelText("Ao perder — Dor")).toBeChecked();

    fireEvent.click(screen.getByLabelText("Exigir em Avaliação — Dor"));
    fireEvent.click(screen.getByLabelText("Ao perder — Dor"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));

    expect(patchSalvo().fields?.[0]).not.toHaveProperty("obrigatorio_em");
  });

  it("a etapa ARQUIVADA fica visível e marcável — o que alguém já marcou não some", () => {
    tela(FUNIL_MARCADO);
    // A regra gravada aponta para ETAPA_A; ETAPA_B (arquivada) também aparece.
    const antiga = screen.getByLabelText("Exigir em Proposta (antiga) — Dor");
    expect(antiga).toBeInTheDocument();
    // O rótulo da coluna morta vem da própria lista, marcada — some da tela só
    // quando some do settings, nunca por baixo de quem a marcou.
    expect(antiga.closest("label")?.textContent).toContain("arquivada");
  });
});

describe("retomada de negócio encerrado (#1538)", () => {
  beforeEach(() => vi.mocked(updatePipelineConfig).mockClear());
  const salvar = () =>
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));

  it("nasce desligada e ligar grava `reabertura: novo_negocio` na porta única de escrita", () => {
    render(<PipelinesClient pipelines={[FUNIL]} etapas={{}} podeEditarConfig />);
    const caixa = screen.getByLabelText("Negócio encerrado que volta abre um negócio novo");
    expect(caixa).not.toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].reabertura).toBe("novo_negocio");
  });

  it("funil já ligado abre marcado, e desligar volta a `mesmo_registro`", () => {
    const ligado: PipelineRow = { ...FUNIL, settings: { ...FUNIL.settings, reabertura: "novo_negocio" } };
    render(<PipelinesClient pipelines={[ligado]} etapas={{}} podeEditarConfig />);
    const caixa = screen.getByLabelText("Negócio encerrado que volta abre um negócio novo");
    expect(caixa).toBeChecked();

    fireEvent.click(caixa);
    salvar();

    expect(vi.mocked(updatePipelineConfig).mock.calls.at(-1)![1].reabertura).toBe("mesmo_registro");
  });
});

describe("etapa de entrada do Inbox", () => {
  const entradaId = "44444444-4444-4444-8444-444444444444";
  const pipelineDefault: PipelineRow = {
    ...FUNIL,
    is_default: true,
    settings: {
      ...FUNIL.settings,
      entrada_do_inbox: { ativa: true, stage_id: entradaId },
    },
  };
  const stages: Record<string, EtapaDoFunil[]> = {
    [pipelineDefault.id]: [
      { id: entradaId, name: "Qualificação", is_archived: false, is_won: false, is_lost: false },
      { id: "55555555-5555-4555-8555-555555555555", name: "Antiga", is_archived: true },
      { id: "66666666-6666-4666-8666-666666666666", name: "Ganho", is_archived: false, is_won: true },
    ],
  };

  beforeEach(() => vi.mocked(updatePipelineConfig).mockClear());

  it("mostra ativação e etapas abertas do funil padrão", async () => {
    render(<PipelinesClient pipelines={[pipelineDefault]} etapas={stages} podeEditarConfig />);
    expect(screen.getByLabelText("Ativar etapa de entrada do Inbox")).toBeChecked();
    const seletor = screen.getByRole("combobox", { name: "Etapa de entrada do Inbox" });
    expect(seletor.textContent).toContain("Qualificação");
    fireEvent.keyDown(seletor, { key: "ArrowDown" });
    expect(await screen.findByRole("option", { name: "Qualificação" })).toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Antiga" })).not.toBeInTheDocument();
    expect(screen.queryByRole("option", { name: "Ganho" })).not.toBeInTheDocument();
  });

  it("salva a etapa selecionada e mantém o stage_id ao desativar", async () => {
    render(<PipelinesClient pipelines={[pipelineDefault]} etapas={stages} podeEditarConfig />);
    fireEvent.click(screen.getByLabelText("Ativar etapa de entrada do Inbox"));
    fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));
    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updatePipelineConfig).mock.calls[0]?.[1].entrada_do_inbox).toEqual({
      ativa: false,
      stage_id: entradaId,
    });
  });

  it("não mostra esta configuração em funil que não é o padrão", () => {
    render(<PipelinesClient pipelines={[FUNIL]} etapas={stages} podeEditarConfig />);
    expect(screen.queryByLabelText("Ativar etapa de entrada do Inbox")).not.toBeInTheDocument();
  });
});

describe("recorte de negócios encerrados no Quadro", () => {
  beforeEach(() => vi.mocked(updatePipelineConfig).mockClear());
  const salvar = () => fireEvent.click(screen.getByRole("button", { name: "Salvar vocabulário e campos" }));

  it("salva a quantidade configurada por funil", async () => {
    render(<PipelinesClient pipelines={[FUNIL]} etapas={{}} podeEditarConfig />);
    const habilitar = screen.getByLabelText("Ocultar negócios encerrados antigos");
    expect(habilitar).not.toBeChecked();
    fireEvent.click(habilitar);
    fireEvent.change(screen.getByLabelText("Dias até ocultar negócios encerrados"), { target: { value: "45" } });
    salvar();

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updatePipelineConfig).mock.calls[0]?.[1].ocultar_encerrados_dias).toBe(45);
  });

  it("desligar grava 0 explicitamente em vez de conservar o corte anterior", async () => {
    const configurado: PipelineRow = {
      ...FUNIL,
      settings: { ...FUNIL.settings, ocultar_encerrados_dias: 30 },
    };
    render(<PipelinesClient pipelines={[configurado]} etapas={{}} podeEditarConfig />);
    fireEvent.click(screen.getByLabelText("Ocultar negócios encerrados antigos"));
    salvar();

    await vi.waitFor(() => expect(updatePipelineConfig).toHaveBeenCalledTimes(1));
    expect(vi.mocked(updatePipelineConfig).mock.calls[0]?.[1].ocultar_encerrados_dias).toBe(0);
  });
});
