import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createTransport: vi.fn(),
  getSmtpConfig: vi.fn(),
  sendMail: vi.fn(),
  verify: vi.fn(),
}));

vi.mock("nodemailer", () => ({
  default: { createTransport: mocks.createTransport },
}));

vi.mock("@/lib/email/config", () => ({
  getSmtpConfig: mocks.getSmtpConfig,
}));

import { sendEmail } from "./smtp";

const SMTP_CONFIG = {
  host: "smtp.example.test",
  port: 587,
  security: "starttls" as const,
  username: "mailer",
  password: "secret",
  fromEmail: "sender@example.test",
  fromName: "Sender",
  source: "environment" as const,
};

describe("SMTP recipient parsing guard", () => {
  beforeEach(() => {
    mocks.createTransport.mockClear();
    mocks.getSmtpConfig.mockReset().mockResolvedValue(SMTP_CONFIG);
    mocks.sendMail.mockReset().mockResolvedValue({ messageId: "smtp-message" });
    mocks.verify.mockReset();
    mocks.createTransport.mockImplementation(() => ({
      sendMail: mocks.sendMail,
      verify: mocks.verify,
    }));
  });

  it.each([
    ["LF in To", { to: "victim@safe.test\nBcc: evil@evil.test" }],
    ["CR in To", { to: "victim@safe.test\rBcc: evil@evil.test" }],
    ["CRLF in an address array", { to: ["ok@safe.test", "victim@safe.test\r\nBcc: evil@evil.test"] }],
    ["LF in Reply-To", { to: "victim@safe.test", replyTo: "reply@safe.test\nBcc: evil@evil.test" }],
    ["CR in Reply-To", { to: "victim@safe.test", replyTo: "reply@safe.test\rBcc: evil@evil.test" }],
    ["malformed syntax without a mailbox", { to: "Victim (x(y) <evil@evil.test>" }],
  ])("rejects %s before reading SMTP configuration or opening transport", async (_label, fields) => {
    const result = await sendEmail({
      ...fields,
      subject: "Test",
      html: "<p>Test</p>",
    });

    expect(result).toEqual({
      ok: false,
      error: "send_failed",
      details: "Invalid recipient address.",
    });
    expect(mocks.getSmtpConfig).not.toHaveBeenCalled();
    expect(mocks.createTransport).not.toHaveBeenCalled();
    expect(mocks.sendMail).not.toHaveBeenCalled();
  });

  it("keeps the empty-recipient path delegated to Nodemailer", async () => {
    const result = await sendEmail({ to: "", subject: "Test", html: "<p>Test</p>" });

    expect(result).toEqual({ ok: true, id: "smtp-message" });
    expect(mocks.sendMail).toHaveBeenCalledWith(expect.objectContaining({ to: "" }));
  });
});
