import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import { DistributionService } from "../src/distribution-service";
import { LocalReleaseManifestSigner } from "../src/manifest-signer";
import { LocalFakeDistributionProvider, MemoryGrantStore } from "../src/distribution-provider";
import { RedisGrantStore, validateAndParseGrantPayload } from "../src/redis-grant-store";
import { FakeInMemoryRedisClient } from "../src/fake-redis-client";
import { MemoryRateLimiter } from "../src/rate-limiter";
import type { DatabaseClient } from "../scripts/migrator";
import {
  generateInstallationKeyPair,
  createInstallationRequestSignature,
  MemoryNonceStore,
} from "@/lib/licensing/installation-auth";
import type { ReleaseMetadata, DistributionGrant } from "../src/distribution-types";

interface TestMockLicense {
  id: string;
  status: string;
  valid_from?: string;
  expires_at?: string;
  maintenance_until?: string | null;
  grace_days?: number;
}

interface TestMockInstallation {
  id: string;
  license_id: string;
  public_key: string;
  status: string;
}

class InProcessDatabaseClient implements DatabaseClient {
  public licenses = new Map<string, TestMockLicense>();
  public installations = new Map<string, TestMockInstallation>();
  public events: Record<string, unknown>[] = [];

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount?: number }> {
    const trimmed = sql.trim();

    if (trimmed.includes("from control_plane.licensing_installations where id = $1")) {
      const id = params[0] as string;
      const inst = this.installations.get(id);
      return { rows: inst ? [inst as unknown as R] : [] };
    }

    if (trimmed.includes("from control_plane.licensing_licenses where id = $1")) {
      const id = params[0] as string;
      const lic = this.licenses.get(id);
      return { rows: lic ? [lic as unknown as R] : [] };
    }

    if (trimmed.startsWith("insert into control_plane.licensing_events")) {
      this.events.push({
        license_id: params[0],
        installation_id: params[1],
        event_type: params[2],
        payload: typeof params[3] === "string" ? JSON.parse(params[3]) : params[3],
        created_at: new Date().toISOString(),
      });
      return { rows: [], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }
}

describe("L8.1G.3 Shared Redis Grant Store & Final Closure", () => {
  let db: InProcessDatabaseClient;
  let fakeRedis: FakeInMemoryRedisClient;
  let redisStore: RedisGrantStore;
  let manifestSigner: LocalReleaseManifestSigner;
  let provider: LocalFakeDistributionProvider;
  let rateLimiter: MemoryRateLimiter;
  let nonceStore: MemoryNonceStore;
  let service: DistributionService;

  let testLicenseId: string;
  let testInstId: string;
  let testInstKeyPair: { publicKeyPem: string; privateKeyPem: string };
  let samplePayload: Buffer;
  let testRelease: ReleaseMetadata;

  beforeEach(() => {
    db = new InProcessDatabaseClient();
    fakeRedis = new FakeInMemoryRedisClient();
    redisStore = new RedisGrantStore(fakeRedis);

    const manifestKey = generateInstallationKeyPair();
    manifestSigner = new LocalReleaseManifestSigner("manifest_key_1", manifestKey.privateKeyPem);
    provider = new LocalFakeDistributionProvider(manifestSigner);
    rateLimiter = new MemoryRateLimiter();
    nonceStore = new MemoryNonceStore();

    service = new DistributionService({
      db,
      provider,
      grantStore: redisStore,
      nonceStore,
      rateLimiter,
      tokenTtlSeconds: 900,
    });

    testLicenseId = "lic_123e4567-e89b-42d3-a456-426614174000";
    testInstId = "inst_123e4567-e89b-42d3-a456-426614174000";
    testInstKeyPair = generateInstallationKeyPair();

    db.licenses.set(testLicenseId, {
      id: testLicenseId,
      status: "ACTIVE",
      valid_from: "2026-10-01T00:00:00Z",
      expires_at: "2027-10-01T00:00:00Z",
      grace_days: 7,
    });

    db.installations.set(testInstId, {
      id: testInstId,
      license_id: testLicenseId,
      public_key: testInstKeyPair.publicKeyPem,
      status: "ACTIVE",
    });

    samplePayload = Buffer.from("CLIENTIX_COMPILED_RELEASE_AMD64_BINARY");
    const digest =
      `sha256:${crypto.createHash("sha256").update(samplePayload).digest("hex")}` as const;

    testRelease = {
      releaseId: "rel_redis_2026.10.1",
      version: "2026.10.1",
      channel: "stable",
      status: "PUBLISHED",
      publishedAt: "2026-10-08T00:00:00Z",
      minSchemaVersion: "0500",
      artifacts: [
        {
          artifactId: "art_app_amd64",
          releaseId: "rel_redis_2026.10.1",
          architecture: "amd64",
          artifactType: "oci-bundle",
          digest,
          sizeBytes: samplePayload.length,
          filename: "clientix-app-amd64.tar",
          createdAt: "2026-10-08T00:00:00Z",
        },
        {
          artifactId: "art_app_arm64",
          releaseId: "rel_redis_2026.10.1",
          architecture: "arm64",
          artifactType: "oci-bundle",
          digest,
          sizeBytes: samplePayload.length,
          filename: "clientix-app-arm64.tar",
          createdAt: "2026-10-08T00:00:00Z",
        },
      ],
    };

    provider.addRelease(testRelease, {
      art_app_amd64: samplePayload,
      art_app_arm64: samplePayload,
    });
  });

  const createPoPTokenRequest = (params: {
    instId: string;
    keyPair: { privateKeyPem: string };
    releaseId: string;
    arch: "amd64" | "arm64";
    nowSec?: number;
    nonce?: string;
  }) => {
    const now = params.nowSec ?? Math.floor(Date.now() / 1000);
    const nonce = params.nonce ?? crypto.randomBytes(16).toString("hex");
    const bodyObj = {
      installation_id: params.instId,
      release_id: params.releaseId,
      architecture: params.arch,
      timestamp: now,
      nonce,
    };
    const rawBody = JSON.stringify(bodyObj);

    const sig = createInstallationRequestSignature({
      installationId: params.instId,
      timestamp: now,
      nonce,
      method: "POST",
      path: "/api/v1/licensing/distribution-token",
      body: rawBody,
      privateKeyPem: params.keyPair.privateKeyPem,
    });

    return {
      installation_id: params.instId,
      release_id: params.releaseId,
      architecture: params.arch,
      timestamp: now,
      nonce,
      signatureBase64url: sig,
      rawBody,
    };
  };

  describe("1. Production Fail-Closed & Store Classification", () => {
    const originalEnv = process.env.NODE_ENV;

    afterEach(() => {
      (process.env as Record<string, string | undefined>).NODE_ENV = originalEnv;
    });

    it("verifies MemoryGrantStore is marked TEST_ONLY", () => {
      const memoryStore = new MemoryGrantStore();
      expect(memoryStore.isTestOnly).toBe(true);
    });

    it("fails closed in NODE_ENV=production if MemoryGrantStore is provided", () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";
      const memoryStore = new MemoryGrantStore();

      expect(() => {
        new DistributionService({
          db,
          provider,
          grantStore: memoryStore,
          nonceStore,
          rateLimiter,
        });
      }).toThrow(/MemoryGrantStore cannot be used in production/);
    });

    it("allows RedisGrantStore in NODE_ENV=production", () => {
      (process.env as Record<string, string | undefined>).NODE_ENV = "production";

      expect(() => {
        new DistributionService({
          db,
          provider,
          grantStore: redisStore,
          nonceStore,
          rateLimiter,
        });
      }).not.toThrow();
    });
  });

  describe("2. Redis Key Model, TTL & Secret Sanitization", () => {
    it("creates grant in Redis under canonical key and verifies TTL bounding", async () => {
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testRelease.releaseId,
        arch: "amd64",
      });

      const res = await service.issueDistributionToken(req);
      expect(res.ok).toBe(true);
      const rawToken = res.data!.distribution_token;

      // 1. Raw token is never used as key
      const allKeys = fakeRedis.getAllKeys();
      expect(allKeys.some((k) => k.includes(rawToken))).toBe(false);

      // 2. Key follows namespace: clientix:distribution:grant:<tokenHash>
      const tokenHash = crypto.createHash("sha256").update(rawToken).digest("hex");
      const expectedKey = `clientix:distribution:grant:${tokenHash}`;
      expect(allKeys).toContain(expectedKey);

      // 3. Inspect Redis value: raw token and private keys are never stored
      const rawValue = fakeRedis.inspectKey(expectedKey);
      expect(rawValue).toBeDefined();
      expect(rawValue).not.toContain(rawToken);
      expect(rawValue).not.toContain("PRIVATE KEY");
      expect(rawValue).not.toContain("BEGIN ED25519");

      // 4. Inspect audit events: token is not leaked in database events
      const eventsStr = JSON.stringify(db.events);
      expect(eventsStr).not.toContain(rawToken);
    });

    it("validates and parses grant payload strictly, rejecting malformed JSON (fail-closed)", () => {
      expect(validateAndParseGrantPayload("not-json")).toBeNull();
      expect(validateAndParseGrantPayload(JSON.stringify({ grantId: 123 }))).toBeNull();
      expect(
        validateAndParseGrantPayload(
          JSON.stringify({ grantId: "g1", architecture: "invalid_arch" }),
        ),
      ).toBeNull();
    });
  });

  describe("3. Atomic Consumption, Per-Artifact Counters & Concurrency", () => {
    it("tracks counters independently per artifact (consuming A does not reduce B)", async () => {
      // Create multi-artifact grant
      const claims = {
        grantId: "grant_multi_art",
        installationId: testInstId,
        licenseId: testLicenseId,
        releaseId: testRelease.releaseId,
        architecture: "amd64" as const,
        allowedArtifactIds: ["art_app_amd64", "art_other"],
        expiresAt: Math.floor(Date.now() / 1000) + 900,
        createdAt: Math.floor(Date.now() / 1000),
      };
      const grant: DistributionGrant = {
        grantId: claims.grantId,
        tokenHash: "hash_multi_art",
        claims,
        remainingUses: new Map([
          ["art_app_amd64", 3],
          ["art_other", 3],
        ]),
      };

      await redisStore.createGrant(grant, 900);

      // Consume art_app_amd64 once
      const resA = await redisStore.consumeArtifactUse(
        "hash_multi_art",
        "art_app_amd64",
        Math.floor(Date.now() / 1000),
      );
      expect(resA.allowed).toBe(true);

      const updatedGrant = await redisStore.getGrant("hash_multi_art");
      expect(updatedGrant?.remainingUses.get("art_app_amd64")).toBe(2);
      expect(updatedGrant?.remainingUses.get("art_other")).toBe(3); // untouched
    });

    it("handles last remaining use race condition (remainingUses=1) atomically: 1 ALLOW, 1 ARTIFACT_GRANT_EXHAUSTED", async () => {
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testRelease.releaseId,
        arch: "amd64",
      });

      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;

      // Consume 2 uses sequentially
      const dl1 = await service.downloadArtifact("art_app_amd64", token);
      expect(dl1.ok).toBe(true);
      const dl2 = await service.downloadArtifact("art_app_amd64", token);
      expect(dl2.ok).toBe(true);

      // 1 use remains. Run concurrent download requests.
      const [resA, resB] = await Promise.all([
        service.downloadArtifact("art_app_amd64", token),
        service.downloadArtifact("art_app_amd64", token),
      ]);

      const successCount = (resA.ok ? 1 : 0) + (resB.ok ? 1 : 0);
      const exhaustedCount =
        (!resA.ok && resA.error?.code === "ARTIFACT_GRANT_EXHAUSTED" && resA.status === 403
          ? 1
          : 0) +
        (!resB.ok && resB.error?.code === "ARTIFACT_GRANT_EXHAUSTED" && resB.status === 403
          ? 1
          : 0);

      expect(successCount).toBe(1);
      expect(exhaustedCount).toBe(1);
    });

    it("manifest access validates token but does NOT decrement artifact usage", async () => {
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testRelease.releaseId,
        arch: "amd64",
      });

      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

      // Fetch manifest multiple times
      await service.getReleaseManifest(testRelease.releaseId, token);
      await service.getReleaseManifest(testRelease.releaseId, token);

      const grant = await redisStore.getGrant(tokenHash);
      expect(grant?.remainingUses.get("art_app_amd64")).toBe(3); // Still 3
    });
  });

  describe("4. Multi-Instance & Process Restart Simulation", () => {
    it("shares state across independent DistributionService instances pointing to same backing Redis", async () => {
      // Instance A issues token
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testRelease.releaseId,
        arch: "amd64",
      });
      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;

      // Instance B (separate service instance sharing fakeRedis)
      const serviceB = new DistributionService({
        db,
        provider,
        grantStore: new RedisGrantStore(fakeRedis),
        nonceStore: new MemoryNonceStore(),
      });

      // Instance B consumes 1 use
      const dlResB = await serviceB.downloadArtifact("art_app_amd64", token);
      expect(dlResB.ok).toBe(true);

      // Instance A reads updated usage
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
      const grantOnA = await redisStore.getGrant(tokenHash);
      expect(grantOnA?.remainingUses.get("art_app_amd64")).toBe(2);
    });

    it("simulates service restart: old instance terminates, new instance resumes from Redis backing store", async () => {
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testRelease.releaseId,
        arch: "amd64",
      });
      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;

      // Old service terminates (falls out of scope)
      // New instance boots up
      const rebootedService = new DistributionService({
        db,
        provider,
        grantStore: new RedisGrantStore(fakeRedis),
        nonceStore: new MemoryNonceStore(),
      });

      const dlRes = await rebootedService.downloadArtifact("art_app_amd64", token);
      expect(dlRes.ok).toBe(true);
    });
  });

  describe("5. Revocation & Retraction Semantics", () => {
    it("grant revocation invalidates subsequent reads and downloads immediately", async () => {
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testRelease.releaseId,
        arch: "amd64",
      });
      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;
      const grantId = tokenRes.data!.grant_id;

      // Revoke grant
      await redisStore.revokeGrant(grantId);

      // Download must be rejected
      const dlRes = await service.downloadArtifact("art_app_amd64", token);
      expect(dlRes.ok).toBe(false);
      expect(dlRes.error?.code).toBe("TOKEN_INVALID");
    });

    it("rejects download if license is revoked in DB even if Redis grant key still exists", async () => {
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testRelease.releaseId,
        arch: "amd64",
      });
      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;

      // Revoke license in DB
      db.licenses.set(testLicenseId, {
        id: testLicenseId,
        status: "REVOKED",
      });

      const dlRes = await service.downloadArtifact("art_app_amd64", token);
      expect(dlRes.ok).toBe(false);
      expect(dlRes.error?.code).toBe("DISTRIBUTION_NOT_ALLOWED");
    });

    it("rejects download if release is retracted after grant issuance", async () => {
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testRelease.releaseId,
        arch: "amd64",
      });
      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;

      // Retract release
      testRelease.status = "RETRACTED";

      const dlRes = await service.downloadArtifact("art_app_amd64", token);
      expect(dlRes.ok).toBe(false);
      expect(dlRes.error?.code).toBe("RELEASE_RETRACTED");
    });
  });

  describe("6. Outage Fail-Closed & Download Failure Semantics", () => {
    it("fails closed with DISTRIBUTION_TEMPORARILY_UNAVAILABLE if Redis is down", async () => {
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testRelease.releaseId,
        arch: "amd64",
      });
      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;

      // Simulate Redis Outage
      fakeRedis.shouldFail = true;

      const dlRes = await service.downloadArtifact("art_app_amd64", token);
      expect(dlRes.ok).toBe(false);
      expect(dlRes.status).toBe(503);
      expect(dlRes.error?.code).toBe("DISTRIBUTION_TEMPORARILY_UNAVAILABLE");
    });

    it("reserves attempt count before stream: digest mismatch records failure and attempt remains consumed", async () => {
      // Tamper artifact in provider
      const corruptPayload = Buffer.from("CORRUPT_PAYLOAD_CORRUPT");
      provider.addRelease(testRelease, {
        art_app_amd64: corruptPayload,
      });

      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testRelease.releaseId,
        arch: "amd64",
      });
      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;
      const tokenHash = crypto.createHash("sha256").update(token).digest("hex");

      const dlRes = await service.downloadArtifact("art_app_amd64", token);
      expect(dlRes.ok).toBe(false);
      expect(dlRes.error?.code).toBe("ARTIFACT_DIGEST_MISMATCH");

      // Attempt was consumed (from 3 down to 2) to prevent refund abuse
      const grant = await redisStore.getGrant(tokenHash);
      expect(grant?.remainingUses.get("art_app_amd64")).toBe(2);

      // Audit log records failure
      const failEvent = db.events.find((e) => e.event_type === "ARTIFACT_DOWNLOAD_FAILED");
      expect(failEvent).toBeDefined();
    });
  });
});
