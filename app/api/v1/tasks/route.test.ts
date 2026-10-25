import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const spies = vi.hoisted(() => ({
  requireRole: vi.fn(),
  supportDenied: vi.fn(),
  createClient: vi.fn(),
  validateAssignee: vi.fn(),
  assigneeNames: vi.fn(),
  audit: vi.fn(),
  activity: vi.fn(),
}));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: spies.requireRole }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: spies.supportDenied }));
vi.mock("@/lib/supabase/server", () => ({ createClient: spies.createClient }));
vi.mock("@/lib/tarefas/responsaveis", () => ({
  validarResponsavelDaTarefa: spies.validateAssignee,
  nomesDosResponsaveisDaTarefa: spies.assigneeNames,
}));
vi.mock("@/lib/audit", () => ({ audit: spies.audit }));
vi.mock("@/lib/tarefas/atividade", () => ({ registraAtividadeDaTarefa: spies.activity }));
vi.mock("@/lib/i18n/dicionario", () => ({ traduzir: (texto: string) => texto }));

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { validarResponsavelDaTarefa } from "@/lib/tarefas/responsaveis";

const ORG_A = "22222222-2222-4222-8222-222222222222";
const USER_A = "11111111-1111-4111-8111-111111111111";
const USER_B = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OUTRO_TENANT_USER = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TASK_ID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const AGORA = "2026-10-25T12:00:00.000Z";

function req(url: string, body?: unknown) {
  return new NextRequest(url, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    headers: body === undefined ? undefined : { "content-type": "application/json" },
  });
}

