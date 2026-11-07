import { describe, it, expect, beforeEach } from "vitest";
import crypto from "crypto";
import { DistributionService } from "../src/distribution-service";
import { LocalReleaseManifestSigner } from "../src/manifest-signer";
import { LocalFakeDistributionProvider, MemoryGrantStore } from "../src/distribution-provider";
import { MemoryRateLimiter } from "../src/rate-limiter";
import { verifyOfflineBundle } from "../src/offline-verifier";
import type { DatabaseClient } from "../scripts/migrator";
import {
  generateInstallationKeyPair,
  createInstallationRequestSignature,
  MemoryNonceStore,
} from "@/lib/licensing/installation-auth";
import type { ReleaseMetadata } from "../src/distribution-types";

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
        actor: params[4],
      });
      return { rows: [] };
    }

    return { rows: [] };
  }
}

describe("L8.1G Distribution Engine & Artifact Gateway Lifecycle", () => {
  let db: InProcessDatabaseClient;
  let manifestSignerKeyPair: { publicKeyPem: string; privateKeyPem: string };
  let manifestKeyId: string;
  let manifestSigner: LocalReleaseManifestSigner;
  let provider: LocalFakeDistributionProvider;
  let grantStore: MemoryGrantStore;
  let nonceStore: MemoryNonceStore;
  let rateLimiter: MemoryRateLimiter;
  let service: DistributionService;

  let testLicenseId: string;
  let testInstId: string;
  let testInstKeyPair: { publicKeyPem: string; privateKeyPem: string };
  let testReleaseStable: ReleaseMetadata;
  let testReleaseSecurity: ReleaseMetadata;
  let testReleaseCandidate: ReleaseMetadata;
  let sampleAmd64Payload: Buffer;
  let sampleArm64Payload: Buffer;

  beforeEach(() => {
    db = new InProcessDatabaseClient();
    manifestKeyId = "manifest_vendor_key_2026";
    manifestSignerKeyPair = generateInstallationKeyPair();
    manifestSigner = new LocalReleaseManifestSigner(
      manifestKeyId,
      manifestSignerKeyPair.privateKeyPem,
    );
    provider = new LocalFakeDistributionProvider(manifestSigner);
    grantStore = new MemoryGrantStore();
    nonceStore = new MemoryNonceStore();
    rateLimiter = new MemoryRateLimiter();

    service = new DistributionService({
      db,
      provider,
      grantStore,
      nonceStore,
      rateLimiter,
      tokenTtlSeconds: 900,
    });

    testLicenseId = "lic_123e4567-e89b-42d3-a456-426614174000";
    testInstId = "inst_123e4567-e89b-42d3-a456-426614174000";
    testInstKeyPair = generateInstallationKeyPair();

    // Default ACTIVE valid license
    db.licenses.set(testLicenseId, {
      id: testLicenseId,
      status: "ACTIVE",
      valid_from: "2026-10-01T00:00:00Z",
      expires_at: "2027-10-01T00:00:00Z",
      maintenance_until: "2027-10-01T00:00:00Z",
      grace_days: 7,
    });

    // Default ACTIVE installation
    db.installations.set(testInstId, {
      id: testInstId,
      license_id: testLicenseId,
      public_key: testInstKeyPair.publicKeyPem,
      status: "ACTIVE",
    });

    // Create binary payloads
    sampleAmd64Payload = Buffer.from("CLIENTIX_DOCKER_IMAGE_AMD64_COMPILED_BINARY_CONTENT");
    sampleArm64Payload = Buffer.from("CLIENTIX_DOCKER_IMAGE_ARM64_COMPILED_BINARY_CONTENT");

    const digestAmd64 =
      `sha256:${crypto.createHash("sha256").update(sampleAmd64Payload).digest("hex")}` as const;
    const digestArm64 =
      `sha256:${crypto.createHash("sha256").update(sampleArm64Payload).digest("hex")}` as const;

    testReleaseStable = {
      releaseId: "rel_stable_2026.10.1",
      version: "2026.10.1",
      channel: "stable",
      status: "PUBLISHED",
      publishedAt: "2026-10-05T00:00:00Z",
      minSchemaVersion: "0500",
      maxSchemaVersion: "0520",
      requiredMaintenanceDate: "2026-10-01T00:00:00Z",
      artifacts: [
        {
          artifactId: "art_amd64_stable",
          releaseId: "rel_stable_2026.10.1",
          architecture: "amd64",
          artifactType: "oci-bundle",
          digest: digestAmd64,
          sizeBytes: sampleAmd64Payload.length,
          filename: "clientix-app-amd64.tar",
          createdAt: "2026-10-05T00:00:00Z",
        },
        {
          artifactId: "art_arm64_stable",
          releaseId: "rel_stable_2026.10.1",
          architecture: "arm64",
          artifactType: "oci-bundle",
          digest: digestArm64,
          sizeBytes: sampleArm64Payload.length,
          filename: "clientix-app-arm64.tar",
          createdAt: "2026-10-05T00:00:00Z",
        },
      ],
    };

    testReleaseSecurity = {
      releaseId: "rel_sec_2026.10.1-sec1",
      version: "2026.10.1-sec1",
      channel: "security",
      status: "PUBLISHED",
      publishedAt: "2026-10-06T00:00:00Z",
      minSchemaVersion: "0500",
      artifacts: [
        {
          artifactId: "art_amd64_sec",
          releaseId: "rel_sec_2026.10.1-sec1",
          architecture: "amd64",
          artifactType: "oci-bundle",
          digest: digestAmd64,
          sizeBytes: sampleAmd64Payload.length,
          filename: "clientix-app-sec-amd64.tar",
          createdAt: "2026-10-06T00:00:00Z",
        },
      ],
    };

    testReleaseCandidate = {
      releaseId: "rel_rc_2026.11.0-rc1",
      version: "2026.11.0-rc1",
      channel: "candidate",
      status: "PUBLISHED",
      publishedAt: "2026-10-07T00:00:00Z",
      minSchemaVersion: "0500",
      artifacts: [
        {
          artifactId: "art_amd64_rc",
          releaseId: "rel_rc_2026.11.0-rc1",
          architecture: "amd64",
          artifactType: "oci-bundle",
          digest: digestAmd64,
          sizeBytes: sampleAmd64Payload.length,
          filename: "clientix-app-rc-amd64.tar",
          createdAt: "2026-10-07T00:00:00Z",
        },
      ],
    };

    provider.addRelease(testReleaseStable, {
      art_amd64_stable: sampleAmd64Payload,
      art_arm64_stable: sampleArm64Payload,
    });

    provider.addRelease(testReleaseSecurity, {
      art_amd64_sec: sampleAmd64Payload,
    });

    provider.addRelease(testReleaseCandidate, {
      art_amd64_rc: sampleAmd64Payload,
    });
  });

  const createPoPTokenRequest = (params: {
    instId: string;
    keyPair: { privateKeyPem: string };
    releaseId: string;
    arch: "amd64" | "arm64";
    schema?: string;
    nowSec?: number;
    nonce?: string;
  }) => {
    const now = params.nowSec ?? Math.floor(Date.now() / 1000);
    const nonce = params.nonce ?? crypto.randomBytes(16).toString("hex");
    const bodyObj: Record<string, unknown> = {
      installation_id: params.instId,
      release_id: params.releaseId,
      architecture: params.arch,
      timestamp: now,
      nonce,
    };
    if (params.schema) bodyObj.client_schema_version = params.schema;
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
      client_schema_version: params.schema,
      timestamp: now,
      nonce,
      rawBody,
      signatureBase64url: sig,
    };
  };

  describe("1. Entitlement Policy & Grant Issuance", () => {
    it("allows VALID license and ACTIVE installation to obtain token for entitled release", async () => {
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
      });

      const res = await service.issueDistributionToken(req);
      expect(res.ok).toBe(true);
      expect(res.data?.distribution_token).toMatch(/^cdt_[A-Za-z0-9_-]+/);
      expect(res.data?.architecture).toBe("amd64");
      expect(res.data?.expires_in).toBe(900);
    });

    it("enforces GRACE policy strictly: ALLOWS security release, DENIES stable and candidate", async () => {
      // Set license into GRACE state (expired 3 days ago, grace period 7 days)
      const now = new Date("2026-10-10T12:00:00Z");
      const serviceGrace = new DistributionService({
        db,
        provider,
        grantStore,
        nonceStore: new MemoryNonceStore(),
        rateLimiter,
        clockNow: () => now,
      });

      db.licenses.set(testLicenseId, {
        id: testLicenseId,
        status: "ACTIVE",
        valid_from: "2025-10-01T00:00:00Z",
        expires_at: "2026-10-07T00:00:00Z", // Expired 3 days ago
        maintenance_until: "2027-10-01T00:00:00Z",
        grace_days: 7,
      });

      const nowSec = Math.floor(now.getTime() / 1000);

      // 1. Security release in GRACE -> ALLOW
      const reqSec = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseSecurity.releaseId,
        arch: "amd64",
        nowSec,
      });
      const resSec = await serviceGrace.issueDistributionToken(reqSec);
      expect(resSec.ok).toBe(true);

      // 2. Stable release in GRACE -> DENY
      const reqStable = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
        nowSec,
      });
      const resStable = await serviceGrace.issueDistributionToken(reqStable);
      expect(resStable.ok).toBe(false);
      expect(resStable.error?.code).toBe("RELEASE_NOT_ENTITLED");

      // 3. Candidate release in GRACE -> DENY
      const reqRc = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseCandidate.releaseId,
        arch: "amd64",
        nowSec,
      });
      const resRc = await serviceGrace.issueDistributionToken(reqRc);
      expect(resRc.ok).toBe(false);
      expect(resRc.error?.code).toBe("RELEASE_NOT_ENTITLED");
    });

    it("denies token issuance when license is EXPIRED past grace period", async () => {
      const now = new Date("2026-10-20T12:00:00Z");
      const serviceExpired = new DistributionService({
        db,
        provider,
        grantStore,
        nonceStore: new MemoryNonceStore(),
        rateLimiter,
        clockNow: () => now,
      });

      db.licenses.set(testLicenseId, {
        id: testLicenseId,
        status: "ACTIVE",
        valid_from: "2025-10-01T00:00:00Z",
        expires_at: "2026-10-01T00:00:00Z", // Expired 19 days ago (past 7 grace days)
        grace_days: 7,
      });

      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
        nowSec: Math.floor(now.getTime() / 1000),
      });

      const res = await serviceExpired.issueDistributionToken(req);
      expect(res.ok).toBe(false);
      expect(res.error?.code).toBe("DISTRIBUTION_NOT_ALLOWED");
      expect(res.error?.message).toContain("EXPIRED");
    });

    it("denies token issuance when license or installation is SUSPENDED or REVOKED", async () => {
      // 1. License SUSPENDED
      db.licenses.set(testLicenseId, {
        id: testLicenseId,
        status: "SUSPENDED",
        valid_from: "2026-01-01T00:00:00Z",
        expires_at: "2027-01-01T00:00:00Z",
      });
      const req1 = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
      });
      const res1 = await service.issueDistributionToken(req1);
      expect(res1.ok).toBe(false);
      expect(res1.error?.code).toBe("DISTRIBUTION_NOT_ALLOWED");

      // 2. License REVOKED
      db.licenses.set(testLicenseId, {
        id: testLicenseId,
        status: "REVOKED",
        valid_from: "2026-01-01T00:00:00Z",
        expires_at: "2027-01-01T00:00:00Z",
      });
      const req2 = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
      });
      const res2 = await service.issueDistributionToken(req2);
      expect(res2.ok).toBe(false);
      expect(res2.error?.code).toBe("DISTRIBUTION_NOT_ALLOWED");

      // 3. Installation REVOKED
      db.licenses.set(testLicenseId, {
        id: testLicenseId,
        status: "ACTIVE",
        valid_from: "2026-01-01T00:00:00Z",
        expires_at: "2027-01-01T00:00:00Z",
      });
      db.installations.set(testInstId, {
        id: testInstId,
        license_id: testLicenseId,
        public_key: testInstKeyPair.publicKeyPem,
        status: "REVOKED",
      });
      const req3 = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
      });
      const res3 = await service.issueDistributionToken(req3);
      expect(res3.ok).toBe(false);
      expect(res3.error?.code).toBe("DISTRIBUTION_NOT_ALLOWED");
    });

    it("denies token issuance for RETRACTED release or incompatible schema", async () => {
      // 1. Retracted release
      const retractedRelease: ReleaseMetadata = {
        ...testReleaseStable,
        releaseId: "rel_retracted_001",
        status: "RETRACTED",
      };
      provider.addRelease(retractedRelease, {});

      const reqRetracted = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: "rel_retracted_001",
        arch: "amd64",
      });
      const resRetracted = await service.issueDistributionToken(reqRetracted);
      expect(resRetracted.ok).toBe(false);
      expect(resRetracted.error?.code).toBe("RELEASE_RETRACTED");

      // 2. Incompatible schema: minSchema = "0500", client reports "0480"
      const reqSchemaLow = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
        schema: "0480",
      });
      const resSchemaLow = await service.issueDistributionToken(reqSchemaLow);
      expect(resSchemaLow.ok).toBe(false);
      expect(resSchemaLow.error?.code).toBe("SCHEMA_INCOMPATIBLE");
    });
  });

  describe("2. Artifact Gateway & Token Validation", () => {
    it("serves manifest and downloads artifact stream with valid token within TTL", async () => {
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
      });
      const tokenRes = await service.issueDistributionToken(req);
      expect(tokenRes.ok).toBe(true);
      const token = tokenRes.data!.distribution_token;

      // 1. Fetch manifest
      const manRes = await service.getReleaseManifest(testReleaseStable.releaseId, token);
      expect(manRes.ok).toBe(true);
      expect(manRes.data?.payload.version).toBe("2026.10.1");

      // 2. Download artifact
      const dlRes = await service.downloadArtifact("art_amd64_stable", token);
      expect(dlRes.ok).toBe(true);
      expect(dlRes.data?.metadata.digest).toBe(testReleaseStable.artifacts[0]!.digest);
      expect(dlRes.data?.stream.toString()).toBe(sampleAmd64Payload.toString());
    });

    it("enforces Token TTL: allows before expiration, denies at/after expiration", async () => {
      let currentTime = new Date("2026-10-08T12:00:00Z");
      const timeService = new DistributionService({
        db,
        provider,
        grantStore,
        nonceStore: new MemoryNonceStore(),
        rateLimiter,
        clockNow: () => currentTime,
        tokenTtlSeconds: 900, // 15 mins
      });

      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
        nowSec: Math.floor(currentTime.getTime() / 1000),
      });

      const tokenRes = await timeService.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;

      // 14 minutes later -> ALLOW
      currentTime = new Date("2026-10-08T12:14:00Z");
      const resBeforeExp = await timeService.downloadArtifact("art_amd64_stable", token);
      expect(resBeforeExp.ok).toBe(true);

      // 16 minutes later -> DENY TOKEN_EXPIRED
      currentTime = new Date("2026-10-08T12:16:00Z");
      const resAfterExp = await timeService.downloadArtifact("art_amd64_stable", token);
      expect(resAfterExp.ok).toBe(false);
      expect(resAfterExp.error?.code).toBe("TOKEN_EXPIRED");
    });

    it("enforces Token Scope strictly: architecture mismatch, release mismatch, and unlisted artifacts", async () => {
      // Token scoped for amd64
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
      });
      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;

      // 1. Attempt to download arm64 artifact -> DENY TOKEN_SCOPE_MISMATCH
      const resArm64 = await service.downloadArtifact("art_arm64_stable", token);
      expect(resArm64.ok).toBe(false);
      expect(resArm64.error?.code).toBe("TOKEN_SCOPE_MISMATCH");

      // 2. Attempt to download artifact from another release -> DENY TOKEN_SCOPE_MISMATCH
      const resOther = await service.downloadArtifact("art_amd64_sec", token);
      expect(resOther.ok).toBe(false);
      expect(resOther.error?.code).toBe("TOKEN_SCOPE_MISMATCH");

      // 3. Attempt to fetch manifest for another release -> DENY TOKEN_SCOPE_MISMATCH
      const manOther = await service.getReleaseManifest(testReleaseSecurity.releaseId, token);
      expect(manOther.ok).toBe(false);
      expect(manOther.error?.code).toBe("TOKEN_SCOPE_MISMATCH");
    });

    it("verifies revocation after issuance: revoking license or installation invalidates downloads", async () => {
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
      });
      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;

      // License gets revoked in database AFTER token issuance
      db.licenses.set(testLicenseId, {
        id: testLicenseId,
        status: "REVOKED",
      });

      const resAfterRevoke = await service.downloadArtifact("art_amd64_stable", token);
      expect(resAfterRevoke.ok).toBe(false);
      expect(resAfterRevoke.status).toBe(403);
      expect(resAfterRevoke.error?.code).toBe("DISTRIBUTION_NOT_ALLOWED");
    });

    it("guards against path traversal attacks in artifact identifier", async () => {
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
      });
      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;

      const attempts = [
        "../etc/passwd",
        "..%2f..%2fsecret",
        "../../lib/licensing/crypto.ts",
        "c:\\windows\\system32",
        "sub/folder/file",
      ];

      for (const badPath of attempts) {
        const res = await service.downloadArtifact(badPath, token);
        expect(res.ok).toBe(false);
        expect(res.error?.code).toBe("PATH_TRAVERSAL_DETECTED");
      }
    });

    it("enforces digest integrity on download: corrupt payload returns ARTIFACT_DIGEST_MISMATCH", async () => {
      const corruptedRelease: ReleaseMetadata = {
        releaseId: "rel_corrupted",
        version: "2026.10.9",
        channel: "stable",
        status: "PUBLISHED",
        publishedAt: "2026-10-08T00:00:00Z",
        minSchemaVersion: "0500",
        artifacts: [
          {
            artifactId: "art_corrupt",
            releaseId: "rel_corrupted",
            architecture: "amd64",
            artifactType: "oci-bundle",
            digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
            sizeBytes: 10,
            filename: "corrupt.tar",
            createdAt: "2026-10-08T00:00:00Z",
          },
        ],
      };
      // Register with non-matching payload
      provider.addRelease(corruptedRelease, {
        art_corrupt: Buffer.from("WRONG_PAYLOAD_NOT_MATCHING_ALL_ZEROS_DIGEST"),
      });

      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: "rel_corrupted",
        arch: "amd64",
      });
      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;

      const dlRes = await service.downloadArtifact("art_corrupt", token);
      expect(dlRes.ok).toBe(false);
      expect(dlRes.status).toBe(500);
      expect(dlRes.error?.code).toBe("ARTIFACT_DIGEST_MISMATCH");
    });
  });

  describe("3. Offline Bundle Verification & Secret Hygiene", () => {
    it("validates legitimate offline bundle with signed manifest and digests", async () => {
      const manifest = await manifestSigner.signManifest({
        manifestVersion: 1,
        version: testReleaseStable.version,
        channel: testReleaseStable.channel,
        publishedAt: testReleaseStable.publishedAt,
        minSchemaVersion: testReleaseStable.minSchemaVersion,
        artifacts: testReleaseStable.artifacts,
      });

      const bundle = {
        manifest,
        artifacts: {
          "clientix-app-amd64.tar": sampleAmd64Payload,
          "clientix-app-arm64.tar": sampleArm64Payload,
        },
      };

      const result = verifyOfflineBundle({
        bundle,
        trustedManifestKeys: { [manifestKeyId]: manifestSignerKeyPair.publicKeyPem },
        targetArchitecture: "amd64",
        clientSchemaVersion: "0510",
      });

      expect(result.valid).toBe(true);
    });

    it("rejects offline bundle if manifest signature is tampered or untrusted", async () => {
      const manifest = await manifestSigner.signManifest({
        manifestVersion: 1,
        version: testReleaseStable.version,
        channel: testReleaseStable.channel,
        publishedAt: testReleaseStable.publishedAt,
        minSchemaVersion: testReleaseStable.minSchemaVersion,
        artifacts: testReleaseStable.artifacts,
      });

      // Tamper manifest payload
      const tamperedManifest = {
        ...manifest,
        payload: {
          ...manifest.payload,
          version: "2026.99.99-tampered",
        },
      };

      const bundle = {
        manifest: tamperedManifest,
        artifacts: {
          "clientix-app-amd64.tar": sampleAmd64Payload,
        },
      };

      const result = verifyOfflineBundle({
        bundle,
        trustedManifestKeys: { [manifestKeyId]: manifestSignerKeyPair.publicKeyPem },
        targetArchitecture: "amd64",
      });

      expect(result.valid).toBe(false);
      expect(result.code).toBe("MANIFEST_SIGNATURE_INVALID");
    });

    it("rejects offline bundle if artifact content is modified (digest mismatch)", async () => {
      const manifest = await manifestSigner.signManifest({
        manifestVersion: 1,
        version: testReleaseStable.version,
        channel: testReleaseStable.channel,
        publishedAt: testReleaseStable.publishedAt,
        minSchemaVersion: testReleaseStable.minSchemaVersion,
        artifacts: testReleaseStable.artifacts,
      });

      const tamperedPayload = Buffer.from(sampleAmd64Payload.toString() + "_MODIFIED");
      const bundle = {
        manifest,
        artifacts: {
          "clientix-app-amd64.tar": tamperedPayload,
        },
      };

      const result = verifyOfflineBundle({
        bundle,
        trustedManifestKeys: { [manifestKeyId]: manifestSignerKeyPair.publicKeyPem },
        targetArchitecture: "amd64",
      });

      expect(result.valid).toBe(false);
      expect(result.code).toBe("ARTIFACT_DIGEST_MISMATCH");
    });

    it("verifies secret hygiene: raw distribution token is never persisted in events or state", async () => {
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
      });

      const tokenRes = await service.issueDistributionToken(req);
      const rawToken = tokenRes.data!.distribution_token;

      // Inspect recorded audit events
      const serializedEvents = JSON.stringify(db.events);
      expect(serializedEvents).not.toContain(rawToken);

      const issuedEvent = db.events.find((e) => e.event_type === "DISTRIBUTION_TOKEN_ISSUED");
      expect(issuedEvent).toBeDefined();
      const payload = issuedEvent?.payload as Record<string, unknown> | undefined;
      expect(payload?.grant_id).toBeDefined();
    });

    it("L8.1G.2: handles concurrent downloads on last remaining use race condition atomically", async () => {
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
      });

      const tokenRes = await service.issueDistributionToken(req);
      expect(tokenRes.ok).toBe(true);
      const token = tokenRes.data!.distribution_token;

      // Consume 2 uses sequentially out of 3
      const dl1 = await service.downloadArtifact("art_amd64_stable", token);
      expect(dl1.ok).toBe(true);
      const dl2 = await service.downloadArtifact("art_amd64_stable", token);
      expect(dl2.ok).toBe(true);

      // Now exactly 1 use remains. Fire two concurrent download requests simultaneously.
      const [resA, resB] = await Promise.all([
        service.downloadArtifact("art_amd64_stable", token),
        service.downloadArtifact("art_amd64_stable", token),
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

    it("L8.1G.2: supports grant-specific revocation without affecting other active grants", async () => {
      const req1 = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
      });
      const tokenRes1 = await service.issueDistributionToken(req1);
      expect(tokenRes1.ok).toBe(true);
      const grantId1 = tokenRes1.data!.grant_id;
      const token1 = tokenRes1.data!.distribution_token;

      const req2 = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
      });
      const tokenRes2 = await service.issueDistributionToken(req2);
      expect(tokenRes2.ok).toBe(true);
      const token2 = tokenRes2.data!.distribution_token;

      // Revoke grant 1 explicitly
      await grantStore.revokeGrant(grantId1);

      // Token 1 should be immediately invalid for manifest and download
      const manifestRes1 = await service.getReleaseManifest(testReleaseStable.releaseId, token1);
      expect(manifestRes1.ok).toBe(false);
      expect(manifestRes1.error?.code).toBe("TOKEN_INVALID");

      const dlRes1 = await service.downloadArtifact("art_amd64_stable", token1);
      expect(dlRes1.ok).toBe(false);
      expect(dlRes1.error?.code).toBe("TOKEN_INVALID");

      // Token 2 must remain fully functional
      const manifestRes2 = await service.getReleaseManifest(testReleaseStable.releaseId, token2);
      expect(manifestRes2.ok).toBe(true);

      const dlRes2 = await service.downloadArtifact("art_amd64_stable", token2);
      expect(dlRes2.ok).toBe(true);
    });

    it("L8.1G.2: simulates multi-instance control plane sharing the same grant store", async () => {
      // Instance A issues the token
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: testReleaseStable.releaseId,
        arch: "amd64",
      });
      const tokenRes = await service.issueDistributionToken(req);
      expect(tokenRes.ok).toBe(true);
      const token = tokenRes.data!.distribution_token;

      // Instance B is a separate service instance with same shared grantStore, db, and provider
      const serviceInstanceB = new DistributionService({
        db,
        provider,
        grantStore, // shared store (simulating Redis/Postgres)
        nonceStore: new MemoryNonceStore(),
      });

      // Instance B serves the download seamlessly
      const dlRes = await serviceInstanceB.downloadArtifact("art_amd64_stable", token);
      expect(dlRes.ok).toBe(true);
      expect(dlRes.data?.metadata.artifactId).toBe("art_amd64_stable");
    });

    it("L8.1G.2: defends against post-issuance release retraction", async () => {
      const dynamicRelease: ReleaseMetadata = {
        ...testReleaseStable,
        releaseId: "rel_dynamic_retract",
        artifacts: [
          {
            ...testReleaseStable.artifacts[0]!,
            artifactId: "art_amd64_dynamic_retract",
            releaseId: "rel_dynamic_retract",
          },
        ],
      };
      provider.addRelease(dynamicRelease, {
        art_amd64_dynamic_retract: sampleAmd64Payload,
      });

      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: testInstKeyPair,
        releaseId: "rel_dynamic_retract",
        arch: "amd64",
      });

      const tokenRes = await service.issueDistributionToken(req);
      expect(tokenRes.ok).toBe(true);
      const token = tokenRes.data!.distribution_token;

      // Now release is retracted by vendor
      dynamicRelease.status = "RETRACTED";

      // Download attempt after retraction must be blocked
      const dlRes = await service.downloadArtifact("art_amd64_dynamic_retract", token);
      expect(dlRes.ok).toBe(false);
      expect(dlRes.error?.code).toBe("RELEASE_RETRACTED");
    });
  });
});
