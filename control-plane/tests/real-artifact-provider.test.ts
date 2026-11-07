import { describe, it, expect, beforeEach, afterEach } from "vitest";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import os from "os";
import {
  FilesystemArtifactStorage,
  MemoryArtifactStorage,
  type ArtifactStorageReader,
} from "../src/artifact-storage";
import { RealArtifactProvider } from "../src/real-artifact-provider";
import { LocalReleaseManifestSigner } from "../src/manifest-signer";
import { DistributionService } from "../src/distribution-service";
import { MemoryGrantStore } from "../src/distribution-provider";
import { MemoryRateLimiter } from "../src/rate-limiter";
import { ReleasePublisher } from "../src/release-publisher";
import { InstallerArtifactVerifier } from "../src/installer-verifier";
import {
  generateInstallationKeyPair,
  createInstallationRequestSignature,
  MemoryNonceStore,
} from "@/lib/licensing/installation-auth";
import type { ReleaseMetadata, ArtifactMetadata } from "../src/distribution-types";
import type { DatabaseClient } from "../scripts/migrator";

class MockDatabaseClient implements DatabaseClient {
  public licenses = new Map<
    string,
    {
      id: string;
      status: string;
      valid_from?: string;
      expires_at?: string;
      maintenance_until?: string;
      grace_days?: number;
    }
  >();
  public installations = new Map<
    string,
    { id: string; license_id: string; public_key: string; status: string }
  >();
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
        created_at: new Date().toISOString(),
      });
      return { rows: [], rowCount: 1 };
    }

    return { rows: [] };
  }
}

