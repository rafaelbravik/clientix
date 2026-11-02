/**
 * O limite de falhas do segundo fator vale nas duas actions que conferem o
 * código, e ambas dividem o mesmo contador de servidor por usuário.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const estado = { verificacoes: 0 };

vi.mock("server-only", () => ({}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ get: () => undefined, set: () => {}, delete: () => {} }),
  headers: async () => ({
    get: (k: string) => (k === "x-forwarded-for" ? "198.51.100.7" : null),
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: () => {
    throw new Error("redirect");
  },
}));

vi.mock("@/lib/audit", () => ({ audit: async () => {} }));
vi.mock("@/lib/auth/dispositivo-confiavel", () => ({
  confiarNesteDispositivo: async () => {},
  DIAS_DE_CONFIANCA: 30,
}));

let usuario = "";

vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: usuario } }, error: null }),
      updateUser: async () => ({ error: null }),
      signOut: async () => ({ error: null }),
      mfa: {
        getAuthenticatorAssuranceLevel: async () => ({
          data: { currentLevel: "aal1", nextLevel: "aal2" },
        }),
        listFactors: async () => ({
          data: { totp: [{ id: "fator-1", status: "verified" }] },
        }),
        challenge: async () => ({ data: { id: "desafio-1" }, error: null }),
        verify: async () => {
          estado.verificacoes += 1;
          return { error: { message: "Invalid TOTP code entered" } };
        },
      },
    },
  }),
}));

const SENHA = {
  password: "Nova-senha-1",
  password_confirm: "Nova-senha-1",
  mfa_code: "000000",
};

describe("o limite de falhas do segundo fator", () => {
  beforeEach(() => {
    vi.resetModules();
    estado.verificacoes = 0;
    usuario = crypto.randomUUID();
  });

  it("verifyMfa barra a quarta tentativa sem conferir o código", async () => {
    const { verifyMfa } = await import("./verifyMfa");
    const respostas = [];
    for (let i = 0; i < 4; i++) respostas.push((await verifyMfa("000000")).error);

    expect(respostas).toEqual(["mfa_invalid", "mfa_invalid", "mfa_invalid", "mfa_locked"]);
    expect(estado.verificacoes).toBe(3);
  });

  it("updatePassword barra a quarta tentativa sem conferir o código", async () => {
    const { updatePassword } = await import("./updatePassword");
    const respostas = [];
    for (let i = 0; i < 4; i++) respostas.push((await updatePassword(SENHA)).error);

    expect(respostas).toEqual(["mfa_invalid", "mfa_invalid", "mfa_invalid", "mfa_locked"]);
    expect(estado.verificacoes).toBe(3);
  });

  it("as duas telas contam no mesmo balde do usuário", async () => {
    const { verifyMfa } = await import("./verifyMfa");
    const { updatePassword } = await import("./updatePassword");
    for (let i = 0; i < 3; i++) await verifyMfa("000000");

    expect((await updatePassword(SENHA)).error).toBe("mfa_locked");
    expect(estado.verificacoes).toBe(3);
  });
});
