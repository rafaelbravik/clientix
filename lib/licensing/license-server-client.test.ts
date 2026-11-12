import { afterEach, describe, expect, it, vi } from "vitest";

import { LicenseServerClientError, resolveLicenseServerUrl } from "./license-server-client";

describe("resolveLicenseServerUrl", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("allows the isolated Vendor service over HTTP only in the generated local stack", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DESKCOMM_ENV_MODE", "local");

    expect(resolveLicenseServerUrl("http://vendor:3000").toString()).toBe("http://vendor:3000/");
  });

  it("keeps plain HTTP to non-local hosts rejected", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("DESKCOMM_ENV_MODE", "local");

    expect(() => resolveLicenseServerUrl("http://licensing.example.com")).toThrow(
      LicenseServerClientError,
    );
  });
});
