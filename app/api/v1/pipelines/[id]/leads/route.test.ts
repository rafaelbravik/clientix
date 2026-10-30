import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { OUTRA_ORG, ORG_ID, PIPE, authOk, etapa, makeDb } from "@/tests/helpers/stages-db-double";
import { requireRole } from "@/lib/auth/require-role";
import { fail } from "@/lib/api/wrappers";
import { createClient } from "@/lib/supabase/server";

const ctx = { params: Promise.resolve({ id: PIPE }) };
const OWNER_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OWNER_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const AGENT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

function req(query = "") {
  return new NextRequest(`http://localhost/api/v1/pipelines/${PIPE}/leads${query}`);
}

function lead(id: string, position: number, over: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: ORG_ID,
    pipeline_id: PIPE,
    stage_id: "stage-1",
    contact_id: null,
    title: `Negócio ${id}`,
    status: "open",
    owner_user_id: null,
    owner_agent_id: null,
    position_in_stage: position,
    ...over,
  };
}

beforeEach(() => vi.clearAllMocks());

describe("GET /api/v1/pipelines/[id]/leads", () => {
  it("exige autenticação e o papel mínimo de leitura", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: fail("unauthenticated", "Auth required.", 401),
    });
    const { GET } = await import("./route");
    const res = await GET(req(), ctx);
    expect(res.status).toBe(401);

    authOk("viewer");
    makeDb();
    await GET(req(), ctx);
    expect(requireRole).toHaveBeenLastCalledWith("viewer", expect.objectContaining({ resource: "pipeline_leads_list" }));
  });

  it("pipeline de outro tenant retorna 404, sem enumerar leads", async () => {
    authOk("viewer");
    const db = makeDb({ pipelineOrg: OUTRA_ORG, leads: [lead("segredo", 1, { organization_id: OUTRA_ORG })] });
    const { GET } = await import("./route");
    const res = await GET(req(), ctx);
    expect(res.status).toBe(404);
    expect(db.tabelas.crm_leads).toHaveLength(1);
  });

  it("aplica paginação real e ordem estável; 5 itens, página 2 com 2 devolve itens 3 e 4", async () => {
    authOk("viewer");
    makeDb({
      stages: [etapa({ id: "stage-1", name: "Entrada" })],
      // Ordem de entrada embaralhada para provar ORDER BY(position_in_stage,id).
      leads: [lead("id-5", 5), lead("id-2", 2), lead("id-4", 4), lead("id-1", 1), lead("id-3", 3)],
    });
    const { GET } = await import("./route");
    const res = await GET(req("?page=2&per_page=2"), ctx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.map((item: { id: string }) => item.id)).toEqual(["id-3", "id-4"]);
    expect(body.data[0].stage_name).toBe("Entrada");
    expect(body.meta).toEqual({ page: 2, per_page: 2, total: 5, has_more: true });
  });

  it("filtra responsável na consulta antes do range, não apenas na página já lida", async () => {
    authOk("viewer");
    makeDb({
      leads: [
        lead("bia-1", 1, { owner_user_id: OWNER_B }),
        lead("bia-2", 2, { owner_user_id: OWNER_B }),
        lead("ana-1", 3, { owner_user_id: OWNER_A }),
        lead("ana-2", 4, { owner_user_id: OWNER_A }),
      ],
    });
    const { GET } = await import("./route");

    const res = await GET(req(`?page=1&per_page=1&owner=${OWNER_A}`), ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.map((item: { id: string }) => item.id)).toEqual(["ana-1"]);
    expect(body.meta).toEqual({ page: 1, per_page: 1, total: 2, has_more: true });
  });

  it("trocar o responsável muda os negócios retornados", async () => {
    authOk("viewer");
    makeDb({
      leads: [
        lead("da-ana", 1, { owner_user_id: OWNER_A }),
        lead("da-bia", 2, { owner_user_id: OWNER_B }),
      ],
    });
    const { GET } = await import("./route");

    const ana = await GET(req(`?owner=${OWNER_A}`), ctx);
    const bia = await GET(req(`?owner=${OWNER_B}`), ctx);

    expect((await ana.json()).data.map((item: { id: string }) => item.id)).toEqual(["da-ana"]);
    expect((await bia.json()).data.map((item: { id: string }) => item.id)).toEqual(["da-bia"]);
  });

  it("filtra agent:<uuid> por owner_agent_id", async () => {
    authOk("viewer");
    makeDb({
      leads: [
        lead("humano", 1, { owner_user_id: AGENT }),
        lead("agente", 2, { owner_agent_id: AGENT }),
      ],
    });
    const { GET } = await import("./route");

    const res = await GET(req(`?owner=agent:${AGENT}`), ctx);
    expect((await res.json()).data.map((item: { id: string }) => item.id)).toEqual(["agente"]);
  });

  it("unassigned exige owner_user_id e owner_agent_id nulos", async () => {
    authOk("viewer");
    makeDb({
      leads: [
        lead("sem-dono", 1),
        lead("com-usuario", 2, { owner_user_id: OWNER_A }),
        lead("com-agente", 3, { owner_agent_id: AGENT }),
      ],
    });
    const { GET } = await import("./route");

    const res = await GET(req("?owner=unassigned"), ctx);
    expect((await res.json()).data.map((item: { id: string }) => item.id)).toEqual(["sem-dono"]);
  });

  it.each([
    ["open", ["aberto"]],
    ["won", ["ganho"]],
    ["lost", ["perdido"]],
  ])("status=%s filtra a consulta", async (status, ids) => {
    authOk("viewer");
    makeDb({
      leads: [
        lead("aberto", 1, { status: "open" }),
        lead("ganho", 2, { status: "won" }),
        lead("perdido", 3, { status: "lost" }),
      ],
    });
    const { GET } = await import("./route");

    const res = await GET(req(`?status=${status}`), ctx);
    expect((await res.json()).data.map((item: { id: string }) => item.id)).toEqual(ids);
  });

  it("combina owner e status com AND e mantém tenant, funil e archived excluídos", async () => {
    authOk("viewer");
    makeDb({
      leads: [
        lead("alvo", 1, { owner_user_id: OWNER_A, status: "won" }),
        lead("outro-status", 2, { owner_user_id: OWNER_A, status: "open" }),
        lead("outro-owner", 3, { owner_user_id: OWNER_B, status: "won" }),
        lead("arquivado", 4, { owner_user_id: OWNER_A, status: "archived" }),
        lead("outro-tenant", 5, { organization_id: OUTRA_ORG, owner_user_id: OWNER_A, status: "won" }),
      ],
    });
    const { GET } = await import("./route");

    const res = await GET(req(`?owner=${OWNER_A}&status=won`), ctx);
    expect((await res.json()).data.map((item: { id: string }) => item.id)).toEqual(["alvo"]);
  });

  it("any/all deixam owner e status sem filtro, mas archived continua excluído", async () => {
    authOk("viewer");
    makeDb({
      leads: [
        lead("aberto", 1),
        lead("ganho", 2, { status: "won" }),
        lead("arquivado", 3, { status: "archived" }),
      ],
    });
    const { GET } = await import("./route");

    const res = await GET(req("?owner=any&status=all"), ctx);
    expect((await res.json()).data.map((item: { id: string }) => item.id)).toEqual(["aberto", "ganho"]);
  });

  it.each([
    "?owner=vania",
    "?owner=agent:xyz",
    "?status=ganho",
    "?status=archived",
    "?owner=",
  ])("recusa filtro inválido %s antes de abrir consulta", async (query) => {
    authOk("viewer");
    const { GET } = await import("./route");

    const res = await GET(req(query), ctx);

    expect(res.status).toBe(422);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("usa o mesmo owner/status no total de fallback quando o range passa do fim", async () => {
    authOk("viewer");
    makeDb({
      leads: [
        lead("ganho-da-ana", 1, { owner_user_id: OWNER_A, status: "won" }),
        lead("aberto-da-ana", 2, { owner_user_id: OWNER_A, status: "open" }),
        lead("ganho-da-bia", 3, { owner_user_id: OWNER_B, status: "won" }),
      ],
      leadsRangeError: { code: "PGRST103", message: "Requested range not satisfiable" },
    });
    const { GET } = await import("./route");

    const res = await GET(req(`?page=2&per_page=1&owner=${OWNER_A}&status=won`), ctx);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ data: [], meta: { total: 1, has_more: false } });
  });

  it("desempata por id e calcula corretamente o limite da última página", async () => {
    authOk("viewer");
    makeDb({
      leads: [
        lead("id-c", 1),
        lead("id-a", 1),
        lead("id-e", 3),
        lead("id-b", 1),
        lead("id-d", 2),
      ],
    });
    const { GET } = await import("./route");

    const segunda = await GET(req("?page=2&per_page=2"), ctx);
    const segundaBody = await segunda.json();
    expect(segundaBody.data.map((item: { id: string }) => item.id)).toEqual(["id-c", "id-d"]);
    expect(segundaBody.meta).toEqual({ page: 2, per_page: 2, total: 5, has_more: true });

    const ultima = await GET(req("?page=3&per_page=2"), ctx);
    const ultimaBody = await ultima.json();
    expect(ultimaBody.data.map((item: { id: string }) => item.id)).toEqual(["id-e"]);
    expect(ultimaBody.meta).toEqual({ page: 3, per_page: 2, total: 5, has_more: false });
  });

  it("responde página vazia quando PostgREST recusa um intervalo além do total", async () => {
    authOk("viewer");
    makeDb({
      leads: [lead("id-1", 1), lead("id-2", 2), lead("outro-tenant", 3, { organization_id: OUTRA_ORG })],
      leadsRangeError: { code: "PGRST103", message: "Requested range not satisfiable" },
    });
    const { GET } = await import("./route");
    const res = await GET(req("?page=4&per_page=1"), ctx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual([]);
    expect(body.meta).toEqual({ page: 4, per_page: 1, total: 2, has_more: false });
  });

  it("não mascara PGRST103 se o intervalo ainda cai dentro do total", async () => {
    authOk("viewer");
    makeDb({
      leads: [lead("id-1", 1), lead("id-2", 2)],
      leadsRangeError: { code: "PGRST103", message: "Requested range not satisfiable" },
    });
    const { GET } = await import("./route");
    const res = await GET(req("?page=1&per_page=1"), ctx);
    const body = await res.json();

    expect(res.status).toBe(500);
    expect(body.error.code).toBe("internal_error");
  });

  it("usa padrão 50, limita per_page em 200 e calcula última página sem has_more", async () => {
    authOk("viewer");
    makeDb({ leads: [lead("id-1", 1), lead("id-2", 2)] });
    const { GET } = await import("./route");
    const padrao = await GET(req(), ctx);
    const padraoBody = await padrao.json();
    expect(padraoBody.meta).toEqual({ page: 1, per_page: 50, total: 2, has_more: false });

    const limitado = await GET(req("?page=1&per_page=250"), ctx);
    expect((await limitado.json()).meta.per_page).toBe(200);
  });

  it.each(["?page=0", "?page=abc", "?per_page=0", "?per_page=-2"])(
    "parâmetros inválidos %s retornam 422",
    async (query) => {
      authOk("viewer");
      makeDb();
      const { GET } = await import("./route");
      const res = await GET(req(query), ctx);
      expect(res.status).toBe(422);
    },
  );
});
