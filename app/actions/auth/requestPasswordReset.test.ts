import { afterEach, describe, expect, it, vi } from "vitest";

import { headers } from "next/headers";

const state = vi.hoisted(() => ({ reset: vi.fn(), rateLimited: vi.fn() }));

vi.mock("next/headers", () => ({ headers: vi.fn() }));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(async () => ({ auth: { resetPasswordForEmail: state.reset } })),
}));
vi.mock("@/lib/auth/rate-limit", () => ({
  authRateLimited: state.rateLimited,
  AUTH_LIMITS: { reset: { ip: 30, id: 3, windowSec: 3600 } },
}));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(), hashEmail: vi.fn(() => "email-hash") }));

describe("requestPasswordReset — callback usa origem configurada", () => {
  afterEach(() => {
    state.reset.mockReset();
    state.rateLimited.mockReset();
    vi.resetModules();
    vi.unstubAllEnvs();
  });

  it("ignora Origin enviado pelo cliente ao montar o link de recuperação", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://clientix.example");
    vi.mocked(headers).mockResolvedValue({
      get: (key: string) =>
        key === "origin"
          ? "https://attacker.example"
          : key === "x-forwarded-for"
            ? "192.0.2.50"
            : null,
    } as never);
    state.rateLimited.mockResolvedValue(false);
    state.reset.mockResolvedValue({ error: null });

    const { requestPasswordReset } = await import("./requestPasswordReset");
    const result = await requestPasswordReset({ email: "cliente@example.test" });

    expect(result).toEqual({ ok: true });
    expect(state.reset).toHaveBeenCalledWith("cliente@example.test", {
      redirectTo: "https://clientix.example/auth/confirm?type=recovery",
    });
    expect(state.reset).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ redirectTo: expect.stringContaining("attacker.example") }),
    );
  });
});
