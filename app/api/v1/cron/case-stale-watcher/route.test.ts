import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/env", () => ({ env: { INTERNAL_SECRET: "segredo", INTERNAL_CRON_SECRET: "" } }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));

import { audit } from "@/lib/audit";
import { createAdminClient } from "@/lib/supabase/admin";

interface Capturado {
  chamadas: Array<{ nome: string; args: Record<string, unknown> }>;
}

function admin(
  resumo: { examinados: number; avisados: number; ja_avisados: number },
  cap: Capturado,
  erroClaim: { message: string } | null = null,
) {
  return {
    rpc: async (nome: string, args: Record<string, unknown>) => {
      cap.chamadas.push({ nome, args });
      return { data: erroClaim ? null : [resumo], error: erroClaim };
    },
    from(tabela: string) {
      if (tabela !== "passagens_de_atendimento") throw new Error(`Tabela inesperada: ${tabela}`);
      const c: Record<string, unknown> = {
        select: () => c,
        is: () => c,
        lt: () => c,
        order: () => c,
        limit: async () => ({ data: [], error: null }),
        update: () => c,
        eq: () => c,
        then: (resolve: (value: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return c;
    },
  };
}

const vazio = (): Capturado => ({ chamadas: [] });
const req = () => new NextRequest("http://localhost/x", { headers: { authorization: "Bearer segredo" } });

beforeEach(() => vi.clearAllMocks());

describe("case-stale-watcher", () => {
  it("usa o claim atômico por espera e devolve os contadores", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(admin({ examinados: 2, avisados: 1, ja_avisados: 1 }, cap) as never);

    const { POST } = await import("./route");
    const response = await POST(req());
    const body = (await response.json()) as { data: Record<string, number> };

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({ examinados: 2, avisados: 1, ja_avisados: 1 });
    expect(cap.chamadas).toEqual([
      { nome: "fn_claim_case_wait_reminders", args: { p_limit: 200 } },
    ]);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "ai.caso_parado_cobrado",
      metadata: { avisados: 1, examinados: 2 },
    }));
  });

  it("não audita uma rodada sem novos avisos", async () => {
    vi.mocked(createAdminClient).mockReturnValue(admin({ examinados: 1, avisados: 0, ja_avisados: 1 }, vazio()) as never);
    const { POST } = await import("./route");
    await POST(req());
    expect(audit).not.toHaveBeenCalled();
  });

  it("falha fechado se o claim do banco falhar", async () => {
    const cap = vazio();
    vi.mocked(createAdminClient).mockReturnValue(
      admin({ examinados: 0, avisados: 0, ja_avisados: 0 }, cap, { message: "claim failed" }) as never,
    );
    const { POST } = await import("./route");
    expect((await POST(req())).status).toBe(500);
    expect(cap.chamadas).toHaveLength(1);
    expect(audit).not.toHaveBeenCalled();
  });

  it("sem o segredo, responde 403 e não cria client", async () => {
    const { POST } = await import("./route");
    expect((await POST(new NextRequest("http://localhost/x"))).status).toBe(403);
    expect(createAdminClient).not.toHaveBeenCalled();
  });
});
