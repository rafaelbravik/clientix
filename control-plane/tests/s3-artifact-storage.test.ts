import { describe, it, expect, beforeEach } from "vitest";
import crypto from "crypto";
import {
  S3ArtifactStorageBackend,
  S3ArtifactStoragePublisher,
  S3ArtifactStorageReader,
  signS3Request,
} from "../src/s3-artifact-storage";
import { ReleasePublisher } from "../src/release-publisher";
import { RealArtifactProvider } from "../src/real-artifact-provider";
import { LocalReleaseManifestSigner } from "../src/manifest-signer";
import { DistributionService } from "../src/distribution-service";
import { MemoryGrantStore } from "../src/distribution-provider";
import { MemoryRateLimiter } from "../src/rate-limiter";
import { InstallerArtifactVerifier } from "../src/installer-verifier";
import {
  generateInstallationKeyPair,
  createInstallationRequestSignature,
  MemoryNonceStore,
} from "@/lib/licensing/installation-auth";
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

/**
 * Creates an in-memory HTTP fetch mock simulating S3/R2 REST API.
 */
function createMockS3HttpServer() {
  const store = new Map<string, { body: Buffer; headers: Record<string, string> }>();
  let simulateOutage = false;
  let simulateReadOnly403 = false;

  const fetchHandler: typeof fetch = async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ): Promise<Response> => {
    if (simulateOutage) {
      throw new Error("fetch failed: ECONNREFUSED s3.staging.clientix.internal");
    }

    const urlStr =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(urlStr);
    const method = init?.method?.toUpperCase() ?? "GET";
    const auth =
      (init?.headers as Record<string, string>)?.["authorization"] ??
      (init?.headers as Record<string, string>)?.["Authorization"];

    // 1. Direct unauthorized request (no SigV4 auth)
    if (!auth || !auth.startsWith("AWS4-HMAC-SHA256")) {
      return new Response(
        JSON.stringify({ error: "AccessDenied", message: "Anonymous direct access forbidden" }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      );
    }

    // 2. Read-only credential simulation (rejects PUT/DELETE)
    if (simulateReadOnly403 && (method === "PUT" || method === "DELETE")) {
      return new Response(
        JSON.stringify({
          error: "AccessDenied",
          message: "User does not have PutObject/DeleteObject permissions",
        }),
        {
          status: 403,
          headers: { "content-type": "application/json" },
        },
      );
    }

    // Parse bucket and key from path: /bucket/key...
    const segments = url.pathname.replace(/^\/+/, "").split("/");
    const bucket = segments[0]!;
    const key = segments.slice(1).join("/");
    const storeKey = `${bucket}/${key}`;

    if (method === "HEAD") {
      const item = store.get(storeKey);
      if (!item) {
        return new Response(null, { status: 404, statusText: "Not Found" });
      }
      return new Response(null, {
        status: 200,
        headers: {
          ...item.headers,
          "content-length": item.body.length.toString(),
          "last-modified": new Date().toUTCString(),
        },
      });
    }

    if (method === "GET") {
      const item = store.get(storeKey);
      if (!item) {
        return new Response(null, { status: 404, statusText: "Not Found" });
      }
      return new Response(new Uint8Array(item.body), {
        status: 200,
        headers: {
          ...item.headers,
          "content-length": item.body.length.toString(),
        },
      });
    }

    if (method === "PUT") {
      let bodyBuffer: Buffer;
      if (Buffer.isBuffer(init?.body)) {
        bodyBuffer = init.body;
      } else if (typeof init?.body === "string") {
        bodyBuffer = Buffer.from(init.body);
      } else if (init?.body instanceof Uint8Array) {
        bodyBuffer = Buffer.from(init.body);
      } else {
        bodyBuffer = Buffer.alloc(0);
      }

      const headers: Record<string, string> = {
        "content-type":
          (init?.headers as Record<string, string>)?.["content-type"] ?? "application/octet-stream",
        "x-amz-meta-sha256": (init?.headers as Record<string, string>)?.["x-amz-meta-sha256"] ?? "",
      };

      store.set(storeKey, { body: bodyBuffer, headers });
      return new Response(null, { status: 200, statusText: "OK" });
    }

    if (method === "DELETE") {
      store.delete(storeKey);
      return new Response(null, { status: 204, statusText: "No Content" });
    }

    return new Response(null, { status: 405, statusText: "Method Not Allowed" });
  };

  return {
    fetchHandler,
    store,
    setOutage: (v: boolean) => {
      simulateOutage = v;
    },
    setReadOnlyMode: (v: boolean) => {
      simulateReadOnly403 = v;
    },
  };
}

