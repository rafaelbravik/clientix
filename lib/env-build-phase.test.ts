import { afterEach, describe, expect, it, vi } from "vitest";

describe("validação de ingress durante o build da imagem genérica", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("usa modo local só para aceitar os placeholders .invalid no build", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    vi.stubEnv("CLIENTIX_INGRESS_MODE", "");
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NEXT_PUBLIC_ADMIN_URL", "");
    vi.resetModules();

    const { env } = await import("@/lib/env");

    expect(env.CLIENTIX_INGRESS_MODE).toBe("local");
    expect(env.NEXT_PUBLIC_APP_URL).toBe("https://build-placeholder.invalid");
    expect(env.NEXT_PUBLIC_ADMIN_URL).toBe("https://build-placeholder.invalid");
  });
});
