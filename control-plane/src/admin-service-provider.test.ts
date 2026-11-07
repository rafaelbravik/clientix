import { describe, expect, it } from "vitest";

import {
  ControlPlaneConfigurationError,
  resolveControlPlaneConfig,
} from "./admin-service-provider";

describe("provider do Control Plane", () => {
  it("requires a dedicated database and a non-fallback pepper", () => {
    expect(() =>
      resolveControlPlaneConfig({ SUPABASE_DB_URL: "postgres://localhost/clientix" }),
    ).toThrow(ControlPlaneConfigurationError);
    expect(() =>
      resolveControlPlaneConfig({
        CONTROL_PLANE_DATABASE_URL: "postgres://localhost/control_plane",
        SUPABASE_DB_URL: "postgres://localhost/clientix",
      }),
    ).toThrow(ControlPlaneConfigurationError);
  });

  it("refuses the customer database even when vendor variables are set", () => {
    expect(() =>
      resolveControlPlaneConfig({
        CONTROL_PLANE_DATABASE_URL: "postgres://localhost/clientix",
        CONTROL_PLANE_PEPPER: "p".repeat(32),
        SUPABASE_DB_URL: "postgres://localhost/clientix",
      }),
    ).toThrow(ControlPlaneConfigurationError);
  });

  it("accepts a separate database and returns only the configured connection contract", () => {
    expect(
      resolveControlPlaneConfig({
        CONTROL_PLANE_DATABASE_URL: "postgres://localhost/control_plane",
        CONTROL_PLANE_PEPPER: "p".repeat(32),
        SUPABASE_DB_URL: "postgres://localhost/clientix",
      }),
    ).toEqual({
      databaseUrl: "postgres://localhost/control_plane",
      pepper: "p".repeat(32),
    });
  });
});
