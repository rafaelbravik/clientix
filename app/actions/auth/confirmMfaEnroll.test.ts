import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  redirect: vi.fn(),
  createClient: vi.fn(),
  createAdminClient: vi.fn(),
  audit: vi.fn(),
  isServiceRoleConfigured: vi.fn(),
  generateRecoveryCodes: vi.fn(),
  hashRecoveryCode: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/supabase/server", () => ({ createClient: mocks.createClient }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: mocks.createAdminClient }));
vi.mock("@/lib/audit", () => ({
  audit: mocks.audit,
  isServiceRoleConfigured: mocks.isServiceRoleConfigured,
}));
vi.mock("@/lib/auth/recovery-codes", () => ({
  generateRecoveryCodes: mocks.generateRecoveryCodes,
  hashRecoveryCode: mocks.hashRecoveryCode,
}));

const codes = Array.from({ length: 10 }, (_, i) => `BBBBBBB${String(i)}`);
const sessionFrom = vi.fn();
const adminInsert = vi.fn();
const challenge = vi.fn();
const verify = vi.fn();

beforeEach(() => {
  vi.resetModules();
  mocks.headers.mockClear();
  mocks.redirect.mockClear();
  mocks.createClient.mockClear();
  mocks.createAdminClient.mockClear();
  mocks.audit.mockClear();
  mocks.isServiceRoleConfigured.mockClear();
  mocks.generateRecoveryCodes.mockClear();
  mocks.hashRecoveryCode.mockClear();
  mocks.headers.mockResolvedValue({ get: () => null });
  mocks.redirect.mockImplementation((destination: string) => {
    throw new Error(`redirect:${destination}`);
  });
  mocks.isServiceRoleConfigured.mockReturnValue(true);
  mocks.audit.mockResolvedValue(undefined);
  mocks.generateRecoveryCodes.mockReturnValue(codes);
  mocks.hashRecoveryCode.mockImplementation((code: string) => Buffer.from(`hash:${code}`));
  sessionFrom.mockReset();
  adminInsert.mockReset().mockResolvedValue({ error: null });
  challenge.mockReset().mockResolvedValue({ data: { id: "challenge-1" }, error: null });
  verify.mockReset().mockResolvedValue({ error: null });

  mocks.createClient.mockResolvedValue({
    auth: {
      getUser: vi.fn(async () => ({ data: { user: { id: "user-1" } } })),
      mfa: { challenge, verify },
    },
    from: sessionFrom,
  });
  mocks.createAdminClient.mockReturnValue({
    from: vi.fn(() => ({ insert: adminInsert })),
  });
});

describe("confirmMfaEnroll — recuperação permanece no caminho privilegiado", () => {
  it("primeiro enrollment grava hashes no servidor e entrega os códigos uma vez", async () => {
    const { confirmMfaEnroll } = await import("./confirmMfaEnroll");

    await expect(confirmMfaEnroll("123456", "factor-1")).resolves.toEqual({
      ok: true,
      recovery_codes: codes,
    });

    expect(challenge).toHaveBeenCalledWith({ factorId: "factor-1" });
    expect(verify).toHaveBeenCalledWith({
      factorId: "factor-1",
      challengeId: "challenge-1",
      code: "123456",
    });
    expect(sessionFrom).not.toHaveBeenCalled();
    expect(adminInsert).toHaveBeenCalledWith(
      codes.map((code) => ({ user_id: "user-1", code_hash: Buffer.from(`hash:${code}`) })),
    );
  });

  it("sem service role não confirma o fator nem retorna códigos falsos", async () => {
    mocks.isServiceRoleConfigured.mockReturnValue(false);
    const { confirmMfaEnroll } = await import("./confirmMfaEnroll");

    await expect(confirmMfaEnroll("123456", "factor-1")).resolves.toEqual({
      ok: false,
      error: "service_unavailable",
    });

    expect(challenge).not.toHaveBeenCalled();
    expect(verify).not.toHaveBeenCalled();
    expect(sessionFrom).not.toHaveBeenCalled();
    expect(mocks.createAdminClient).not.toHaveBeenCalled();
    expect(adminInsert).not.toHaveBeenCalled();
    expect(mocks.generateRecoveryCodes).not.toHaveBeenCalled();
  });
});
