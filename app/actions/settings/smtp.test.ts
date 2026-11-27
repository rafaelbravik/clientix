import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authorize: vi.fn(),
  save: vi.fn(),
  audit: vi.fn(),
}));

vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-request-id": "req-smtp" }) }));
vi.mock("@/lib/auth/escritaDeOwnerOuRecusa", () => ({ escritaDeOwnerOuRecusa: mocks.authorize }));
vi.mock("@/lib/email/config", () => ({ saveSmtpConfig: mocks.save }));
vi.mock("@/lib/email/smtp", () => ({ checkSmtpConfiguration: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));

import { updateSmtp } from "@/app/actions/settings/smtp";

const input = {
  host: "smtp.example.test",
  port: 587,
  security: "starttls" as const,
  username: "sender@example.test",
  password: "",
  from_email: "sender@example.test",
  from_name: "Clientix",
};

beforeEach(() => {
  mocks.authorize.mockReset().mockResolvedValue({ ok: true, ctx: { user: { id: "user-1" } } });
  mocks.save.mockReset();
  mocks.audit.mockReset().mockResolvedValue(undefined);
});

describe("updateSmtp — resultado e auditoria", () => {
  it("não registra sucesso quando a persistência SMTP falha", async () => {
    mocks.save.mockResolvedValue({ ok: false, error: "Não foi possível salvar." });

    const result = await updateSmtp(input);

    expect(result).toMatchObject({ ok: false });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("audita a atualização somente depois da persistência bem-sucedida", async () => {
    mocks.save.mockResolvedValue({ ok: true });

    const result = await updateSmtp(input);

    expect(result).toEqual({ ok: true });
    expect(mocks.audit).toHaveBeenCalledWith(expect.objectContaining({
      action: "platform_smtp_settings.updated",
      actorUserId: "user-1",
    }));
  });
});
