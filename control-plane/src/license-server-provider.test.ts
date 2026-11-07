import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  resolveControlPlaneConfig,
  ControlPlaneConfigurationError,
} from "./admin-service-provider";
import { resolveLicenseServerRuntimeConfig } from "./license-server-provider";

function makePrivateKey(): string {
  const pair = generateKeyPairSync("ed25519");
  return pair.privateKey.export({ format: "pem", type: "pkcs8" }).toString();
}

describe("License Server runtime boundary", () => {
  it("requires a separate Control Plane database and an explicit key id", () => {
    const privateKey = makePrivateKey();
    const config = resolveLicenseServerRuntimeConfig(
      {
        CONTROL_PLANE_DATABASE_URL: "postgres://vendor:synthetic@license-db:5432/license_server",
        CONTROL_PLANE_PEPPER: "synthetic-test-pepper-with-more-than-32-bytes",
        CONTROL_PLANE_LICENSE_SIGNING_KEYS_JSON: JSON.stringify({ "dev-only-2026": privateKey }),
        CONTROL_PLANE_ACTIVE_LICENSE_KEY_ID: "dev-only-2026",
      },
      "postgres://client:synthetic@customer-db:5432/clientix",
    );

    expect(config.activeKeyId).toBe("dev-only-2026");
    expect(config.signingKeys.map(({ keyId }) => keyId)).toEqual(["dev-only-2026"]);
    expect(config.nextCheckHours).toBe(24);
    expect(config.offlineValidationToleranceDays).toBe(7);
    expect(JSON.stringify(config)).toContain("PRIVATE KEY");
  });

  it("fails closed when the customer and Control Plane URLs identify the same database", () => {
    expect(() =>
      resolveControlPlaneConfig(
        {
          CONTROL_PLANE_DATABASE_URL: "postgres://vendor:synthetic@db.internal:5432/clientix",
          CONTROL_PLANE_PEPPER: "synthetic-test-pepper-with-more-than-32-bytes",
        },
        "postgres://client:synthetic@db.internal/clientix",
      ),
    ).toThrow(ControlPlaneConfigurationError);
  });

  it("rejects a key registry without the configured active key without echoing the key", () => {
    const privateKey = makePrivateKey();
    expect(() =>
      resolveLicenseServerRuntimeConfig(
        {
          CONTROL_PLANE_DATABASE_URL: "postgres://vendor:synthetic@license-db:5432/license_server",
          CONTROL_PLANE_PEPPER: "synthetic-test-pepper-with-more-than-32-bytes",
          CONTROL_PLANE_LICENSE_SIGNING_KEYS_JSON: JSON.stringify({ "other-dev-key": privateKey }),
          CONTROL_PLANE_ACTIVE_LICENSE_KEY_ID: "missing-dev-key",
        },
        "postgres://client:synthetic@customer-db:5432/clientix",
      ),
    ).toThrow(ControlPlaneConfigurationError);
  });
});
