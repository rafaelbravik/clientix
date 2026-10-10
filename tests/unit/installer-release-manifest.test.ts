import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_TRUSTED_KEYS } from "@/lib/licensing/verify";

const verifierPath = path.resolve("distribution/installer/verify-release-manifest.mjs");
const manifestPath = path.resolve("distribution/installer/release-manifest.json");
const releaseTrustRoot = path.resolve("distribution/installer/trust/release-manifest");
const installerVersion = readFileSync(path.resolve("distribution/installer/VERSION"), "utf8").trim();

function runSchemaCheck(status: Record<string, unknown>) {
  return spawnSync(
    process.execPath,
    [verifierPath, "schema-check", manifestPath, releaseTrustRoot, installerVersion, "-"],
    { encoding: "utf8", input: JSON.stringify(status) },
  );
}

describe("installer signed release manifest gate", () => {
  it("accepts the signed production release manifest through its versioned trust root", () => {
    const result = spawnSync(
      process.execPath,
      [verifierPath, "verify", manifestPath, releaseTrustRoot, installerVersion],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      release_version: "1.0.0",
      schema_target: "0510",
      images: {
        app: expect.stringMatching(/@sha256:[0-9a-f]{64}$/),
        worker: expect.stringMatching(/@sha256:[0-9a-f]{64}$/),
        scheduler: expect.stringMatching(/@sha256:[0-9a-f]{64}$/),
        voice_agent: expect.stringMatching(/@sha256:[0-9a-f]{64}$/),
        migrator: expect.stringMatching(/@sha256:[0-9a-f]{64}$/),
      },
    });
  });

  it("accepts an installer at or above the signed minimum and rejects older or malformed versions", () => {
    const equal = spawnSync(process.execPath, [verifierPath, "verify", manifestPath, releaseTrustRoot, "1.0.0"], { encoding: "utf8" });
    const newer = spawnSync(process.execPath, [verifierPath, "verify", manifestPath, releaseTrustRoot, "2.0.0"], { encoding: "utf8" });
    const older = spawnSync(process.execPath, [verifierPath, "verify", manifestPath, releaseTrustRoot, "0.9.9"], { encoding: "utf8" });
    const malformed = spawnSync(process.execPath, [verifierPath, "verify", manifestPath, releaseTrustRoot, "01.0.0"], { encoding: "utf8" });

    expect(equal.status).toBe(0);
    expect(newer.status).toBe(0);
    expect(older.stderr).toContain("INSTALLER_VERSION_UNSUPPORTED");
    expect(malformed.stderr).toContain("INVALID_INSTALLER_VERSION");
  });

  it("allows fresh install and tracked updates at the signed schema boundaries", () => {
    const fresh = runSchemaCheck({
      state_type: "FRESH_DATABASE",
      target_baseline: "0510",
      current_schema: null,
      schema_evidence_valid: true,
    });
    const atBoundary = runSchemaCheck({
      state_type: "TRACKED_INSTALLATION",
      target_baseline: "0510",
      current_schema: "0510",
      schema_evidence_valid: true,
    });

    expect(fresh.status).toBe(0);
    expect(JSON.parse(fresh.stdout)).toMatchObject({ allowed: true, current_schema: null });
    expect(atBoundary.status).toBe(0);
    expect(JSON.parse(atBoundary.stdout)).toMatchObject({ allowed: true, current_schema: "0510" });
  });

  it("blocks a tracked schema outside the signed direct-update range", () => {
    const below = runSchemaCheck({
      state_type: "TRACKED_INSTALLATION", target_baseline: "0510", current_schema: "0509", schema_evidence_valid: true,
    });
    const above = runSchemaCheck({
      state_type: "TRACKED_INSTALLATION", target_baseline: "0510", current_schema: "0511", schema_evidence_valid: true,
    });

    expect(below.stderr).toContain("SCHEMA_TOO_OLD_FOR_DIRECT_UPDATE");
    expect(above.stderr).toContain("SCHEMA_NEWER_THAN_RELEASE");
  });

  it("rejects tampered minimum-installer and schema compatibility fields before using them", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-manifest-compatibility-tamper-test-"));
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      payload: { min_installer_version: string; compatibility: { min_schema: string; max_schema: string } };
      [key: string]: unknown;
    };
    const variants = [
      { ...manifest, payload: { ...manifest.payload, min_installer_version: "not-semver" } },
      { ...manifest, payload: { ...manifest.payload, compatibility: { ...manifest.payload.compatibility, min_schema: "0509" } } },
    ];

    try {
      for (const [index, altered] of variants.entries()) {
        const alteredPath = path.join(tempDir, `manifest-${index}.json`);
        await fs.writeFile(alteredPath, JSON.stringify(altered));
        const result = spawnSync(process.execPath, [verifierPath, "verify", alteredPath, releaseTrustRoot, installerVersion], { encoding: "utf8" });
        expect(result.stderr).toContain("MANIFEST_SIGNATURE_INVALID");
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects the signed release manifest after its payload is changed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-manifest-tamper-test-"));
    const alteredManifestPath = path.join(tempDir, "manifest.json");
    const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
      payload: { images: { app: { tag: string } } };
      [key: string]: unknown;
    };
    manifest.payload.images.app.tag = "tampered";
    await fs.writeFile(alteredManifestPath, JSON.stringify(manifest));

    try {
      const result = spawnSync(
        process.execPath,
        [verifierPath, "verify", alteredManifestPath, releaseTrustRoot, installerVersion],
        { encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("MANIFEST_SIGNATURE_INVALID");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("rejects the release signature when the release key ID points to the license public key", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-manifest-wrong-root-test-"));
    const trustRoot = path.join(tempDir, "trust");
    const licensePublicKey = DEFAULT_TRUSTED_KEYS["clientix-license-2026-01"];
    await fs.mkdir(trustRoot);
    expect(licensePublicKey).toContain("BEGIN PUBLIC KEY");
    await fs.writeFile(
      path.join(trustRoot, "clientix-release-2026-01.pem"),
      licensePublicKey ?? "",
    );

    try {
      const result = spawnSync(
        process.execPath,
        [verifierPath, "verify", manifestPath, trustRoot, installerVersion],
        { encoding: "utf8" },
      );
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("MANIFEST_SIGNATURE_INVALID");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("blocks a well-shaped signed manifest when no trusted public key is installed", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-manifest-trust-test-"));
    const trustRoot = path.join(tempDir, "trust");
    const untrustedManifestPath = path.join(tempDir, "manifest.json");
    await fs.mkdir(trustRoot);

    const architecture = process.arch === "arm64" ? "arm64" : "amd64";
    const payload = {
      release_version: "1.2.3",
      min_installer_version: "1.0.0",
      schema_target: "0510",
      released_at: "2026-10-08T10:00:00Z",
      architectures: [architecture],
      images: Object.fromEntries(["app", "worker", "scheduler", "voice_agent", "migrator"].map((name) => [name, {
        repository: `ghcr.io/example/clientix-${name.replace("_", "-")}`,
        tag: "1.2.3",
        digest: `sha256:${"a".repeat(64)}`,
      }])),
    };
    await fs.writeFile(untrustedManifestPath, JSON.stringify({
      payload,
      keyId: "production-release-key",
      algorithm: "Ed25519",
      purpose: "release_manifest",
      signature: "A".repeat(86),
    }));

    try {
      const result = spawnSync(process.execPath, [verifierPath, "verify", untrustedManifestPath, trustRoot, installerVersion], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain("MANIFEST_KEY_UNTRUSTED");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
