import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn() }));

import { OUTRA_ORG, ORG_ID, PIPE, authOk, etapa, makeDb } from "@/tests/helpers/stages-db-double";
import { requireRole } from "@/lib/auth/require-role";
import { fail } from "@/lib/api/wrappers";

const ctx = { params: Promise.resolve({ id: PIPE }) };

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
