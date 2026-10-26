/**
 * Encerrar pela fila um roteiro de atendimento em andamento ('coletando', 0394).
 * Antes a rota devolvia 409 "já está encerrado" — o roteiro não estava na lista
 * de vivos (revisão do PR 1 do port do #1130).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const deps = vi.hoisted(() => ({ role: vi.fn(), support: vi.fn(), audit: vi.fn(), client: vi.fn() }));

vi.mock("@/lib/auth/require-role", () => ({ requireRole: deps.role }));
vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: deps.support }));
vi.mock("@/lib/audit", () => ({ audit: deps.audit }));
vi.mock("@/lib/supabase/server", () => ({ createClient: deps.client }));

import { POST } from "./route";

const ID = "11111111-1111-4111-8111-111111111111";

function client(
  status: string,
  options: { claimed_until?: string | null; updateReturnsRow?: boolean } = {},
) {
  const atualizados: Array<Record<string, unknown>> = [];
  const filtros: Array<[string, unknown]> = [];
  const orFilters: string[] = [];
  let modo: "read" | "update" = "read";
  const cadeia = {
    select: () => cadeia,
    eq: (campo: string, valor: unknown) => (filtros.push([campo, valor]), cadeia),
    or: (filtro: string) => (orFilters.push(filtro), cadeia),
    maybeSingle: async () => {
      if (modo === "read") {
        return {
          data: { id: ID, status, current_node_id: "t", claimed_until: options.claimed_until ?? null },
          error: null,
        };
      }
      return {
        data: options.updateReturnsRow === false ? null : { id: ID, status: "cancelled" },
        error: null,
      };
    },
    update: (patch: Record<string, unknown>) => {
      atualizados.push(patch);
      modo = "update";
      return cadeia;
    },
    insert: async () => ({ error: null }),
  };
  return { atualizados, filtros, orFilters, c: { from: () => cadeia } };
}

beforeEach(() => {
  vi.clearAllMocks();
  deps.support.mockResolvedValue(null);
  deps.role.mockResolvedValue({ ok: true, user: { id: "eu", idioma: "pt-BR" }, org: { orgId: "org", role: "manager" } });
});

describe("POST /api/v1/ai/followups/enrollments/:id/cancel", () => {
  it.each(["active", "coletando", "dormente"])('cancela o enrollment %s e remove o relógio', async (status) => {
    const { atualizados, filtros, orFilters, c } = client(status);
    deps.client.mockResolvedValue(c);
    const res = await POST(new NextRequest(`http://localhost/x/${ID}/cancel`, { method: "POST" }), {
      params: Promise.resolve({ id: ID }),
    } as never);
    expect(res.status).toBe(200);
    expect(atualizados[0]).toMatchObject({
      status: "cancelled",
      cancel_reason: "manual",
      next_eval_at: null,
      claimed_until: null,
      outcome: null,
    });
    expect(filtros).toContainEqual(["status", status]);
    expect(filtros).toContainEqual(["organization_id", "org"]);
    expect(orFilters[0]).toMatch(/^claimed_until\.is\.null,claimed_until\.lt\./);
  });

  it("mantém o contrato terminal em concluído, cancelado e morto", async () => {
    for (const status of ["completed", "cancelled", "dead"]) {
      const { atualizados, c } = client(status);
      deps.client.mockResolvedValue(c);
      const res = await POST(new NextRequest(`http://localhost/x/${ID}/cancel`, { method: "POST" }), {
        params: Promise.resolve({ id: ID }),
      } as never);
      expect(res.status).toBe(409);
      expect(atualizados).toHaveLength(0);
    }
  });

  it("não cancela enquanto o worker mantém o lease", async () => {
    const { atualizados, c } = client("dormente", { claimed_until: new Date(Date.now() + 60_000).toISOString() });
    deps.client.mockResolvedValue(c);
    const res = await POST(new NextRequest(`http://localhost/x/${ID}/cancel`, { method: "POST" }), {
      params: Promise.resolve({ id: ID }),
    } as never);
    expect(res.status).toBe(409);
    expect(atualizados).toHaveLength(0);
  });

  it("recusa conflito se estado/lease muda entre leitura e escrita", async () => {
    const { atualizados, c } = client("dormente", { updateReturnsRow: false });
    deps.client.mockResolvedValue(c);
    const res = await POST(new NextRequest(`http://localhost/x/${ID}/cancel`, { method: "POST" }), {
      params: Promise.resolve({ id: ID }),
    } as never);
    expect(res.status).toBe(409);
    expect(atualizados).toHaveLength(1);
  });

  it("support_readonly não pode cancelar", async () => {
    const { atualizados, c } = client("dormente");
    deps.client.mockResolvedValue(c);
    deps.support.mockResolvedValue(new Response("forbidden", { status: 403 }));
    const res = await POST(new NextRequest(`http://localhost/x/${ID}/cancel`, { method: "POST" }), {
      params: Promise.resolve({ id: ID }),
    } as never);
    expect(res.status).toBe(403);
    expect(atualizados).toHaveLength(0);
    expect(deps.client).not.toHaveBeenCalled();
  });
});
