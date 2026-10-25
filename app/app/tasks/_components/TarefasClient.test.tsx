import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const testData = vi.hoisted(() => ({
  members: [
    { user_id: "11111111-1111-4111-8111-111111111111", role: "agent", full_name: "Rafael" },
    { user_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "agent", full_name: "Ana Maia" },
  ],
}));

vi.mock("@/hooks/i18n/useT", () => ({ useT: () => (texto: string) => texto }));
vi.mock("@/hooks/i18n/useLocaleDeData", () => ({ useTagDeIdioma: () => "pt-BR" }));
vi.mock("@/hooks/inbox/useAssignableMembers", () => ({
  useAssignableMembers: () => ({ data: testData.members, isLoading: false }),
}));
vi.mock("@/components/ui/select", async () => {
  const React = await import("react");
  function SelectTrigger() {
    return null;
  }
  function SelectContent({ children }: { children: React.ReactNode }) {
    return children;
  }
  function SelectItem({ value, children }: { value: string; children: React.ReactNode }) {
    return React.createElement("option", { value }, children);
  }
  function Select({
    value,
    onValueChange,
    children,
  }: {
    value: string;
    onValueChange: (value: string) => void;
    children: React.ReactNode;
  }) {
    const parts = React.Children.toArray(children) as Array<{
      type: { name?: string };
      props: Record<string, unknown>;
    }>;
    const trigger = parts.find((part) => part.type.name === "SelectTrigger");
    const content = parts.find((part) => part.type.name === "SelectContent");
    return React.createElement(
      "select",
      {
        ...trigger?.props,
        value,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onValueChange(event.target.value),
      },
      content?.props.children as React.ReactNode,
    );
  }
  return { Select, SelectTrigger, SelectContent, SelectItem, SelectValue: () => null };
});

import { TarefasClient } from "./TarefasClient";

const USER_A = testData.members[0]!.user_id;
const USER_B = testData.members[1]!.user_id;
const TASK_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function task(overrides: Record<string, unknown> = {}) {
  return {
    id: TASK_ID,
    organization_id: "22222222-2222-4222-8222-222222222222",
    title: "Ligar para Ana",
    description: null,
    due_date: null,
    priority: "medium",
    status: "pending",
    lead_id: null,
    contact_id: null,
    assigned_to: USER_B,
    assigned_to_name: "Ana Maia",
    created_by: USER_A,
    created_at: "2026-10-25T12:00:00.000Z",
    updated_at: "2026-10-25T12:00:00.000Z",
    ...overrides,
  };
}

const fetchSpy = vi.fn();

