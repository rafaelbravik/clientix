import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  readData: null as { smtp_password_encrypted?: string | null } | null,
  readError: null as { message: string } | null,
  throwRead: false,
  writeError: null as { message: string } | null,
  encryption: "encrypted-new" as string | null,
  select: vi.fn(),
  maybeSingle: vi.fn(),
  upsert: vi.fn(),
  encrypt: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({
    from: () => ({
      select: (...args: unknown[]) => {
        mocks.select(...args);
        return {
          eq: () => ({ maybeSingle: () => mocks.maybeSingle() }),
        };
      },
      upsert: (...args: unknown[]) => mocks.upsert(...args),
    }),
  }),
}));
vi.mock("@/lib/webhooks/secrets", () => ({
  encryptWebhookSecret: (...args: unknown[]) => mocks.encrypt(...args),
  decryptWebhookSecret: vi.fn(),
}));

import { saveSmtpConfig } from "@/lib/email/config";

const config = {
  host: "smtp.example.test",
  port: 587,
  security: "starttls" as const,
  username: "sender@example.test",
  password: "",
  fromEmail: "sender@example.test",
  fromName: "Clientix",
  updatedBy: "user-1",
};

beforeEach(() => {
  mocks.readData = null;
  mocks.readError = null;
  mocks.throwRead = false;
  mocks.writeError = null;
  mocks.encryption = "encrypted-new";
  mocks.select.mockClear();
  mocks.maybeSingle.mockReset().mockImplementation(async () => {
    if (mocks.throwRead) throw new Error("network failure");
    return { data: mocks.readData, error: mocks.readError };
  });
  mocks.upsert.mockReset().mockImplementation(async () => ({ error: mocks.writeError }));
  mocks.encrypt.mockReset().mockImplementation(async () => mocks.encryption);
});

describe("saveSmtpConfig — preservação do segredo", () => {
  it("preserva o ciphertext existente quando a leitura conclui sem erro e senha está vazia", async () => {
    mocks.readData = { smtp_password_encrypted: "ciphertext-existing" };

    const result = await saveSmtpConfig(config);

    expect(result).toEqual({ ok: true });
    expect(mocks.upsert.mock.calls[0]?.[0]).toMatchObject({
      smtp_password_encrypted: "ciphertext-existing",
      from_email: config.fromEmail,
    });
  });

  it("salva a nova senha cifrada e substitui a antiga", async () => {
    const result = await saveSmtpConfig({ ...config, password: "new-password" });

    expect(result).toEqual({ ok: true });
    expect(mocks.encrypt).toHaveBeenCalledWith(expect.anything(), "new-password");
    expect(mocks.maybeSingle).not.toHaveBeenCalled();
    expect(mocks.upsert.mock.calls[0]?.[0]).toMatchObject({ smtp_password_encrypted: "encrypted-new" });
  });

  it("falha fechada se a leitura retorna erro e não há senha nova", async () => {
    mocks.readError = { message: "database unavailable" };

    const result = await saveSmtpConfig(config);

    expect(result).toMatchObject({ ok: false });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("falha fechada se a leitura lança erro de rede e não há senha nova", async () => {
    mocks.throwRead = true;

    expect(await saveSmtpConfig(config)).toMatchObject({ ok: false });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("senha nova válida pode seguir sem depender da leitura da antiga", async () => {
    mocks.readError = { message: "database unavailable" };

    const result = await saveSmtpConfig({ ...config, password: "new-password" });

    expect(result).toEqual({ ok: true });
    expect(mocks.upsert.mock.calls[0]?.[0]).toMatchObject({ smtp_password_encrypted: "encrypted-new" });
  });

  it("não grava sender nem senha se a cifra da senha nova falha", async () => {
    mocks.encryption = null;

    const result = await saveSmtpConfig({ ...config, password: "new-password" });

    expect(result).toMatchObject({ ok: false });
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it("não afirma sucesso se o upsert falha", async () => {
    mocks.readData = { smtp_password_encrypted: "ciphertext-existing" };
    mocks.writeError = { message: "write failed" };

    const result = await saveSmtpConfig(config);

    expect(result).toMatchObject({ ok: false, error: "write failed" });
    expect(mocks.upsert.mock.calls[0]?.[0]).toMatchObject({
      smtp_password_encrypted: "ciphertext-existing",
      from_email: config.fromEmail,
    });
  });
});