describe("L9.1 Real Distribution Adapter & Artifact Storage", () => {
  let tmpDir: string;
  let signer: LocalReleaseManifestSigner;
  let installationKeypair: { privateKeyPem: string; publicKeyPem: string };
  let manifestSignerKeyPair: { privateKeyPem: string; publicKeyPem: string };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clientix-dist-test-"));
    manifestSignerKeyPair = generateInstallationKeyPair();
    signer = new LocalReleaseManifestSigner("signer_test_key", manifestSignerKeyPair.privateKeyPem);
    installationKeypair = generateInstallationKeyPair();
  });

  afterEach(() => {
    if (fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  describe("ArtifactStorageBackend Contract", () => {
    it("stores and retrieves objects immutably in memory storage", async () => {
      const storage = new MemoryArtifactStorage();
      const payload = Buffer.from("test container content");

      const meta = await storage.putObject("test/key.tar", payload, "application/x-tar");
      expect(meta.sizeBytes).toBe(payload.length);
      expect(meta.digest).toBe(
        `sha256:${crypto.createHash("sha256").update(payload).digest("hex")}`,
      );

      const exists = await storage.objectExists("test/key.tar");
      expect(exists).toBe(true);

      const retrieved = await storage.getObjectStream("test/key.tar");
      expect(retrieved).toEqual(payload);

      const notFound = await storage.getObjectStream("missing/key.tar");
      expect(notFound).toBeNull();
    });

    it("stores and retrieves objects on filesystem storage and prevents path traversal", async () => {
      const storage = new FilesystemArtifactStorage(tmpDir);
      const payload = Buffer.from("vps binary layer");

      const meta = await storage.putObject("releases/v1/app.tar", payload);
      expect(meta.sizeBytes).toBe(payload.length);

      const retrieved = await storage.getObjectStream("releases/v1/app.tar");
      expect(retrieved).toEqual(payload);

      // Traversal protection
      await expect(storage.getObjectStream("../../../etc/passwd")).rejects.toThrow(
        /Path traversal detected/,
      );
    });
  });

  describe("RealArtifactProvider with DistributionService", () => {
    const releaseId = "rel_v2_prod";
    const appAmd64Content = Buffer.from("OCI_IMAGE_AMD64_PAYLOAD_APP");
    const appArm64Content = Buffer.from("OCI_IMAGE_ARM64_PAYLOAD_APP");
    const workerContent = Buffer.from("OCI_IMAGE_WORKER_PAYLOAD");
    const schedulerContent = Buffer.from("OCI_IMAGE_SCHEDULER_PAYLOAD");
    const voiceContent = Buffer.from("OCI_IMAGE_VOICE_PAYLOAD");
    const migratorContent = Buffer.from("OCI_IMAGE_MIGRATOR_PAYLOAD");

    const appAmd64Digest =
      `sha256:${crypto.createHash("sha256").update(appAmd64Content).digest("hex")}` as `sha256:${string}`;
    const appArm64Digest =
      `sha256:${crypto.createHash("sha256").update(appArm64Content).digest("hex")}` as `sha256:${string}`;
    const workerDigest =
      `sha256:${crypto.createHash("sha256").update(workerContent).digest("hex")}` as `sha256:${string}`;
    const schedulerDigest =
      `sha256:${crypto.createHash("sha256").update(schedulerContent).digest("hex")}` as `sha256:${string}`;
    const voiceDigest =
      `sha256:${crypto.createHash("sha256").update(voiceContent).digest("hex")}` as `sha256:${string}`;
    const migratorDigest =
      `sha256:${crypto.createHash("sha256").update(migratorContent).digest("hex")}` as `sha256:${string}`;

    const artifacts: ArtifactMetadata[] = [
      {
        artifactId: "art_app_amd64",
        releaseId,
        architecture: "amd64",
        artifactType: "oci-image",
        digest: appAmd64Digest,
        sizeBytes: appAmd64Content.length,
        filename: "clientix-app-amd64.tar",
        createdAt: new Date().toISOString(),
      },
      {
        artifactId: "art_app_arm64",
        releaseId,
        architecture: "arm64",
        artifactType: "oci-image",
        digest: appArm64Digest,
        sizeBytes: appArm64Content.length,
        filename: "clientix-app-arm64.tar",
        createdAt: new Date().toISOString(),
      },
      {
        artifactId: "art_worker_amd64",
        releaseId,
        architecture: "amd64",
        artifactType: "oci-image",
        digest: workerDigest,
        sizeBytes: workerContent.length,
        filename: "clientix-worker-amd64.tar",
        createdAt: new Date().toISOString(),
      },
      {
        artifactId: "art_scheduler_amd64",
        releaseId,
        architecture: "amd64",
        artifactType: "oci-image",
        digest: schedulerDigest,
        sizeBytes: schedulerContent.length,
        filename: "clientix-scheduler-amd64.tar",
        createdAt: new Date().toISOString(),
      },
      {
        artifactId: "art_voice_amd64",
        releaseId,
        architecture: "amd64",
        artifactType: "oci-image",
        digest: voiceDigest,
        sizeBytes: voiceContent.length,
        filename: "clientix-voice-amd64.tar",
        createdAt: new Date().toISOString(),
      },
      {
        artifactId: "art_migrator_amd64",
        releaseId,
        architecture: "amd64",
        artifactType: "oci-image",
        digest: migratorDigest,
        sizeBytes: migratorContent.length,
        filename: "clientix-migrator-amd64.tar",
        createdAt: new Date().toISOString(),
      },
    ];

    const releaseMeta: ReleaseMetadata = {
      releaseId,
      version: "2.0.0",
      channel: "stable",
      status: "PUBLISHED",
      publishedAt: new Date().toISOString(),
      minSchemaVersion: "1",
      artifacts,
    };

    let storage: FilesystemArtifactStorage;
    let provider: RealArtifactProvider;
    let service: DistributionService;
    let db: MockDatabaseClient;
    let grantStore: MemoryGrantStore;
    let nonceStore: MemoryNonceStore;

    const testLicenseId = "lic_123e4567-e89b-42d3-a456-426614174000";
    const testInstId = "inst_123e4567-e89b-42d3-a456-426614174000";

    beforeEach(async () => {
      storage = new FilesystemArtifactStorage(tmpDir);
      provider = new RealArtifactProvider({
        storage,
        manifestSigner: signer,
      });

      // Populate storage with immutable keys
      await storage.putObject(
        provider.buildStorageKey(releaseId, "art_app_amd64", appAmd64Digest),
        appAmd64Content,
      );
      await storage.putObject(
        provider.buildStorageKey(releaseId, "art_app_arm64", appArm64Digest),
        appArm64Content,
      );
      await storage.putObject(
        provider.buildStorageKey(releaseId, "art_worker_amd64", workerDigest),
        workerContent,
      );
      await storage.putObject(
        provider.buildStorageKey(releaseId, "art_scheduler_amd64", schedulerDigest),
        schedulerContent,
      );
      await storage.putObject(
        provider.buildStorageKey(releaseId, "art_voice_amd64", voiceDigest),
        voiceContent,
      );
      await storage.putObject(
        provider.buildStorageKey(releaseId, "art_migrator_amd64", migratorDigest),
        migratorContent,
      );

      provider.registerRelease(releaseMeta);

      db = new MockDatabaseClient();
      db.licenses.set(testLicenseId, {
        id: testLicenseId,
        status: "ACTIVE",
        valid_from: "2026-10-01T00:00:00Z",
        expires_at: "2027-10-01T00:00:00Z",
        maintenance_until: "2027-10-01T00:00:00Z",
        grace_days: 7,
      });
      db.installations.set(testInstId, {
        id: testInstId,
        license_id: testLicenseId,
        public_key: installationKeypair.publicKeyPem,
        status: "ACTIVE",
      });

      grantStore = new MemoryGrantStore();
      nonceStore = new MemoryNonceStore();

      service = new DistributionService({
        db,
        provider,
        grantStore,
        nonceStore,
        rateLimiter: new MemoryRateLimiter(),
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

    it("executes full end-to-end local update download with RealArtifactProvider", async () => {
      // 1. Request distribution token with PoP signature
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: installationKeypair,
        releaseId,
        arch: "amd64",
      });

      const tokenRes = await service.issueDistributionToken(req);

      expect(tokenRes.ok).toBe(true);
      expect(tokenRes.data?.distribution_token).toBeDefined();

      const token = tokenRes.data!.distribution_token;

      // 2. Fetch signed manifest
      const manifestRes = await service.getReleaseManifest(releaseId, token);
      expect(manifestRes.ok).toBe(true);
      expect(manifestRes.data?.payload.version).toBe("2.0.0");
      expect(manifestRes.data?.payload.artifacts.length).toBe(6);

      // 3. Download artifact through RealArtifactProvider
      const downloadRes = await service.downloadArtifact("art_app_amd64", token);
      expect(downloadRes.ok).toBe(true);
      expect(downloadRes.data?.stream).toEqual(appAmd64Content);
      expect(downloadRes.data?.metadata.digest).toBe(appAmd64Digest);

      // 4. Verify download event logged
      const downloadEvent = db.events.find((e) => e.event_type === "ARTIFACT_DOWNLOAD_COMPLETED");
      expect(downloadEvent).toBeDefined();
    });

    it("DENIES download when artifact is requested for the wrong architecture", async () => {
      // Token requested for amd64
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: installationKeypair,
        releaseId,
        arch: "amd64",
      });

      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;

      // Attempting to download arm64 artifact with amd64 grant
      const downloadRes = await service.downloadArtifact("art_app_arm64", token);
      expect(downloadRes.ok).toBe(false);
      expect(downloadRes.error?.code).toBe("TOKEN_SCOPE_MISMATCH");
    });

    it("FAILS when underlying storage data is corrupted (Digest Mismatch)", async () => {
      // Corrupt the storage file directly at rest
      const key = provider.buildStorageKey(releaseId, "art_app_amd64", appAmd64Digest);
      const filePath = path.resolve(tmpDir, key);
      await fs.promises.writeFile(filePath, Buffer.from("TAMPERED_CONTENT_MALICIOUS"));

      // Request token
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: installationKeypair,
        releaseId,
        arch: "amd64",
      });

      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;

      // Provider throws digest error or service detects digest mismatch
      await expect(service.downloadArtifact("art_app_amd64", token)).rejects.toThrow(
        /Artifact Storage Corruption: Digest mismatch/,
      );
    });

    it("DENIES download when storage artifact is missing (Storage Outage)", async () => {
      // Delete object from storage
      const key = provider.buildStorageKey(releaseId, "art_worker_amd64", workerDigest);
      await storage.deleteObject(key);

      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: installationKeypair,
        releaseId,
        arch: "amd64",
      });

      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;
      const downloadRes = await service.downloadArtifact("art_worker_amd64", token);
      expect(downloadRes.ok).toBe(false);
      expect(downloadRes.error?.code).toBe("ARTIFACT_NOT_FOUND");
    });

    it("DENIES download when license is revoked", async () => {
      db.licenses.set(testLicenseId, { id: testLicenseId, status: "REVOKED" });

      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: installationKeypair,
        releaseId,
        arch: "amd64",
      });

      const tokenRes = await service.issueDistributionToken(req);
      expect(tokenRes.ok).toBe(false);
      expect(tokenRes.error?.code).toBe("DISTRIBUTION_NOT_ALLOWED");
    });

    it("DENIES download when grant quota is exhausted", async () => {
      const req = createPoPTokenRequest({
        instId: testInstId,
        keyPair: installationKeypair,
        releaseId,
        arch: "amd64",
      });

      const tokenRes = await service.issueDistributionToken(req);
      const token = tokenRes.data!.distribution_token;

      // Exhaust uses (default max uses = 3)
      const d1 = await service.downloadArtifact("art_app_amd64", token);
      expect(d1.ok).toBe(true);
      const d2 = await service.downloadArtifact("art_app_amd64", token);
      expect(d2.ok).toBe(true);
      const d3 = await service.downloadArtifact("art_app_amd64", token);
      expect(d3.ok).toBe(true);

      const d4 = await service.downloadArtifact("art_app_amd64", token);
      expect(d4.ok).toBe(false);
      expect(d4.error?.code).toBe("ARTIFACT_GRANT_EXHAUSTED");
    });
  });

  describe("L9.1.1 Release Catalog & Read-Only Gateway Closure", () => {
    it("publishes a complete 5-artifact release via ReleasePublisher and loads it through read-only gateway", async () => {
      const storage = new FilesystemArtifactStorage(tmpDir);
      const publisher = new ReleasePublisher(storage, signer);

      const appPayload = Buffer.from("PROD_BINARY_APP_LAYER");
      const workerPayload = Buffer.from("PROD_BINARY_WORKER_LAYER");
      const schedulerPayload = Buffer.from("PROD_BINARY_SCHEDULER_LAYER");
      const voicePayload = Buffer.from("PROD_BINARY_VOICE_LAYER");
      const migratorPayload = Buffer.from("PROD_BINARY_MIGRATOR_LAYER");

      const pubResult = await publisher.publishRelease({
        releaseId: "rel_2026_full",
        version: "2026.12.0",
        channel: "stable",
        minSchemaVersion: "1",
        artifacts: [
          {
            artifactId: "art_app",
            architecture: "amd64",
            artifactType: "oci-image",
            filename: "clientix-app.tar",
            data: appPayload,
          },
          {
            artifactId: "art_worker",
            architecture: "amd64",
            artifactType: "oci-image",
            filename: "clientix-worker.tar",
            data: workerPayload,
          },
          {
            artifactId: "art_scheduler",
            architecture: "amd64",
            artifactType: "oci-image",
            filename: "clientix-scheduler.tar",
            data: schedulerPayload,
          },
          {
            artifactId: "art_voice",
            architecture: "amd64",
            artifactType: "oci-image",
            filename: "clientix-voice.tar",
            data: voicePayload,
          },
          {
            artifactId: "art_migrator",
            architecture: "amd64",
            artifactType: "oci-image",
            filename: "clientix-migrator.tar",
            data: migratorPayload,
          },
        ],
      });

      expect(pubResult.artifacts.length).toBe(5);
      expect(pubResult.manifest.payload.artifacts.length).toBe(5);
      expect(pubResult.manifest.payload.version).toBe("2026.12.0");

      // Verify Object Storage files
      const manifestFileExists = await storage.objectExists("releases/rel_2026_full/manifest.json");
      expect(manifestFileExists).toBe(true);

      const indexFileExists = await storage.objectExists("releases/index.json");
      expect(indexFileExists).toBe(true);

      // Now create a STRICTLY READ-ONLY Gateway (Reader interface only)
      const readerOnlyStorage: ArtifactStorageReader = {
        getObjectMetadata: (k) => storage.getObjectMetadata(k),
        getObjectStream: (k) => storage.getObjectStream(k),
        objectExists: (k) => storage.objectExists(k),
      };

      const gateway = new RealArtifactProvider({
        storage: readerOnlyStorage,
      });

      // Verify Gateway reads release directly from storage (source of truth)
      const loadedRelease = await gateway.getRelease("rel_2026_full");
      expect(loadedRelease).not.toBeNull();
      expect(loadedRelease?.version).toBe("2026.12.0");
      expect(loadedRelease?.status).toBe("PUBLISHED");
      expect(loadedRelease?.artifacts.length).toBe(5);

      // Verify Gateway reads signed manifest directly from storage
      const loadedManifest = await gateway.getManifest("rel_2026_full");
      expect(loadedManifest).not.toBeNull();
      expect(loadedManifest?.payload.version).toBe("2026.12.0");
      expect(loadedManifest?.signature).toBeDefined();

      // Verify Gateway streams artifact
      const stream = await gateway.readArtifactStream("art_app");
      expect(stream).toEqual(appPayload);
    });

    it("enforces immutability: rejects overwriting existing object key with different content", async () => {
      const storage = new FilesystemArtifactStorage(tmpDir);
      const initialPayload = Buffer.from("IMMUTABLE_ORIGINAL_BYTES");
      const key = "releases/rel_test/art_1/sha256abc";

      // 1. First upload succeeds
      const meta1 = await storage.putObject(key, initialPayload);
      expect(meta1.sizeBytes).toBe(initialPayload.length);

      // 2. Exact same bytes is idempotent
      const meta2 = await storage.putObject(key, initialPayload);
      expect(meta2.digest).toBe(meta1.digest);

      // 3. Different bytes -> DENY (IMMUTABLE_OBJECT_CONFLICT)
      const tamperedPayload = Buffer.from("TAMPERED_MALICIOUS_BYTES");
      await expect(storage.putObject(key, tamperedPayload)).rejects.toThrow(
        /IMMUTABLE_OBJECT_CONFLICT/,
      );
    });

    it("enforces partial release safety: if artifact upload fails, manifest is not published and release is unavailable", async () => {
      const memStorage = new MemoryArtifactStorage();
      let uploadCount = 0;

      // Wrap storage publisher to throw on 3rd upload
      const failingPublisher = {
        getObjectMetadata: (k: string) => memStorage.getObjectMetadata(k),
        getObjectStream: (k: string) => memStorage.getObjectStream(k),
        objectExists: (k: string) => memStorage.objectExists(k),
        putObject: async (k: string, d: Buffer, c?: string) => {
          uploadCount++;
          if (uploadCount === 3) {
            throw new Error("Simulated storage write error on 3rd artifact");
          }
          return memStorage.putObject(k, d, c);
        },
      };

      const publisher = new ReleasePublisher(failingPublisher, signer);

      await expect(
        publisher.publishRelease({
          releaseId: "rel_broken",
          version: "2026.13.0",
          channel: "stable",
          minSchemaVersion: "1",
          artifacts: [
            {
              artifactId: "a1",
              architecture: "amd64",
              artifactType: "oci-image",
              filename: "a1.tar",
              data: Buffer.from("1"),
            },
            {
              artifactId: "a2",
              architecture: "amd64",
              artifactType: "oci-image",
              filename: "a2.tar",
              data: Buffer.from("2"),
            },
            {
              artifactId: "a3",
              architecture: "amd64",
              artifactType: "oci-image",
              filename: "a3.tar",
              data: Buffer.from("3"),
            },
            {
              artifactId: "a4",
              architecture: "amd64",
              artifactType: "oci-image",
              filename: "a4.tar",
              data: Buffer.from("4"),
            },
          ],
        }),
      ).rejects.toThrow(/Simulated storage write error/);

      // Verify manifest was NEVER written
      const manifestExists = await memStorage.objectExists("releases/rel_broken/manifest.json");
      expect(manifestExists).toBe(false);

      // Gateway cannot find release
      const gateway = new RealArtifactProvider({ storage: memStorage });
      const release = await gateway.getRelease("rel_broken");
      expect(release).toBeNull();
    });

    it("guarantees gateway least privilege: gateway interface and instance has zero write/delete capability", () => {
      const storage = new MemoryArtifactStorage();
      const gateway = new RealArtifactProvider({ storage });

      // Runtime check: gateway possesses no write/delete methods
      expect((gateway as unknown as Record<string, unknown>).putObject).toBeUndefined();
      expect((gateway as unknown as Record<string, unknown>).deleteObject).toBeUndefined();
      expect((gateway as unknown as Record<string, unknown>).saveGrant).toBeUndefined();

      // Gateway only satisfies DistributionProvider
      expect(typeof gateway.getRelease).toBe("function");
      expect(typeof gateway.getManifest).toBe("function");
      expect(typeof gateway.getArtifactMetadata).toBe("function");
      expect(typeof gateway.readArtifactStream).toBe("function");
    });

    it("enforces installer verification: promotes valid temp artifact, rejects and unlinks tampered artifact", async () => {
      const validPayload = Buffer.from("VALID_DISTRIBUTION_PACKAGE_BINARY");
      const validDigest =
        `sha256:${crypto.createHash("sha256").update(validPayload).digest("hex")}` as `sha256:${string}`;

      const tempFileValid = path.join(tmpDir, "installer_test_valid.tmp.part");
      const targetFileValid = path.join(tmpDir, "installed_target_valid.tar");
      await fs.promises.writeFile(tempFileValid, validPayload);

      // 1. Valid download succeeds
      const resValid = await InstallerArtifactVerifier.verifyAndPromote({
        tempFilePath: tempFileValid,
        targetFilePath: targetFileValid,
        expectedSizeBytes: validPayload.length,
        expectedDigest: validDigest,
      });

      expect(resValid.ok).toBe(true);
      expect(resValid.installedPath).toBe(targetFileValid);
      expect(fs.existsSync(targetFileValid)).toBe(true);
      expect(fs.existsSync(tempFileValid)).toBe(false); // Cleaned up via promote

      // 2. Tampered content fails verification and cleans up temp file
      const tamperedPayload = Buffer.from("TAMPERED_BYTES");
      const tempFileTampered = path.join(tmpDir, "installer_test_tampered.tmp.part");
      const targetFileTampered = path.join(tmpDir, "installed_target_tampered.tar");
      await fs.promises.writeFile(tempFileTampered, tamperedPayload);

      const resTampered = await InstallerArtifactVerifier.verifyAndPromote({
        tempFilePath: tempFileTampered,
        targetFilePath: targetFileTampered,
        expectedSizeBytes: tamperedPayload.length,
        expectedDigest: validDigest, // Expecting valid, but actual is tampered
      });

      expect(resTampered.ok).toBe(false);
      expect(resTampered.code).toBe("DIGEST_MISMATCH");
      expect(fs.existsSync(tempFileTampered)).toBe(false); // Cleaned up
      expect(fs.existsSync(targetFileTampered)).toBe(false); // Target never created
    });

    it("enforces partial download protection: rejects truncated download, unlinks temp file, and preserves target", async () => {
      const fullPayload = Buffer.from("FULL_COMPLETE_PRODUCTION_BINARY");
      const fullDigest =
        `sha256:${crypto.createHash("sha256").update(fullPayload).digest("hex")}` as `sha256:${string}`;

      // Simulate an existing installed production binary
      const targetPath = path.join(tmpDir, "existing_prod.tar");
      const existingProdContent = Buffer.from("EXISTING_UNTOUCHED_PROD_PAYLOAD");
      await fs.promises.writeFile(targetPath, existingProdContent);

      // Simulate partial truncated download (only 10 bytes received)
      const truncatedPayload = fullPayload.subarray(0, 10);
      const tempPath = path.join(tmpDir, "download_partial.tmp.part");
      await fs.promises.writeFile(tempPath, truncatedPayload);

      const res = await InstallerArtifactVerifier.verifyAndPromote({
        tempFilePath: tempPath,
        targetFilePath: targetPath,
        expectedSizeBytes: fullPayload.length,
        expectedDigest: fullDigest,
      });

      expect(res.ok).toBe(false);
      expect(res.code).toBe("SIZE_MISMATCH");
      expect(fs.existsSync(tempPath)).toBe(false); // Cleaned up
      expect(fs.readFileSync(targetPath).toString()).toBe(existingProdContent.toString()); // Untouched!
    });

    it("supports release retraction: marks status RETRACTED in index, denies distribution tokens, preserves artifact files", async () => {
      const storage = new FilesystemArtifactStorage(tmpDir);
      const publisher = new ReleasePublisher(storage, signer);
      const releaseId = "rel_to_retract";
      const appPayload = Buffer.from("RETRACT_TEST_APP");

      await publisher.publishRelease({
        releaseId,
        version: "2026.14.0",
        channel: "stable",
        minSchemaVersion: "1",
        artifacts: [
          {
            artifactId: "art_retract",
            architecture: "amd64",
            artifactType: "oci-image",
            filename: "art_retract.tar",
            data: appPayload,
          },
        ],
      });

      // Retract release
      const retracted = await publisher.retractRelease(releaseId);
      expect(retracted).toBe(true);

      // Gateway reads status as RETRACTED
      const gateway = new RealArtifactProvider({ storage });
      const rel = await gateway.getRelease(releaseId);
      expect(rel?.status).toBe("RETRACTED");

      // DistributionService denies token request
      const db = new MockDatabaseClient();
      const testLicId = "lic_123e4567-e89b-42d3-a456-426614174000";
      const testInstId = "inst_123e4567-e89b-42d3-a456-426614174000";
      db.licenses.set(testLicId, {
        id: testLicId,
        status: "ACTIVE",
        valid_from: "2026-10-01T00:00:00Z",
        expires_at: "2027-10-01T00:00:00Z",
        maintenance_until: "2027-10-01T00:00:00Z",
        grace_days: 7,
      });
      db.installations.set(testInstId, {
        id: testInstId,
        license_id: testLicId,
        public_key: installationKeypair.publicKeyPem,
        status: "ACTIVE",
      });

      const distService = new DistributionService({
        db,
        provider: gateway,
        grantStore: new MemoryGrantStore(),
        nonceStore: new MemoryNonceStore(),
        rateLimiter: new MemoryRateLimiter(),
      });

      const now = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomBytes(16).toString("hex");
      const bodyObj = {
        installation_id: testInstId,
        release_id: releaseId,
        architecture: "amd64",
        timestamp: now,
        nonce,
      };
      const rawBody = JSON.stringify(bodyObj);
      const sig = createInstallationRequestSignature({
        installationId: testInstId,
        timestamp: now,
        nonce,
        method: "POST",
        path: "/api/v1/licensing/distribution-token",
        body: rawBody,
        privateKeyPem: installationKeypair.privateKeyPem,
      });

      const tokenRes = await distService.issueDistributionToken({
        installation_id: testInstId,
        release_id: releaseId,
        architecture: "amd64",
        timestamp: now,
        nonce,
        rawBody,
        signatureBase64url: sig,
      });

      expect(tokenRes.ok).toBe(false);
      expect(tokenRes.error?.code).toBe("RELEASE_RETRACTED");

      // Verify artifact binary is preserved (NOT deleted)
      const digestHex = crypto.createHash("sha256").update(appPayload).digest("hex");
      const artifactKey = publisher.buildArtifactStorageKey(releaseId, "art_retract", digestHex);
      const artifactExists = await storage.objectExists(artifactKey);
      expect(artifactExists).toBe(true);
    });
  });
});
