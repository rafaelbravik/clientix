import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const dockerfile = readFileSync("Dockerfile.worker", "utf8");
const trustBuild = readFileSync("scripts/build-worker-certification.ts", "utf8");
const releaseGuard = readFileSync("scripts/assert-worker-release-image.mjs", "utf8");
const releaseMetadata = readFileSync("scripts/lib/release-image-metadata.mjs", "utf8");
const publishWorkflow = readFileSync(".github/workflows/publish-image.yml", "utf8");

describe("worker-certification e barreira de publicação", () => {
  it("isola o módulo TEST em builder próprio e mantém runner como alvo padrão de produção", () => {
    const certificationBuilder = dockerfile.indexOf("FROM build-base AS certification-builder");
    const productionBuilder = dockerfile.indexOf("FROM build-base AS builder");
    const certificationRuntime = dockerfile.indexOf("FROM node:22-alpine AS worker-certification");
    const productionRuntime = dockerfile.lastIndexOf("FROM node:22-alpine AS runner");

    expect(productionBuilder).toBeGreaterThanOrEqual(0);
    expect(certificationBuilder).toBeGreaterThan(productionBuilder);
    expect(certificationRuntime).toBeGreaterThan(certificationBuilder);
    expect(productionRuntime).toBeGreaterThan(certificationRuntime);
    expect(dockerfile.slice(productionBuilder, certificationBuilder)).toContain("FROM build-base AS builder");
    expect(dockerfile.slice(productionRuntime)).toContain('com.clientix.artifact="worker-production"');
    expect(dockerfile.slice(productionRuntime)).toContain('com.clientix.release-eligible="true"');
    expect(dockerfile.slice(productionRuntime)).toContain('com.clientix.test-trust-root="false"');
    expect(dockerfile.slice(certificationRuntime, productionRuntime)).toContain(
      'com.clientix.artifact="worker-certification"',
    );
    expect(dockerfile.slice(certificationRuntime, productionRuntime)).toContain(
      'com.clientix.release-eligible="false"',
    );
    expect(dockerfile.slice(certificationRuntime, productionRuntime)).toContain(
      'com.clientix.test-trust-root="true"',
    );
  });

  it("só recebe a chave pública TEST e valida o bundle sem incluir a autoridade oficial ou chave privada", () => {
    expect(trustBuild).toContain("TEST_LICENSE_KEY_ID");
    expect(trustBuild).toContain("TEST_LICENSE_PUBLIC_KEY_BASE64");
    expect(trustBuild).toContain("createCustomerCertificationTrustModule");
    expect(trustBuild).toContain("clientix-license-2026-01");
    expect(trustBuild).toContain("PRIVATE KEY");
    expect(trustBuild).not.toMatch(/PRIVATE_KEY|PRIVATE_KEY_BASE64|TEST_LICENSE_PRIVATE/);
  });

  it("o publish exige inspeção dos labels OCI e source HEAD antes de qualquer push", () => {
    for (const marker of [
      'spawnSync("docker", ["image", "inspect", imageRef]',
      '"com.clientix.artifact": "worker-production"',
      '"com.clientix.test-trust-root": "false"',
      "releaseImageMetadataMismatches(labels, expectedHead)",
    ]) {
      expect(releaseGuard).toContain(marker);
    }
    expect(releaseMetadata).toContain('"com.clientix.release-eligible"');
    expect(releaseMetadata).toContain('"com.clientix.source-head"');
    expect(releaseMetadata).toContain('"com.clientix.source-dirty"');

    expect(publishWorkflow).toContain("worker-release-guard:");
    expect(publishWorkflow).toContain("scripts/assert-worker-release-image.mjs");
    expect(publishWorkflow).toContain(
      "needs: [a-tag-veio-da-main, worker-release-guard, voice-release-guard]",
    );
    expect(publishWorkflow).toMatch(/name: clientix-worker\s+dockerfile: Dockerfile\.worker\s+target: runner/);
  });
});
