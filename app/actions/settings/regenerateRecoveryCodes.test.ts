import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  sessionAal: vi.fn(),
  audit: vi.fn(),
  isServiceRoleConfigured: vi.fn(),
  generateRecoveryCodes: vi.fn(),
  hashRecoveryCode: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/auth/server", () => ({ sessionAal: mocks.sessionAal }));
vi.mock("@/lib/audit", () => ({
  audit: mocks.audit,
  isServiceRoleConfigured: mocks.isServiceRoleConfigured,
}));
vi.mock("@/lib/auth/recovery-codes", () => ({
  generateRecoveryCodes: mocks.generateRecoveryCodes,
  hashRecoveryCode: mocks.hashRecoveryCode,
}));

const codes = Array.from({ length: 10 }, (_, i) => `AAAAAAA${String(i)}`);
const persisted: Array<{ user_id: string; code_hash: Buffer }> = [];
const authenticatedFrom = vi.fn();
const adminFrom = vi.fn();

function criarClientes() {
  const supabase = {
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
      mfa: {
        listFactors: vi.fn(async () => ({ data: { totp: [{ status: "verified" }] } })),
      },
    },
    from: authenticatedFrom,
  };
  const admin = { from: adminFrom };

  mocks.createClient.mockResolvedValue(supabase);
  mocks.createAdminClient.mockReturnValue(admin);
  return { supabase, admin };
}

beforeEach(() => {
  vi.resetModules();
  mocks.headers.mockClear();
  mocks.createClient.mockClear();
  mocks.createAdminClient.mockClear();
  mocks.sessionAal.mockClear();
  mocks.audit.mockClear();
  mocks.isServiceRoleConfigured.mockClear();
  mocks.generateRecoveryCodes.mockClear();
  mocks.hashRecoveryCode.mockClear();
  persisted.splice(0);
  authenticatedFrom.mockReset();
  adminFrom.mockReset().mockImplementation((table: string) => {
    expect(table).toBe("user_recovery_codes");
    return {
      delete: () => ({
        eq: vi.fn(async (_column: string, userId: string) => {
          for (let i = persisted.length - 1; i >= 0; i--) {
            if (persisted[i]?.user_id === userId) persisted.splice(i, 1);
          }
          return { error: null };
        }),
      }),
      insert: vi.fn(async (rows: Array<{ user_id: string; code_hash: Buffer }>) => {
        persisted.push(...rows);
        return { error: null };
      }),
    };
  });
  mocks.headers.mockResolvedValue({ get: () => null });
  mocks.sessionAal.mockResolvedValue("aal1");
  mocks.audit.mockResolvedValue(undefined);
  mocks.isServiceRoleConfigured.mockReturnValue(true);
  mocks.generateRecoveryCodes.mockReturnValue(codes);
  mocks.hashRecoveryCode.mockImplementation((code: string) => Buffer.from(`hash:${code}`));
  criarClientes();
});

describe("regenerateRecoveryCodes — prova da sessão e armazenamento privilegiado", () => {
  it("recusa AAL1 mesmo com TOTP verificado e não escreve", async () => {
    const { regenerateRecoveryCodes } = await import("./regenerateRecoveryCodes");

    await expect(regenerateRecoveryCodes()).resolves.toEqual({ ok: false, error: "mfa_required" });

    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(adminFrom).not.toHaveBeenCalled();
    expect(authenticatedFrom).not.toHaveBeenCalled();
    expect(mocks.generateRecoveryCodes).not.toHaveBeenCalled();
    expect(persisted).toHaveLength(0);
  });

  it("em AAL2 substitui os códigos anteriores através do service role", async () => {
    mocks.sessionAal.mockResolvedValue("aal2");
    persisted.push({ user_id: "user-1", code_hash: Buffer.from("hash:old-code") });
    const { regenerateRecoveryCodes } = await import("./regenerateRecoveryCodes");

    const resultado = await regenerateRecoveryCodes();

    expect(resultado).toEqual({ ok: true, recovery_codes: codes });
    expect(persisted).toHaveLength(10);
    expect(persisted.every((row) => row.user_id === "user-1")).toBe(true);
    expect(persisted.map((row) => row.code_hash.toString())).not.toContain("hash:old-code");
    expect(authenticatedFrom).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "mfa.recovery_codes_regenerated",
      actorUserId: "user-1",
    }));
  });

  it("falha fechado sem service role e não gera nem devolve códigos", async () => {
    mocks.sessionAal.mockResolvedValue("aal2");
    mocks.isServiceRoleConfigured.mockReturnValue(false);
    const { regenerateRecoveryCodes } = await import("./regenerateRecoveryCodes");

    await expect(regenerateRecoveryCodes()).resolves.toEqual({
      ok: false,
      error: "service_unavailable",
    });

    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(adminFrom).not.toHaveBeenCalled();
    expect(authenticatedFrom).not.toHaveBeenCalled();
    expect(mocks.generateRecoveryCodes).not.toHaveBeenCalled();
    expect(persisted).toHaveLength(0);
  });
});
