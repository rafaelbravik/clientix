import { generateKeyPairSync, sign as signBytes, type KeyObject } from "node:crypto";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const verifierPath = path.resolve("distribution/installer/verify-release-manifest.mjs");
const heldManifestPath = path.resolve("distribution/installer/release-manifest.json");
const installerVersion = readFileSync(path.resolve("distribution/installer/VERSION"), "utf8").trim();
const schemaRegistry = JSON.parse(readFileSync(path.resolve("supabase/manifest.json"), "utf8")) as {
  schema_target: string;
};

const IMAGE_KEYS = ["app", "worker", "scheduler", "voice_agent", "migrator"] as const;
const TEST_KEY_ID = "clientix-test-release-fixture";
const CURRENT_SCHEMA = schemaRegistry.schema_target;

type ImageKey = (typeof IMAGE_KEYS)[number];
type OptionalImageKey = "caddy";
type Image = { repository: string; tag: string; digest: string };
type Payload = {
  release_version: string;
  min_installer_version: string;
  schema_target: string;
  released_at: string;
  architectures: string[];
  compatibility: {
    compatible_previous_apps: string[];
    min_schema: string;
    max_schema: string;
  };
  images: Record<ImageKey, Image> & Partial<Record<OptionalImageKey, Image>>;
};
type Manifest = {
  payload: Payload;
  keyId: string;
  algorithm: "Ed25519";
  purpose: "release_manifest";
  signature: string;
};

let tempDir = "";
let trustRoot = "";
let fixtureManifestPath = "";
let fixturePrivateKey: KeyObject;
let fixturePayload: Payload;

