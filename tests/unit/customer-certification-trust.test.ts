import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";

import {
  createCustomerCertificationTrustModule,
  parseCustomerBuildArguments,
} from "@/scripts/lib/customer-certification-trust";

function publicKeyArgument(): string {
  const { publicKey } = generateKeyPairSync("ed25519");
  return Buffer.from(publicKey.export({ format: "pem", type: "spki" }).toString()).toString("base64");
}

describe("trust root de certificação customer", () => {
  it("exige modo explícito e identifica a chave como autoridade de teste", () => {
    const keyId = "clientix-certification-test-run-12345678";
    const publicKeyBase64 = publicKeyArgument();
    const parsed = parseCustomerBuildArguments([
      "--certification",
      "--key-id",
      keyId,
      "--public-key-base64",
      publicKeyBase64,
      "/tmp/customer-certification-output",
    ]);

    expect(parsed).toEqual({
      mode: "certification",
      keyId,
      publicKeyBase64,
      outputPath: "/tmp/customer-certification-output",
    });

    const moduleSource = createCustomerCertificationTrustModule(keyId, publicKeyBase64);
    expect(moduleSource).toContain("DEFAULT_TRUSTED_KEYS");
    expect(moduleSource).toContain("export function trustedKeysForBuild()");
    expect(moduleSource).toContain("return DEFAULT_TRUSTED_KEYS;");
    expect(moduleSource).toContain(keyId);
    expect(moduleSource).toContain("BEGIN PUBLIC KEY");
    expect(moduleSource).not.toContain("PRIVATE KEY");
    expect(moduleSource).not.toContain("clientix-license-2026-01");
  });

  it("recusa flags de certificação sem modo explícito e IDs fora do namespace de teste", () => {
    expect(() => parseCustomerBuildArguments(["--key-id", "clientix-certification-test-run-12345678"])).toThrow(
      /modo de certificação explícito/,
    );
    expect(() =>
      createCustomerCertificationTrustModule("clientix-license-2026-01", publicKeyArgument()),
    ).toThrow(/namespace de certificação/);
  });

  it("recusa chave privada, chave inválida e parâmetros incompletos", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const privateKeyBase64 = Buffer.from(
      privateKey.export({ format: "pem", type: "pkcs8" }).toString(),
    ).toString("base64");

    expect(() =>
      createCustomerCertificationTrustModule(
        "clientix-certification-test-run-12345678",
        privateKeyBase64,
      ),
    ).toThrow(/somente uma chave pública Ed25519/);
    expect(() =>
      createCustomerCertificationTrustModule("clientix-certification-test-run-12345678", "not-base64"),
    ).toThrow(/chave pública Ed25519 inválida/);
    expect(() =>
      parseCustomerBuildArguments([
        "--certification",
        "--key-id",
        "clientix-certification-test-run-12345678",
        "/tmp/output",
      ]),
    ).toThrow(/parâmetros obrigatórios/);
  });
});