beforeEach(() => {
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    const status = init?.method === "POST" ? 201 : 200;
    const returnedTask = task({ ...(body ?? {}) });
    return new Response(
      JSON.stringify(
        init?.method === "POST" || init?.method === "PATCH"
          ? { data: { task: returnedTask } }
          : { data: { tasks: [task()] } },
      ),
      { status, headers: { "Content-Type": "application/json" } },
    );
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => vi.unstubAllGlobals());

function montar(
  props: Partial<React.ComponentProps<typeof TarefasClient>> = {},
  queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
  const atuais: React.ComponentProps<typeof TarefasClient> = {
    podeEditar: true,
    organizationId: "22222222-2222-4222-8222-222222222222",
    userId: USER_A,
    filtroInicial: "todas",
    ...props,
  };
  const view = render(
    <QueryClientProvider client={queryClient}>
      <TarefasClient {...atuais} />
    </QueryClientProvider>,
  );
  return { ...view, queryClient, props: atuais };
}

function urlsDosGets() {
  return fetchSpy.mock.calls
    .filter(([, init]) => init?.method === undefined || init.method === "GET")
    .map(([url]) => String(url));
}

function corpoDaMutation(method: "POST" | "PATCH") {
  const call = fetchSpy.mock.calls.find(([, init]) => init?.method === method);
  return call?.[1]?.body ? JSON.parse(String(call[1].body)) as Record<string, unknown> : null;
}

describe("TarefasClient — filtro de responsável", () => {
  it("envia o modo semântico me e Todas remove o filtro", async () => {
    const user = userEvent.setup();
    const { queryClient } = montar();
    await waitFor(() => expect(urlsDosGets().length).toBeGreaterThan(0));

    await user.selectOptions(screen.getByRole("combobox", { name: "Responsável" }), "me");
    await waitFor(() => expect(urlsDosGets().at(-1)).toContain("assigned_to=me"));

    await user.selectOptions(screen.getByRole("combobox", { name: "Responsável" }), "todas");
    expect(
      (screen.getByRole("combobox", { name: "Responsável" }) as HTMLSelectElement).value,
    ).toBe("todas");
    expect(
      queryClient.getQueryCache().getAll().some((query) => query.queryKey[3] === "aberto=true"),
    ).toBe(true);
  });

  it("filtra por membro no servidor, sem mostrar o UUID na tela", async () => {
    const user = userEvent.setup();
    const { container } = montar();
    await waitFor(() => expect(urlsDosGets().length).toBeGreaterThan(0));

    await user.selectOptions(screen.getByRole("combobox", { name: "Responsável" }), USER_B);

    await waitFor(() => expect(urlsDosGets().at(-1)).toContain(`assigned_to=${USER_B}`));
    expect(container.textContent).not.toContain(USER_B);
  });

  it("a chave de cache separa tenant e usuário", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchSpy
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify({ data: { tasks: [task({ title: "Tarefa do tenant A" })] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockImplementationOnce(async () =>
        new Response(JSON.stringify({ data: { tasks: [task({ title: "Tarefa do tenant B" })] } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    const view = montar({ organizationId: "22222222-2222-4222-8222-222222222222" }, queryClient);
    expect(await screen.findByText("Tarefa do tenant A")).toBeTruthy();

    view.rerender(
      <QueryClientProvider client={queryClient}>
        <TarefasClient
          podeEditar
          organizationId="33333333-3333-4333-8333-333333333333"
          userId={USER_A}
          filtroInicial="todas"
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Tarefa do tenant B")).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("TarefasClient — responsável no formulário e na linha", () => {
  it("criar em Minhas atribui ao usuário autenticado sem exigir um ID do browser no filtro", async () => {
    const user = userEvent.setup();
    montar({ filtroInicial: "me" });
    await waitFor(() => expect(urlsDosGets().length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: "Nova tarefa" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("O que precisa ser feito"), "Retornar ligação");
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(corpoDaMutation("POST")).not.toBeNull());
    expect(corpoDaMutation("POST")).toMatchObject({ assigned_to: USER_A, title: "Retornar ligação" });
  });

  it("permite escolher um membro da organização no formulário de criação", async () => {
    const user = userEvent.setup();
    montar();
    await waitFor(() => expect(urlsDosGets().length).toBeGreaterThan(0));
    await user.click(screen.getByRole("button", { name: "Nova tarefa" }));
    const dialog = screen.getByRole("dialog");
    await user.type(within(dialog).getByLabelText("O que precisa ser feito"), "Enviar proposta");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Responsável" }), USER_B);
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(corpoDaMutation("POST")).not.toBeNull());
    expect(corpoDaMutation("POST")).toMatchObject({ assigned_to: USER_B, title: "Enviar proposta" });
  });

  it("mostra nome do responsável e preserva a atribuição quando edita sem trocar", async () => {
    const user = userEvent.setup();
    montar();
    expect(await screen.findByText("Responsável: Ana Maia")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Editar a tarefa" }));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByRole("combobox", { name: "Responsável" }).textContent).toContain("Ana Maia");
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(corpoDaMutation("PATCH")).not.toBeNull());
    expect(corpoDaMutation("PATCH")).not.toHaveProperty("assigned_to");
    expect(await screen.findByText("Responsável: Ana Maia")).toBeTruthy();
  });

  it("edita o responsável quando a pessoa escolhe outro membro", async () => {
    const user = userEvent.setup();
    montar();
    expect(await screen.findByText("Responsável: Ana Maia")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Editar a tarefa" }));
    const dialog = screen.getByRole("dialog");
    await user.selectOptions(within(dialog).getByRole("combobox", { name: "Responsável" }), USER_A);
    await user.click(within(dialog).getByRole("button", { name: "Salvar" }));

    await waitFor(() => expect(corpoDaMutation("PATCH")).not.toBeNull());
    expect(corpoDaMutation("PATCH")).toMatchObject({ assigned_to: USER_A });
  });
});