function canonicalize(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("non-finite number");
    return JSON.stringify(Object.is(value, -0) ? 0 : value) as string;
  }
  if (typeof value === "string") return JSON.stringify(value) as string;
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    const fields = Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalize((value as Record<string, unknown>)[key])}`);
    return `{${fields.join(",")}}`;
  }
  throw new TypeError("unsupported JSON value");
}

function makePayload(overrides: Partial<Payload> = {}): Payload {
  const architecture = process.arch === "arm64" ? "arm64" : "amd64";
  const images = Object.fromEntries(
    IMAGE_KEYS.map((name) => [name, {
      repository: `localhost:5000/clientix-${name.replace("_", "-")}`,
      tag: "certification-fixture",
      digest: `sha256:${"a".repeat(64)}`,
    }]),
  ) as Record<ImageKey, Image>;

  return {
    release_version: "1.70.1-certification.1",
    min_installer_version: "1.0.0",
    schema_target: CURRENT_SCHEMA,
    released_at: "2026-10-15T12:00:00Z",
    architectures: [architecture],
    compatibility: {
      compatible_previous_apps: ["1.70.0"],
      min_schema: "0510",
      max_schema: CURRENT_SCHEMA,
    },
    images,
    ...overrides,
  };
}

function signManifest(payload: Payload, privateKey = fixturePrivateKey, keyId = TEST_KEY_ID): Manifest {
  const signature = signBytes(null, Buffer.from(canonicalize(payload), "utf8"), privateKey).toString("base64url");
  return { payload, keyId, algorithm: "Ed25519", purpose: "release_manifest", signature };
}

async function writeManifest(name: string, manifest: unknown): Promise<string> {
  const manifestPath = path.join(tempDir, name);
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  return manifestPath;
}

function runVerify(
  manifestPath = fixtureManifestPath,
  keyDirectory = trustRoot,
  version = installerVersion,
) {
  return spawnSync(process.execPath, [verifierPath, "verify", manifestPath, keyDirectory, version], {
    encoding: "utf8",
  });
}

function runSchemaCheck(
  status: Record<string, unknown>,
  manifestPath = fixtureManifestPath,
  keyDirectory = trustRoot,
) {
  return spawnSync(
    process.execPath,
    [verifierPath, "schema-check", manifestPath, keyDirectory, installerVersion, "-"],
    { encoding: "utf8", input: JSON.stringify(status) },
  );
}

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-release-manifest-test-"));
  trustRoot = path.join(tempDir, "trust");
  await fs.mkdir(trustRoot);

  const keyPair = generateKeyPairSync("ed25519");
  fixturePrivateKey = keyPair.privateKey;
  await fs.writeFile(
    path.join(trustRoot, `${TEST_KEY_ID}.pem`),
    keyPair.publicKey.export({ type: "spki", format: "pem" }),
  );

  fixturePayload = makePayload();
  fixtureManifestPath = await writeManifest("signed-test-fixture.json", signManifest(fixturePayload));
});

afterAll(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
});

describe("installer signed release manifest gate", () => {
  it("keeps the official HOLD manifest parseable and fail-closed before the signing ceremony", () => {
    const held = JSON.parse(readFileSync(heldManifestPath, "utf8")) as unknown;
    expect(held).toEqual(expect.any(Object));

    const result = runVerify(heldManifestPath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /MANIFEST_KEY_UNTRUSTED|MANIFEST_SIGNATURE_INVALID|MANIFEST_SIGNATURE_MISSING_OR_MALFORMED/,
    );
  });

  it("accepts a valid synthetic manifest signed by an ephemeral test-only Ed25519 key", () => {
    const result = runVerify();
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      release_version: fixturePayload.release_version,
      schema_target: CURRENT_SCHEMA,
      images: Object.fromEntries(IMAGE_KEYS.map((name) => [
        name,
        `localhost:5000/clientix-${name.replace("_", "-")}@sha256:${"a".repeat(64)}`,
      ])),
    });
  });

  it("accepts and returns an optional digest-pinned Caddy ingress image", async () => {
    const digest = "sha256:" + "b".repeat(64);
    const payload = makePayload({
      images: {
        ...fixturePayload.images,
        caddy: {
          repository: "localhost:5000/clientix-ingress",
          tag: "certification-fixture",
          digest,
        },
      },
    });
    const manifestPath = await writeManifest("signed-caddy-fixture.json", signManifest(payload));
    const result = runVerify(manifestPath);

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).images.caddy).toBe("localhost:5000/clientix-ingress@" + digest);
  });

  it("rejects a malformed optional Caddy image instead of ignoring it", async () => {
    const payload = makePayload({
      images: {
        ...fixturePayload.images,
        caddy: {
          repository: "localhost:5000/clientix-ingress",
          tag: "certification-fixture",
          digest: "mutable-tag",
        },
      },
    });
    const manifestPath = await writeManifest("signed-invalid-caddy-fixture.json", signManifest(payload));
    const result = runVerify(manifestPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("INVALID_MANIFEST_DIGEST:caddy");
  });

  it("accepts an installer at or above the signed minimum and rejects older or malformed versions", () => {
    const equal = runVerify(fixtureManifestPath, trustRoot, "1.0.0");
    const newer = runVerify(fixtureManifestPath, trustRoot, "2.0.0");
    const older = runVerify(fixtureManifestPath, trustRoot, "0.9.9");
    const malformed = runVerify(fixtureManifestPath, trustRoot, "01.0.0");

    expect(equal.status).toBe(0);
    expect(newer.status).toBe(0);
    expect(older.stderr).toContain("INSTALLER_VERSION_UNSUPPORTED");
    expect(malformed.stderr).toContain("INVALID_INSTALLER_VERSION");
  });

  it("allows fresh install and tracked updates at the signed schema boundaries", () => {
    const fresh = runSchemaCheck({
      state_type: "FRESH_DATABASE",
      target_baseline: CURRENT_SCHEMA,
      current_schema: null,
      schema_evidence_valid: true,
    });
    const atBoundary = runSchemaCheck({
      state_type: "TRACKED_INSTALLATION",
      target_baseline: CURRENT_SCHEMA,
      current_schema: CURRENT_SCHEMA,
      schema_evidence_valid: true,
    });

    expect(fresh.status).toBe(0);
    expect(JSON.parse(fresh.stdout)).toMatchObject({ allowed: true, current_schema: null });
    expect(atBoundary.status).toBe(0);
    expect(JSON.parse(atBoundary.stdout)).toMatchObject({ allowed: true, current_schema: CURRENT_SCHEMA });
  });

  it("fails closed when a signed older schema target differs from the local migrator registry", async () => {
    const oldPayload = makePayload({
      schema_target: "0510",
      compatibility: { compatible_previous_apps: ["1.70.0"], min_schema: "0510", max_schema: "0510" },
    });
    const oldManifestPath = await writeManifest("signed-old-schema.json", signManifest(oldPayload));
    const result = runSchemaCheck({
      state_type: "FRESH_DATABASE",
      target_baseline: CURRENT_SCHEMA,
      current_schema: null,
      schema_evidence_valid: true,
    }, oldManifestPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MIGRATOR_SCHEMA_TARGET_MISMATCH");
  });

  it("blocks tracked schemas outside the signed direct-update range", async () => {
    const boundedPayload = makePayload({
      compatibility: { compatible_previous_apps: ["1.70.0"], min_schema: "0511", max_schema: "0511" },
    });
    const boundedManifestPath = await writeManifest("signed-bounded-schema.json", signManifest(boundedPayload));
    const below = runSchemaCheck({
      state_type: "TRACKED_INSTALLATION", target_baseline: CURRENT_SCHEMA,
      current_schema: "0510", schema_evidence_valid: true,
    }, boundedManifestPath);
    const above = runSchemaCheck({
      state_type: "TRACKED_INSTALLATION", target_baseline: CURRENT_SCHEMA,
      current_schema: CURRENT_SCHEMA, schema_evidence_valid: true,
    }, boundedManifestPath);

    expect(below.stderr).toContain("SCHEMA_TOO_OLD_FOR_DIRECT_UPDATE");
    expect(above.stderr).toContain("SCHEMA_NEWER_THAN_RELEASE");
  });

  it("rejects tampered compatibility fields before using them", async () => {
    const manifest = signManifest(structuredClone(fixturePayload));
    const variants = [
      { ...manifest, payload: { ...manifest.payload, min_installer_version: "not-semver" } },
      { ...manifest, payload: { ...manifest.payload, compatibility: { ...manifest.payload.compatibility, min_schema: "0509" } } },
    ];

    for (const [index, altered] of variants.entries()) {
      const alteredPath = await writeManifest(`compatibility-tamper-${index}.json`, altered);
      const result = runVerify(alteredPath);
      expect(result.stderr).toContain("MANIFEST_SIGNATURE_INVALID");
    }
  });

  it("rejects a signed test manifest after its payload is changed", async () => {
    const manifest = signManifest(structuredClone(fixturePayload));
    manifest.payload.images.app.tag = "tampered";
    const alteredPath = await writeManifest("payload-tamper.json", manifest);
    const result = runVerify(alteredPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MANIFEST_SIGNATURE_INVALID");
  });

  it("rejects a signature when its key ID resolves to a different public key", async () => {
    const otherTrustRoot = path.join(tempDir, "wrong-key-trust");
    await fs.mkdir(otherTrustRoot);
    const wrongKeyPair = generateKeyPairSync("ed25519");
    await fs.writeFile(
      path.join(otherTrustRoot, `${TEST_KEY_ID}.pem`),
      wrongKeyPair.publicKey.export({ type: "spki", format: "pem" }),
    );
    const result = runVerify(fixtureManifestPath, otherTrustRoot);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MANIFEST_SIGNATURE_INVALID");
  });

  it("blocks a well-shaped signed manifest when no trusted public key is installed", async () => {
    const emptyTrustRoot = path.join(tempDir, "empty-trust");
    await fs.mkdir(emptyTrustRoot);
    const result = runVerify(fixtureManifestPath, emptyTrustRoot);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("MANIFEST_KEY_UNTRUSTED");
  });

  it("denies missing, malformed, and invalid signatures", async () => {
    const valid = signManifest(fixturePayload);
    const cases = [
      { name: "missing-signature.json", manifest: { ...valid, signature: undefined }, reason: "MANIFEST_SIGNATURE_MISSING_OR_MALFORMED" },
      { name: "malformed-signature.json", manifest: { ...valid, signature: "not-a-signature" }, reason: "MANIFEST_SIGNATURE_MISSING_OR_MALFORMED" },
      { name: "invalid-signature.json", manifest: { ...valid, signature: "A".repeat(86) }, reason: "MANIFEST_SIGNATURE_INVALID" },
    ];

    for (const testCase of cases) {
      const manifestPath = await writeManifest(testCase.name, testCase.manifest);
      const result = runVerify(manifestPath);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(testCase.reason);
    }
  });
});