function builder(resultado: { data: unknown; error: unknown }) {
  const calls: Array<[string, ...unknown[]]> = [];
  const consulta: Record<string, unknown> = {};
  for (const metodo of ["select", "eq", "is", "gte", "lte", "in", "order", "limit", "insert", "update", "delete"]) {
    consulta[metodo] = vi.fn((...args: unknown[]) => {
      calls.push([metodo, ...args]);
      return consulta;
    });
  }
  consulta.single = vi.fn(async () => resultado);
  consulta.maybeSingle = vi.fn(async () => resultado);
  consulta.then = (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(resultado).then(resolve, reject);
  return { consulta, calls };
}

function clientComResultados(...resultados: Array<{ data: unknown; error: unknown }>) {
  const builders: ReturnType<typeof builder>[] = [];
  const from = vi.fn(() => {
    const atual = builder(resultados[builders.length] ?? { data: [], error: null });
    builders.push(atual);
    return atual.consulta;
  });
  return { client: { from }, builders };
}

const tarefa = {
  id: TASK_ID,
  organization_id: ORG_A,
  title: "Ligar para Ana",
  description: null,
  due_date: null,
  priority: "medium",
  status: "pending",
  lead_id: null,
  contact_id: null,
  assigned_to: USER_B,
  created_by: USER_A,
  created_at: AGORA,
  updated_at: AGORA,
};

beforeEach(() => {
  vi.clearAllMocks();
  spies.requireRole.mockResolvedValue({
    ok: true,
    user: { id: USER_A, idioma: "pt-BR", full_name: "Rafael" },
    org: { orgId: ORG_A, name: "Organização", role: "agent" },
  });
  spies.supportDenied.mockResolvedValue(null);
  spies.validateAssignee.mockResolvedValue("valido");
  spies.assigneeNames.mockResolvedValue(new Map([[USER_B, "Ana"]]));
});

describe("GET /api/v1/tasks — filtro do responsável", () => {
  it("resolve assigned_to=me pela identidade autenticada, nunca por UUID recebido", async () => {
    const fake = clientComResultados({ data: [tarefa], error: null });
    spies.createClient.mockResolvedValue(fake.client);
    const { GET } = await import("./route");

    const response = await GET(req("http://localhost/api/v1/tasks?assigned_to=me"));

    expect(response.status).toBe(200);
    expect(fake.builders[0]?.calls).toContainEqual(["eq", "assigned_to", USER_A]);
    expect(fake.builders[0]?.calls).not.toContainEqual(["eq", "assigned_to", "me"]);
    expect(spies.validateAssignee).not.toHaveBeenCalled();
    expect(spies.assigneeNames).toHaveBeenCalledWith(ORG_A, [USER_B], {
      id: USER_A,
      fullName: "Rafael",
    });
  });

  it("filtra um membro permitido no banco antes do limite de 500", async () => {
    const fake = clientComResultados({ data: [tarefa], error: null });
    spies.createClient.mockResolvedValue(fake.client);
    const { GET } = await import("./route");

    const response = await GET(req(`http://localhost/api/v1/tasks?assigned_to=${USER_B}`));

    expect(response.status).toBe(200);
    expect(validarResponsavelDaTarefa).toHaveBeenCalledWith(ORG_A, USER_B, USER_A);
    expect(fake.builders[0]?.calls).toContainEqual(["eq", "assigned_to", USER_B]);
    expect(fake.builders[0]?.calls).toContainEqual(["limit", 500]);
  });

  it("aplica Sem responsável como IS NULL e não devolve UUID técnico no DTO", async () => {
    const semResponsavel = { ...tarefa, assigned_to: null };
    const fake = clientComResultados({ data: [semResponsavel], error: null });
    spies.createClient.mockResolvedValue(fake.client);
    const { GET } = await import("./route");

    const response = await GET(req("http://localhost/api/v1/tasks?assigned_to=ninguem"));
    const body = (await response.json()) as { data: { tasks: Array<Record<string, unknown>> } };

    expect(response.status).toBe(200);
    expect(fake.builders[0]?.calls).toContainEqual(["is", "assigned_to", null]);
    expect(body.data.tasks[0]).toMatchObject({ assigned_to: null, assigned_to_name: null });
  });

  it("retorna lista vazia para ID de outro tenant sem consultar tarefas desse usuário", async () => {
    const fake = clientComResultados({ data: [], error: null });
    spies.createClient.mockResolvedValue(fake.client);
    spies.validateAssignee.mockResolvedValue("membro_inexistente");
    const { GET } = await import("./route");

    const response = await GET(req(`http://localhost/api/v1/tasks?assigned_to=${OUTRO_TENANT_USER}`));
    const body = (await response.json()) as { data: { tasks: unknown[] } };

    expect(response.status).toBe(200);
    expect(body.data.tasks).toEqual([]);
    expect(fake.client.from).not.toHaveBeenCalled();
  });

  it("rejeita valor que não é me, UUID ou nenhum", async () => {
    const fake = clientComResultados({ data: [], error: null });
    spies.createClient.mockResolvedValue(fake.client);
    const { GET } = await import("./route");

    const response = await GET(req("http://localhost/api/v1/tasks?assigned_to=qualquer"));

    expect(response.status).toBe(422);
    expect(fake.client.from).not.toHaveBeenCalled();
  });
});

describe("POST/PATCH /api/v1/tasks — membership da atribuição", () => {
  it("aceita atribuir ao próprio usuário autenticado", async () => {
    const fake = clientComResultados({ data: tarefa, error: null });
    spies.createClient.mockResolvedValue(fake.client);
    const { POST } = await import("./route");

    const response = await POST(
      req("http://localhost/api/v1/tasks", { title: tarefa.title, assigned_to: USER_A }) as NextRequest,
    );

    expect(response.status).toBe(201);
    expect(spies.validateAssignee).toHaveBeenCalledWith(ORG_A, USER_A, USER_A);
    expect(fake.builders[0]?.calls).toContainEqual([
      "insert",
      expect.objectContaining({ assigned_to: USER_A, organization_id: ORG_A, created_by: USER_A }),
    ]);
  });

  it("recusa POST com responsável fora do tenant antes de gravar", async () => {
    const fake = clientComResultados({ data: tarefa, error: null });
    spies.createClient.mockResolvedValue(fake.client);
    spies.validateAssignee.mockResolvedValue("membro_inexistente");
    const { POST } = await import("./route");

    const response = await POST(
      req("http://localhost/api/v1/tasks", { title: tarefa.title, assigned_to: OUTRO_TENANT_USER }) as NextRequest,
    );

    expect(response.status).toBe(422);
    expect(fake.client.from).not.toHaveBeenCalled();
  });

  it("recusa PATCH com responsável fora do tenant antes de atualizar", async () => {
    const fake = clientComResultados({ data: { status: "pending" }, error: null });
    spies.createClient.mockResolvedValue(fake.client);
    spies.validateAssignee.mockResolvedValue("membro_inexistente");
    const { PATCH } = await import("./[id]/route");

    const response = await PATCH(
      req(`http://localhost/api/v1/tasks/${TASK_ID}`, { assigned_to: OUTRO_TENANT_USER }) as NextRequest,
      { params: Promise.resolve({ id: TASK_ID }) },
    );

    expect(response.status).toBe(422);
    expect(fake.client.from).not.toHaveBeenCalled();
  });

  it("read-only de suporte não chega à mutation", async () => {
    const fake = clientComResultados({ data: tarefa, error: null });
    spies.createClient.mockResolvedValue(fake.client);
    spies.supportDenied.mockResolvedValue(fail("forbidden", "Read-only.", 403, {}));
    const { POST } = await import("./route");

    const response = await POST(req("http://localhost/api/v1/tasks", { title: tarefa.title }) as NextRequest);

    expect(response.status).toBe(403);
    expect(requireRole).not.toHaveBeenCalled();
    expect(fake.client.from).not.toHaveBeenCalled();
  });
});
