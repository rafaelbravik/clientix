import { afterEach, describe, expect, it, vi } from "vitest";

import { hasSameOrigin } from "./http-input";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("vendor same-origin guard", () => {
  it("accepts the configured public admin origin behind an internal container URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ADMIN_URL", "https://admin.example.test/path");

    const request = new Request("http://vendor:3000/api/v1/admin/licenses", {
      headers: { origin: "https://admin.example.test" },
    });

    expect(hasSameOrigin(request)).toBe(true);
  });

  it("rejects an internal origin when the public admin origin is configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ADMIN_URL", "https://admin.example.test");

    const request = new Request("http://vendor:3000/api/v1/admin/licenses", {
      headers: { origin: "http://vendor:3000" },
    });

    expect(hasSameOrigin(request)).toBe(false);
  });

  it("fails closed in production when the canonical admin origin is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_ADMIN_URL", "");

    const request = new Request("http://vendor:3000/api/v1/admin/licenses", {
      headers: { origin: "http://vendor:3000" },
    });

    expect(hasSameOrigin(request)).toBe(false);
  });

  it("uses the request origin as a local development fallback", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_ADMIN_URL", "");

    const request = new Request("http://localhost:3100/api/v1/admin/licenses", {
      headers: { origin: "http://localhost:3100" },
    });

    expect(hasSameOrigin(request)).toBe(true);
  });
});