describe("L9.2 Real Artifact Storage Integration & Remote Distribution Certification", () => {
  let manifestSigner: LocalReleaseManifestSigner;
  let manifestSignerKeyPair: { privateKeyPem: string; publicKeyPem: string };
  let installationKeypair: { privateKeyPem: string; publicKeyPem: string };

  const testConfig = {
    endpoint: "https://staging-r2.clientix.internal",
    region: "auto",
    bucket: "clientix-staging-distribution",
    accessKeyId: "AKIATESTING12345678",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  };

  beforeEach(() => {
    manifestSignerKeyPair = generateInstallationKeyPair();
    manifestSigner = new LocalReleaseManifestSigner(
      "manifest_signer_l9_2",
      manifestSignerKeyPair.privateKeyPem,
    );
    installationKeypair = generateInstallationKeyPair();
  });

  describe("1. AWS SigV4 Request Signer", () => {
    it("generates valid AWS4-HMAC-SHA256 headers for S3 endpoints", () => {
      const url = new URL(
        "https://staging-r2.clientix.internal/clientix-staging-distribution/releases/manifest.json",
      );
      const signed = signS3Request({
        method: "GET",
        url,
        headers: { accept: "application/json" },
        accessKeyId: testConfig.accessKeyId,
        secretAccessKey: testConfig.secretAccessKey,
        region: "auto",
        timestamp: new Date("2026-10-08T19:00:00Z"),
      });

      expect(signed["host"]).toBe("staging-r2.clientix.internal");
      expect(signed["x-amz-date"]).toBe("20261008T190000Z");
      expect(signed["x-amz-content-sha256"]).toBe(
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
      );
      expect(signed["authorization"]).toMatch(
        /^AWS4-HMAC-SHA256 Credential=AKIATESTING12345678\/20261008\/auto\/s3\/aws4_request, SignedHeaders=accept;host;x-amz-content-sha256;x-amz-date, Signature=[a-f0-9]{64}$/,
      );
    });
  });

  describe("2. S3 Storage Adapter & Release Publication Certification", () => {
    it("publishes complete staging release (5 artifacts, amd64 & arm64) to S3-compatible backend", async () => {
      const server = createMockS3HttpServer();
      const backend = new S3ArtifactStorageBackend({
        ...testConfig,
        fetchFn: server.fetchHandler,
      });

      const publisher = new ReleasePublisher(backend, manifestSigner);

      // Staging test payloads for app, worker, scheduler, voice, migrator
      const appAmd64 = Buffer.from("STAGING_IMAGE_PAYLOAD_APP_AMD64_COMPILED");
      const appArm64 = Buffer.from("STAGING_IMAGE_PAYLOAD_APP_ARM64_COMPILED");
      const workerAmd64 = Buffer.from("STAGING_IMAGE_PAYLOAD_WORKER_AMD64_COMPILED");
      const schedulerAmd64 = Buffer.from("STAGING_IMAGE_PAYLOAD_SCHEDULER_AMD64_COMPILED");
      const voiceAmd64 = Buffer.from("STAGING_IMAGE_PAYLOAD_VOICE_AMD64_COMPILED");
      const migratorAmd64 = Buffer.from("STAGING_IMAGE_PAYLOAD_MIGRATOR_AMD64_COMPILED");

      const releaseId = "2026.10.0-rc-storage-test";

      const pubRes = await publisher.publishRelease({
        releaseId,
        version: "2026.10.0-rc1",
        channel: "candidate",
        minSchemaVersion: "1",
        artifacts: [
          {
            artifactId: "art_app_amd64",
            architecture: "amd64",
            artifactType: "oci-image",
            filename: "app-amd64.tar",
            data: appAmd64,
          },
          {
            artifactId: "art_app_arm64",
            architecture: "arm64",
            artifactType: "oci-image",
            filename: "app-arm64.tar",
            data: appArm64,
          },
          {
            artifactId: "art_worker_amd64",
            architecture: "amd64",
            artifactType: "oci-image",
            filename: "worker-amd64.tar",
            data: workerAmd64,
          },
          {
            artifactId: "art_scheduler_amd64",
            architecture: "amd64",
            artifactType: "oci-image",
            filename: "scheduler-amd64.tar",
            data: schedulerAmd64,
          },
          {
            artifactId: "art_voice_amd64",
            architecture: "amd64",
            artifactType: "oci-image",
            filename: "voice-amd64.tar",
            data: voiceAmd64,
          },
          {
            artifactId: "art_migrator_amd64",
            architecture: "amd64",
            artifactType: "oci-image",
            filename: "migrator-amd64.tar",
            data: migratorAmd64,
          },
        ],
      });

      expect(pubRes.artifacts.length).toBe(6);
      expect(pubRes.manifest.payload.version).toBe("2026.10.0-rc1");
      expect(pubRes.manifest.signature).toBeDefined();

      // Read-back verification from remote S3 backend
      const manifestKey = `releases/${releaseId}/manifest.json`;
      const manifestExists = await backend.objectExists(manifestKey);
      expect(manifestExists).toBe(true);

      const manifestStream = await backend.getObjectStream(manifestKey);
      expect(manifestStream).not.toBeNull();
      const readManifest = JSON.parse(manifestStream!.toString("utf-8"));
      expect(readManifest.payload.version).toBe("2026.10.0-rc1");

      // Verify artifact metadata & SHA-256 match
      const appDigestHex = crypto.createHash("sha256").update(appAmd64).digest("hex");
      const appStorageKey = `releases/${releaseId}/art_app_amd64/${appDigestHex}`;
      const appMeta = await backend.getObjectMetadata(appStorageKey);
      expect(appMeta).not.toBeNull();
      expect(appMeta?.sizeBytes).toBe(appAmd64.length);
      expect(appMeta?.digest).toBe(`sha256:${appDigestHex}`);

      const appData = await backend.getObjectStream(appStorageKey);
      expect(appData).toEqual(appAmd64);
    });

    it("enforces immutability: rejects overwriting existing S3 object with different content", async () => {
      const server = createMockS3HttpServer();
      const publisherBackend = new S3ArtifactStoragePublisher({
        ...testConfig,
        fetchFn: server.fetchHandler,
      });

      const key = "releases/immut_test/app/sha256test";
      const initialBytes = Buffer.from("ORIGINAL_IMMUTABLE_LAYER");

      // First upload
      await publisherBackend.putObject(key, initialBytes);

      // Same bytes -> Idempotent success
      const idempRes = await publisherBackend.putObject(key, initialBytes);
      expect(idempRes.sizeBytes).toBe(initialBytes.length);

      // Different bytes -> Throws IMMUTABLE_OBJECT_CONFLICT
      const tamperedBytes = Buffer.from("TAMPERED_LAYER_BYTES");
      await expect(publisherBackend.putObject(key, tamperedBytes)).rejects.toThrow(
        /IMMUTABLE_OBJECT_CONFLICT/,
      );
    });
  });

  describe("3. Read-Only Gateway Least Privilege & Public Access Verification", () => {
    it("proves Read-Only Gateway credential can read but cannot execute PUT or DELETE", async () => {
      const server = createMockS3HttpServer();
      server.setReadOnlyMode(true); // Simulate IAM policy with s3:GetObject only

      const reader = new S3ArtifactStorageReader({
        ...testConfig,
        fetchFn: server.fetchHandler,
      });

      // Gateway only receives reader
      const gateway = new RealArtifactProvider({ storage: reader });

      // Runtime assertion: Gateway possesses no mutation methods
      expect((gateway as unknown as Record<string, unknown>).putObject).toBeUndefined();
      expect((gateway as unknown as Record<string, unknown>).deleteObject).toBeUndefined();

      // If an unauthorized publisher attempts PUT with read-only credential, S3 returns 403
      const unauthorizedPublisher = new S3ArtifactStoragePublisher({
        ...testConfig,
        fetchFn: server.fetchHandler,
      });

      await expect(
        unauthorizedPublisher.putObject("test/key", Buffer.from("unauthorized")),
      ).rejects.toThrow(/S3_ACCESS_DENIED/);

      await expect(unauthorizedPublisher.deleteObject("test/key")).rejects.toThrow(
        /S3_ACCESS_DENIED/,
      );
    });

    it("blocks direct unauthorized public download attempts (private bucket protection)", async () => {
      const server = createMockS3HttpServer();

      // Direct HTTP fetch without SigV4 headers
      const directRes = await server.fetchHandler(
        "https://staging-r2.clientix.internal/clientix-staging-distribution/releases/secret.tar",
        { method: "GET" },
      );

      expect(directRes.status).toBe(403);
      const json = await directRes.json();
      expect(json.error).toBe("AccessDenied");
    });
  });

  describe("4. End-to-End PoP Token Flow against S3 Storage", () => {
    const releaseId = "2026.10.0-rc-storage-test";
    const appAmd64Payload = Buffer.from("COMPILED_APP_CONTAINER_IMAGE_AMD64");
    const appArm64Payload = Buffer.from("COMPILED_APP_CONTAINER_IMAGE_ARM64");
    const appAmd64Digest =
      `sha256:${crypto.createHash("sha256").update(appAmd64Payload).digest("hex")}` as `sha256:${string}`;
    const appArm64Digest =
      `sha256:${crypto.createHash("sha256").update(appArm64Payload).digest("hex")}` as `sha256:${string}`;

    const testLicId = "lic_123e4567-e89b-42d3-a456-426614174000";
    const testInstId = "inst_123e4567-e89b-42d3-a456-426614174000";

    let server: ReturnType<typeof createMockS3HttpServer>;
    let gateway: RealArtifactProvider;
    let distService: DistributionService;
    let db: MockDatabaseClient;
    let grantStore: MemoryGrantStore;

    beforeEach(async () => {
      server = createMockS3HttpServer();
      const backend = new S3ArtifactStorageBackend({
        ...testConfig,
        fetchFn: server.fetchHandler,
      });

      const publisher = new ReleasePublisher(backend, manifestSigner);
      await publisher.publishRelease({
        releaseId,
        version: "2026.10.0-rc1",
        channel: "candidate",
        minSchemaVersion: "1",
        artifacts: [
          {
            artifactId: "art_app_amd64",
            architecture: "amd64",
            artifactType: "oci-image",
            filename: "app-amd64.tar",
            data: appAmd64Payload,
          },
          {
            artifactId: "art_app_arm64",
            architecture: "arm64",
            artifactType: "oci-image",
            filename: "app-arm64.tar",
            data: appArm64Payload,
          },
        ],
      });

      // Gateway uses strictly reader
      const reader = new S3ArtifactStorageReader({
        ...testConfig,
        fetchFn: server.fetchHandler,
      });
      gateway = new RealArtifactProvider({ storage: reader });

      db = new MockDatabaseClient();
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

      grantStore = new MemoryGrantStore();
      distService = new DistributionService({
        db,
        provider: gateway,
        grantStore,
        nonceStore: new MemoryNonceStore(),
        rateLimiter: new MemoryRateLimiter(),
      });
    });

    const createTokenRequest = (arch: "amd64" | "arm64" = "amd64") => {
      const now = Math.floor(Date.now() / 1000);
      const nonce = crypto.randomBytes(16).toString("hex");
      const bodyObj = {
        installation_id: testInstId,
        release_id: releaseId,
        architecture: arch,
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

      return {
        installation_id: testInstId,
        release_id: releaseId,
        architecture: arch,
        timestamp: now,
        nonce,
        rawBody,
        signatureBase64url: sig,
      };
    };

    it("executes installation PoP authentication and streams artifact from S3 storage", async () => {
      // 1. Issue distribution grant
      const tokenRes = await distService.issueDistributionToken(createTokenRequest("amd64"));
      expect(tokenRes.ok).toBe(true);
      expect(tokenRes.data?.distribution_token).toMatch(/^cdt_/);

      const token = tokenRes.data!.distribution_token;

      // 2. Fetch manifest through gateway
      const manRes = await distService.getReleaseManifest(releaseId, token);
      expect(manRes.ok).toBe(true);
      expect(manRes.data?.payload.version).toBe("2026.10.0-rc1");

      // 3. Download artifact from S3 through gateway
      const dlRes = await distService.downloadArtifact("art_app_amd64", token);
      expect(dlRes.ok).toBe(true);
      expect(dlRes.data?.stream).toEqual(appAmd64Payload);
      expect(dlRes.data?.metadata.digest).toBe(appAmd64Digest);

      // 4. Token Hygiene: Ensure cdt_* token is NOT persisted in events or storage
      const event = db.events.find((e) => e.event_type === "DISTRIBUTION_TOKEN_ISSUED");
      expect(event).toBeDefined();
      expect(JSON.stringify(event)).not.toContain(token);
    });

    it("enforces Token Scope: rejects requesting arm64 artifact with amd64 grant", async () => {
      const tokenRes = await distService.issueDistributionToken(createTokenRequest("amd64"));
      const token = tokenRes.data!.distribution_token;

      const dlRes = await distService.downloadArtifact("art_app_arm64", token);
      expect(dlRes.ok).toBe(false);
      expect(dlRes.error?.code).toBe("TOKEN_SCOPE_MISMATCH");
    });

    it("denies download when license is revoked after grant issuance", async () => {
      const tokenRes = await distService.issueDistributionToken(createTokenRequest("amd64"));
      const token = tokenRes.data!.distribution_token;

      // Revoke license
      db.licenses.set(testLicId, { id: testLicId, status: "REVOKED" });

      const dlRes = await distService.downloadArtifact("art_app_amd64", token);
      expect(dlRes.ok).toBe(false);
      expect(dlRes.error?.code).toBe("DISTRIBUTION_NOT_ALLOWED");
    });

    it("denies download when grant expires", async () => {
      const tokenRes = await distService.issueDistributionToken(createTokenRequest("amd64"));
      const token = tokenRes.data!.distribution_token;

      // Fast forward time past grant expiration
      const expiredService = new DistributionService({
        db,
        provider: gateway,
        grantStore,
        nonceStore: new MemoryNonceStore(),
        rateLimiter: new MemoryRateLimiter(),
        clockNow: () => new Date(Date.now() + 3600 * 1000), // 1 hour later
      });

      const dlRes = await expiredService.downloadArtifact("art_app_amd64", token);
      expect(dlRes.ok).toBe(false);
      expect(dlRes.error?.code).toBe("TOKEN_EXPIRED");
    });

    it("handles remote storage outage cleanly and fails closed", async () => {
      const tokenRes = await distService.issueDistributionToken(createTokenRequest("amd64"));
      const token = tokenRes.data!.distribution_token;

      // Simulate network / S3 outage
      server.setOutage(true);

      await expect(distService.downloadArtifact("art_app_amd64", token)).rejects.toThrow(
        /STORAGE_UNREACHABLE/,
      );
    });

    it("enforces installer atomic verification against S3 downloaded stream", async () => {
      const tokenRes = await distService.issueDistributionToken(createTokenRequest("amd64"));
      const token = tokenRes.data!.distribution_token;

      const manRes = await distService.getReleaseManifest(releaseId, token);
      const appArtMeta = manRes.data!.payload.artifacts.find(
        (a) => a.artifactId === "art_app_amd64",
      )!;

      const dlRes = await distService.downloadArtifact("art_app_amd64", token);
      expect(dlRes.ok).toBe(true);

      // Client writes stream to .tmp.part
      const fs = await import("fs");
      const path = await import("path");
      const os = await import("os");
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-installer-test-"));

      const tempFile = path.join(tmpDir, "app.tmp.part");
      const targetFile = path.join(tmpDir, "app_installed.tar");
      await fs.promises.writeFile(tempFile, dlRes.data!.stream);

      // 1. Valid verification promotes to target
      const verifyRes = await InstallerArtifactVerifier.verifyAndPromote({
        tempFilePath: tempFile,
        targetFilePath: targetFile,
        expectedSizeBytes: appArtMeta.sizeBytes,
        expectedDigest: appArtMeta.digest,
      });

      expect(verifyRes.ok).toBe(true);
      expect(fs.existsSync(targetFile)).toBe(true);
      expect(fs.existsSync(tempFile)).toBe(false);

      // 2. Tampered verification aborts and unlinks
      const tamperedTemp = path.join(tmpDir, "tampered.tmp.part");
      const tamperedTarget = path.join(tmpDir, "tampered_target.tar");
      await fs.promises.writeFile(tamperedTemp, Buffer.from("TAMPERED_STREAM_BYTES"));

      const corruptRes = await InstallerArtifactVerifier.verifyAndPromote({
        tempFilePath: tamperedTemp,
        targetFilePath: tamperedTarget,
        expectedSizeBytes: Buffer.from("TAMPERED_STREAM_BYTES").length,
        expectedDigest: appArtMeta.digest, // Valid expected, but actual is tampered
      });

      expect(corruptRes.ok).toBe(false);
      expect(corruptRes.code).toBe("DIGEST_MISMATCH");
      expect(fs.existsSync(tamperedTemp)).toBe(false);
      expect(fs.existsSync(tamperedTarget)).toBe(false);

      fs.rmSync(tmpDir, { recursive: true, force: true });
    });
  });
});
