import { beforeEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";
import { audit } from "@/lib/audit";
import { loadAuthUser, mfaEmDivida, resolveActiveOrg } from "@/lib/auth/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { supportWriteError } from "@/lib/impersonate/support";

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/server", () => ({
  loadAuthUser: vi.fn(),
  mfaEmDivida: vi.fn(async () => false),
  resolveActiveOrg: vi.fn(),
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/impersonate/support", () => ({ supportWriteError: vi.fn(() => false) }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ORG_ID = "22222222-2222-4222-8222-222222222222";
const rpc = vi.fn(async () => ({ data: 1, error: null }));

describe("atualizarLembreteDeCasoParado", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.mocked(loadAuthUser).mockResolvedValue({ id: USER_ID, support: null } as never);
    vi.mocked(resolveActiveOrg).mockResolvedValue({ orgId: ORG_ID, role: "admin" } as never);
    vi.mocked(mfaEmDivida).mockResolvedValue(false);
    vi.mocked(headers).mockResolvedValue({ get: (name: string) => name === "x-request-id" ? "req-1" : null } as never);
    vi.mocked(createAdminClient).mockReturnValue({ rpc } as never);
    rpc.mockResolvedValue({ data: 1, error: null });
  });

  it("persiste pela função atômica com a organização autenticada e audita só a configuração", async () => {
    const { atualizarLembreteDeCasoParado } = await import("./atualizarLembreteDeCasoParado");
    const result = await atualizarLembreteDeCasoParado({ enabled: false, interval_hours: 12, limit: 5 });

    expect(result).toEqual({ ok: true });
    expect(rpc).toHaveBeenCalledWith("fn_definir_case_wait_reminder_config", {
      p_org: ORG_ID,
      p_actor: USER_ID,
      p_enabled: false,
      p_interval_hours: 12,
      p_reminder_limit: 5,
    });
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "ai.case_wait_reminder_config_updated",
      organizationId: ORG_ID,
      metadata: { enabled: false, interval_hours: 12, limit: 5 },
    }));
  });

  it("recusa valores inválidos antes de chamar o banco", async () => {
    const { atualizarLembreteDeCasoParado } = await import("./atualizarLembreteDeCasoParado");
    expect(await atualizarLembreteDeCasoParado({ enabled: true, interval_hours: 0, limit: 3 } as never)).toEqual({
      ok: false,
      error: "validation_failed",
    });
    expect(rpc).not.toHaveBeenCalled();
  });

  it("não permite mutação em suporte somente leitura", async () => {
    vi.mocked(supportWriteError).mockReturnValue("readonly");
    const { atualizarLembreteDeCasoParado } = await import("./atualizarLembreteDeCasoParado");
    expect(await atualizarLembreteDeCasoParado({ enabled: true, interval_hours: 24, limit: 3 })).toEqual({
      ok: false,
      error: "forbidden_role",
    });
    expect(rpc).not.toHaveBeenCalled();
  });
});
