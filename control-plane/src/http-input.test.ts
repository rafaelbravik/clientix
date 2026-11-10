import { afterEach, describe, expect, it, vi } from "vitest";

import { hasSameOrigin } from "./http-input";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("vendor same-origin guard", () => {
  it("accepts the configured public admin origin behind an internal container URL", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CLIENTIX_ADMIN_ORIGIN", "https://admin.example.test/path");

    const request = new Request("http://vendor:3000/api/v1/admin/licenses", {
      headers: { origin: "https://admin.example.test" },
    });

    expect(hasSameOrigin(request)).toBe(true);
  });

  it("rejects an internal origin when the public admin origin is configured", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CLIENTIX_ADMIN_ORIGIN", "https://admin.example.test");

    const request = new Request("http://vendor:3000/api/v1/admin/licenses", {
      headers: { origin: "http://vendor:3000" },
    });

    expect(hasSameOrigin(request)).toBe(false);
  });

  it("fails closed in production when the canonical admin origin is missing", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CLIENTIX_ADMIN_ORIGIN", "");

    const request = new Request("http://vendor:3000/api/v1/admin/licenses", {
      headers: {
        origin: "http://vendor:3000",
        "x-forwarded-host": "vendor.example.test",
        "x-forwarded-proto": "https",
      },
    });

    expect(hasSameOrigin(request)).toBe(false);
  });

  it("uses the request origin as a local development fallback", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("CLIENTIX_ADMIN_ORIGIN", "");

    const request = new Request("http://localhost:3100/api/v1/admin/licenses", {
      headers: { origin: "http://localhost:3100" },
    });

    expect(hasSameOrigin(request)).toBe(true);
  });

  it.each(["localhost", "127.0.0.1", "[::1]"])(
    "accepts the exact configured loopback origin %s",
    (host) => {
      vi.stubEnv("NODE_ENV", "production");
      const origin = "http://" + host + ":3103";
      vi.stubEnv("CLIENTIX_ADMIN_ORIGIN", origin);

      const request = new Request("http://vendor:3000/api/v1/admin/licenses", {
        headers: { origin },
      });

      expect(hasSameOrigin(request)).toBe(true);
    },
  );

  it("does not treat different loopback aliases as the same origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CLIENTIX_ADMIN_ORIGIN", "http://localhost:3103");

    const request = new Request("http://vendor:3000/api/v1/admin/licenses", {
      headers: { origin: "http://127.0.0.1:3103" },
    });

    expect(hasSameOrigin(request)).toBe(false);
  });

  it.each([
    ["wrong port", "https://admin.example.test:444"],
    ["wrong scheme", "http://admin.example.test"],
    ["foreign origin", "https://evil.example.test"],
  ])("rejects %s", (_label, origin) => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CLIENTIX_ADMIN_ORIGIN", "https://admin.example.test");

    const request = new Request("http://vendor:3000/api/v1/admin/licenses", {
      headers: { origin },
    });

    expect(hasSameOrigin(request)).toBe(false);
  });

  it("does not let forged forwarded headers substitute for a foreign Origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("CLIENTIX_ADMIN_ORIGIN", "https://admin.example.test");

    const request = new Request("http://vendor:3000/api/v1/admin/licenses", {
      headers: {
        origin: "https://evil.example.test",
        host: "vendor:3000",
        "x-forwarded-host": "admin.example.test",
        "x-forwarded-proto": "https",
      },
    });

    expect(hasSameOrigin(request)).toBe(false);
  });
});
