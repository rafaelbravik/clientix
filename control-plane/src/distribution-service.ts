import crypto from "crypto";
import type { DatabaseClient } from "../scripts/migrator";
import type { NonceStore } from "@/lib/licensing/installation-auth";
import { verifyInstallationRequestSignature } from "@/lib/licensing/installation-auth";
import type { RateLimiter } from "./rate-limiter";
import type {
  DistributionTokenRequest,
  DistributionTokenResponseData,
  DistributionServiceResult,
  DistributionGrant,
  DistributionTokenClaims,
  ArtifactMetadata,
  SignedReleaseManifest,
} from "./distribution-types";
import type { DistributionProvider } from "./distribution-provider";
import type { DistributionGrantStore } from "./redis-grant-store";

export interface DistributionServiceContext {
  db: DatabaseClient;
  provider: DistributionProvider;
  grantStore: DistributionGrantStore;
  nonceStore: NonceStore;
  rateLimiter?: RateLimiter;
  clockNow?: () => Date;
  tokenTtlSeconds?: number; // default 900
}

export class DistributionService {
  constructor(private readonly ctx: DistributionServiceContext) {
    // Production Fail-Closed Defense:
    // If running in production, grantStore MUST NOT be an in-memory/test-only store.
    const isProd = process.env.NODE_ENV === "production";
    const isTestOnly = (this.ctx.grantStore as { isTestOnly?: boolean }).isTestOnly === true;
    if (isProd && isTestOnly) {
      throw new Error(
        "CRITICAL: MemoryGrantStore cannot be used in production. A shared RedisGrantStore must be configured."
      );
    }
  }

  private now(): Date {
    return this.ctx.clockNow ? this.ctx.clockNow() : new Date();
  }

  private async recordEvent(params: {
    licenseId?: string | null;
    installationId?: string | null;
    eventType: string;
    payload?: Record<string, unknown>;
  }): Promise<void> {
    await this.ctx.db.query(
      `insert into control_plane.licensing_events (license_id, installation_id, event_type, payload, actor, created_at)
       values ($1, $2, $3, $4, 'system', now());`,
      [
        params.licenseId ?? null,
        params.installationId ?? null,
        params.eventType,
        JSON.stringify(params.payload ?? {}),
      ]
    );
  }

  // =========================================================================
  // 1. ISSUE DISTRIBUTION TOKEN (POST /api/v1/licensing/distribution-token)
  // =========================================================================
  async issueDistributionToken(
    params: DistributionTokenRequest
  ): Promise<DistributionServiceResult<DistributionTokenResponseData>> {
    const serverDate = this.now();
    const serverUnixSeconds = Math.floor(serverDate.getTime() / 1000);

    // 1. Rate Limiting Check
    if (this.ctx.rateLimiter) {
      const rateKey = `dist_token:${params.installation_id}`;
      const limit = await this.ctx.rateLimiter.checkLimit(rateKey, 10, 60);
      if (!limit.allowed) {
        return {
          ok: false,
          status: 429,
          error: { code: "RATE_LIMITED", message: "Too many distribution token requests. Rate limit exceeded." },
        };
      }
    }

    // 2. Fetch installation & license from database
    const instRes = await this.ctx.db.query<{
      id: string;
      license_id: string;
      public_key: string;
      status: "ACTIVE" | "SUSPENDED" | "REVOKED" | "DEACTIVATED";
    }>(
      `select id, license_id, public_key, status from control_plane.licensing_installations where id = $1;`,
      [params.installation_id]
    );

    if (instRes.rows.length === 0) {
      return {
        ok: false,
        status: 404,
        error: { code: "UNAUTHORIZED", message: "Installation not registered." },
      };
    }

    const inst = instRes.rows[0]!;

    // 3. Installation PoP Verification
    const bodyObject: Record<string, unknown> = {
      installation_id: params.installation_id,
      release_id: params.release_id,
      architecture: params.architecture,
      timestamp: params.timestamp,
      nonce: params.nonce,
    };
    if (params.client_schema_version !== undefined) {
      bodyObject.client_schema_version = params.client_schema_version;
    }

    const serializedBody = params.rawBody !== undefined ? params.rawBody : JSON.stringify(bodyObject);

    const authCheck = await verifyInstallationRequestSignature({
      installationId: params.installation_id,
      timestamp: params.timestamp,
      nonce: params.nonce,
      method: "POST",
      path: "/api/v1/licensing/distribution-token",
      body: serializedBody,
      signatureBase64url: params.signatureBase64url,
      publicKeyPem: inst.public_key,
      nonceStore: this.ctx.nonceStore,
      currentTimestampUnixSeconds: serverUnixSeconds,
    });

    if (!authCheck.ok) {
      if (authCheck.code === "REPLAY_DETECTED") {
        return { ok: false, status: 409, error: { code: "REPLAY_DETECTED", message: "Replay attack detected." } };
      }
      if (authCheck.code === "INVALID_TIMESTAMP") {
        return { ok: false, status: 401, error: { code: "CLOCK_SKEW_EXCEEDED", message: "Clock skew exceeded." } };
      }
      return {
        ok: false,
        status: 401,
        error: { code: "INVALID_INSTALLATION_SIGNATURE", message: "Invalid cryptographic signature." },
      };
    }

    // 4. Installation Administrative Status Check
    if (inst.status === "REVOKED") {
      await this.recordEvent({
        installationId: inst.id,
        eventType: "DISTRIBUTION_DENIED",
        payload: { reason: "INSTALLATION_REVOKED" },
      });
      return {
        ok: false,
        status: 403,
        error: { code: "DISTRIBUTION_NOT_ALLOWED", message: "Installation is revoked." },
      };
    }

    if (inst.status !== "ACTIVE") {
      await this.recordEvent({
        installationId: inst.id,
        eventType: "DISTRIBUTION_DENIED",
        payload: { reason: `INSTALLATION_${inst.status}` },
      });
      return {
        ok: false,
        status: 403,
        error: { code: "DISTRIBUTION_NOT_ALLOWED", message: `Installation is ${inst.status}.` },
      };
    }

    // 5. Query License
    const licRes = await this.ctx.db.query<{
      id: string;
      status: "ACTIVE" | "SUSPENDED" | "REVOKED";
      valid_from: string;
      expires_at: string;
      maintenance_until: string | null;
      grace_days: number;
    }>(
      `select id, status, valid_from, expires_at, maintenance_until, grace_days from control_plane.licensing_licenses where id = $1;`,
      [inst.license_id]
    );

    if (licRes.rows.length === 0) {
      return {
        ok: false,
        status: 404,
        error: { code: "DISTRIBUTION_NOT_ALLOWED", message: "License not found." },
      };
    }

    const lic = licRes.rows[0]!;

    // 6. License Administrative Status
    if (lic.status === "REVOKED") {
      await this.recordEvent({
        licenseId: lic.id,
        installationId: inst.id,
        eventType: "DISTRIBUTION_DENIED",
        payload: { reason: "LICENSE_REVOKED" },
      });
      return {
        ok: false,
        status: 403,
        error: { code: "DISTRIBUTION_NOT_ALLOWED", message: "License is revoked." },
      };
    }

    if (lic.status === "SUSPENDED") {
      await this.recordEvent({
        licenseId: lic.id,
        installationId: inst.id,
        eventType: "DISTRIBUTION_DENIED",
        payload: { reason: "LICENSE_SUSPENDED" },
      });
      return {
        ok: false,
        status: 403,
        error: { code: "DISTRIBUTION_NOT_ALLOWED", message: "License is suspended." },
      };
    }

    // 7. License Temporal State Check
    const nowMs = serverDate.getTime();
    const validFromMs = new Date(lic.valid_from).getTime();
    const expiresAtMs = new Date(lic.expires_at).getTime();
    const graceMs = (lic.grace_days ?? 7) * 24 * 60 * 60 * 1000;

    let temporalState: "NOT_YET_VALID" | "VALID" | "GRACE" | "EXPIRED" = "VALID";
    if (nowMs < validFromMs) {
      temporalState = "NOT_YET_VALID";
    } else if (nowMs < expiresAtMs) {
      temporalState = "VALID";
    } else if (nowMs < expiresAtMs + graceMs) {
      temporalState = "GRACE";
    } else {
      temporalState = "EXPIRED";
    }

    if (temporalState === "NOT_YET_VALID" || temporalState === "EXPIRED") {
      await this.recordEvent({
        licenseId: lic.id,
        installationId: inst.id,
        eventType: "DISTRIBUTION_DENIED",
        payload: { reason: `TEMPORAL_${temporalState}` },
      });
      return {
        ok: false,
        status: 403,
        error: { code: "DISTRIBUTION_NOT_ALLOWED", message: `License is ${temporalState}. Distribution denied.` },
      };
    }

    // 8. Fetch release from provider
    const release = await this.ctx.provider.getRelease(params.release_id);
    if (!release) {
      return {
        ok: false,
        status: 404,
        error: { code: "RELEASE_NOT_FOUND", message: `Release "${params.release_id}" not found.` },
      };
    }

    if (release.status === "RETRACTED") {
      return {
        ok: false,
        status: 403,
        error: { code: "RELEASE_RETRACTED", message: `Release "${params.release_id}" has been retracted.` },
      };
    }

    // 9. Grace Entitlement Policy:
    // GRACE licenses can ONLY access security channel releases
    if (temporalState === "GRACE" && release.channel !== "security") {
      await this.recordEvent({
        licenseId: lic.id,
        installationId: inst.id,
        eventType: "DISTRIBUTION_DENIED",
        payload: { reason: "GRACE_SECURITY_ONLY", channel: release.channel },
      });
      return {
        ok: false,
        status: 403,
        error: {
          code: "RELEASE_NOT_ENTITLED",
          message: "Licenses in grace period are only entitled to security channel updates.",
        },
      };
    }

    // 10. Maintenance Entitlement Check
    if (release.requiredMaintenanceDate) {
      if (!lic.maintenance_until) {
        return {
          ok: false,
          status: 403,
          error: { code: "MAINTENANCE_NOT_ENTITLED", message: "License does not include maintenance entitlement." },
        };
      }
      const requiredMs = new Date(release.requiredMaintenanceDate).getTime();
      const licMaintMs = new Date(lic.maintenance_until).getTime();
      if (licMaintMs < requiredMs) {
        return {
          ok: false,
          status: 403,
          error: { code: "MAINTENANCE_NOT_ENTITLED", message: "Release requires active maintenance entitlement." },
        };
      }
    }

    // 11. Schema Compatibility Check
    if (params.client_schema_version) {
      const clientSchema = parseInt(params.client_schema_version, 10);
      const minSchema = parseInt(release.minSchemaVersion, 10);
      if (!isNaN(clientSchema) && !isNaN(minSchema) && clientSchema < minSchema) {
        return {
          ok: false,
          status: 400,
          error: {
            code: "SCHEMA_INCOMPATIBLE",
            message: `Client schema ${params.client_schema_version} is below required minimum ${release.minSchemaVersion}.`,
          },
        };
      }
      if (release.maxSchemaVersion) {
        const maxSchema = parseInt(release.maxSchemaVersion, 10);
        if (!isNaN(clientSchema) && !isNaN(maxSchema) && clientSchema > maxSchema) {
          return {
            ok: false,
            status: 400,
            error: {
              code: "SCHEMA_INCOMPATIBLE",
              message: `Client schema ${params.client_schema_version} exceeds maximum supported ${release.maxSchemaVersion}.`,
            },
          };
        }
      }
    }

    // 12. Architecture Filter
    const authorizedArtifacts = release.artifacts.filter(
      (a) => a.architecture === params.architecture
    );

    if (authorizedArtifacts.length === 0) {
      return {
        ok: false,
        status: 404,
        error: { code: "ARTIFACT_NOT_FOUND", message: `No artifacts found for architecture "${params.architecture}".` },
      };
    }

    // 13. Generate Opaque Distribution Grant
    const rawEntropy = crypto.randomBytes(32).toString("base64url");
    const distributionToken = `cdt_${rawEntropy}`;
    const tokenHash = crypto.createHash("sha256").update(distributionToken, "utf-8").digest("hex");

    const ttl = Math.min(Math.max(this.ctx.tokenTtlSeconds ?? 900, 60), 3600); // 15m default, bounded 1m - 60m
    const expiresAt = serverUnixSeconds + ttl;
    const grantId = `grant_${crypto.randomUUID()}`;

    const allowedArtifactIds = authorizedArtifacts.map((a) => a.artifactId);
    const remainingUses = new Map<string, number>();
    for (const artId of allowedArtifactIds) {
      remainingUses.set(artId, 3); // 3 download attempts per artifact for retry safety
    }

    const claims: DistributionTokenClaims = {
      grantId,
      installationId: inst.id,
      licenseId: lic.id,
      releaseId: release.releaseId,
      architecture: params.architecture,
      allowedArtifactIds,
      expiresAt,
      createdAt: serverUnixSeconds,
    };

    const grant: DistributionGrant = {
      grantId,
      tokenHash,
      claims,
      remainingUses,
    };

    try {
      await this.ctx.grantStore.createGrant(grant, ttl);
    } catch {
      return {
        ok: false,
        status: 503,
        error: {
          code: "DISTRIBUTION_TEMPORARILY_UNAVAILABLE",
          message: "Distribution grant store is temporarily unavailable.",
        },
      };
    }

    // Audit Event (Token is completely sanitized from payload)
    await this.recordEvent({
      licenseId: lic.id,
      installationId: inst.id,
      eventType: "DISTRIBUTION_TOKEN_ISSUED",
      payload: {
        grant_id: grantId,
        release_id: release.releaseId,
        architecture: params.architecture,
        expires_at: new Date(expiresAt * 1000).toISOString(),
      },
    });

    return {
      ok: true,
      status: 200,
      data: {
        distribution_token: distributionToken,
        grant_id: grantId,
        release_id: release.releaseId,
        architecture: params.architecture,
        expires_in: ttl,
        expires_at: new Date(expiresAt * 1000).toISOString(),
      },
    };
  }

  // =========================================================================
  // 2. ARTIFACT GATEWAY (GET /api/v1/distribution/manifest/:releaseId)
  // =========================================================================
  async getReleaseManifest(
    releaseId: string,
    token: string
  ): Promise<DistributionServiceResult<SignedReleaseManifest>> {
    const tokenHash = crypto.createHash("sha256").update(token, "utf-8").digest("hex");
    let grant: DistributionGrant | null;
    try {
      grant = await this.ctx.grantStore.getGrant(tokenHash);
    } catch {
      return {
        ok: false,
        status: 503,
        error: {
          code: "DISTRIBUTION_TEMPORARILY_UNAVAILABLE",
          message: "Distribution grant store is temporarily unavailable.",
        },
      };
    }

    if (!grant) {
      return { ok: false, status: 401, error: { code: "TOKEN_INVALID", message: "Invalid distribution token." } };
    }

    const serverNow = Math.floor(this.now().getTime() / 1000);
    if (serverNow >= grant.claims.expiresAt) {
      return { ok: false, status: 401, error: { code: "TOKEN_EXPIRED", message: "Distribution token has expired." } };
    }

    if (grant.claims.releaseId !== releaseId) {
      return { ok: false, status: 403, error: { code: "TOKEN_SCOPE_MISMATCH", message: "Token not scoped for this release." } };
    }

    const manifest = await this.ctx.provider.getManifest(releaseId);
    if (!manifest) {
      return { ok: false, status: 404, error: { code: "RELEASE_NOT_FOUND", message: "Release manifest not found." } };
    }

    return { ok: true, status: 200, data: manifest };
  }

  // =========================================================================
  // 3. ARTIFACT DOWNLOAD (GET /api/v1/distribution/artifacts/:artifactId/download)
  // =========================================================================
  async downloadArtifact(
    artifactId: string,
    token: string
  ): Promise<DistributionServiceResult<{ metadata: ArtifactMetadata; stream: Buffer }>> {
    // 1. Path Traversal & Identifier Sanity
    if (
      artifactId.includes("..") ||
      artifactId.includes("/") ||
      artifactId.includes("\\") ||
      artifactId.includes("%2e") ||
      artifactId.includes("%2E")
    ) {
      return {
        ok: false,
        status: 400,
        error: { code: "PATH_TRAVERSAL_DETECTED", message: "Invalid characters in artifact identifier." },
      };
    }

    // 2. Verify Grant
    const tokenHash = crypto.createHash("sha256").update(token, "utf-8").digest("hex");
    let grant: DistributionGrant | null;
    try {
      grant = await this.ctx.grantStore.getGrant(tokenHash);
    } catch {
      return {
        ok: false,
        status: 503,
        error: {
          code: "DISTRIBUTION_TEMPORARILY_UNAVAILABLE",
          message: "Distribution grant store is temporarily unavailable.",
        },
      };
    }

    if (!grant) {
      return { ok: false, status: 401, error: { code: "TOKEN_INVALID", message: "Invalid distribution token." } };
    }

    const serverNow = Math.floor(this.now().getTime() / 1000);
    if (serverNow >= grant.claims.expiresAt) {
      return { ok: false, status: 401, error: { code: "TOKEN_EXPIRED", message: "Distribution token has expired." } };
    }

    // 3. Re-validate Installation & License Administrative Status (Revocation after issuance check)
    const instRes = await this.ctx.db.query<{ status: string }>(
      `select status from control_plane.licensing_installations where id = $1;`,
      [grant.claims.installationId]
    );
    if (instRes.rows.length === 0 || instRes.rows[0]!.status !== "ACTIVE") {
      await this.recordEvent({
        installationId: grant.claims.installationId,
        eventType: "ARTIFACT_DOWNLOAD_FAILED",
        payload: { artifact_id: artifactId, reason: "INSTALLATION_INACTIVE" },
      });
      return {
        ok: false,
        status: 403,
        error: { code: "DISTRIBUTION_NOT_ALLOWED", message: "Installation was deactivated or revoked." },
      };
    }

    const licRes = await this.ctx.db.query<{ status: string }>(
      `select status from control_plane.licensing_licenses where id = $1;`,
      [grant.claims.licenseId]
    );
    if (licRes.rows.length === 0 || licRes.rows[0]!.status !== "ACTIVE") {
      await this.recordEvent({
        licenseId: grant.claims.licenseId,
        installationId: grant.claims.installationId,
        eventType: "ARTIFACT_DOWNLOAD_FAILED",
        payload: { artifact_id: artifactId, reason: "LICENSE_INACTIVE" },
      });
      return {
        ok: false,
        status: 403,
        error: { code: "DISTRIBUTION_NOT_ALLOWED", message: "Associated license was suspended or revoked." },
      };
    }

    // 4. Rate Limiting Check on Artifact Downloads
    if (this.ctx.rateLimiter) {
      const rateKey = `dist_dl:${grant.claims.installationId}`;
      const limit = await this.ctx.rateLimiter.checkLimit(rateKey, 30, 60);
      if (!limit.allowed) {
        return {
          ok: false,
          status: 429,
          error: { code: "RATE_LIMITED", message: "Too many artifact download requests. Rate limit exceeded." },
        };
      }
    }

    // 5. Check Token Scope
    if (!grant.claims.allowedArtifactIds.includes(artifactId)) {
      return {
        ok: false,
        status: 403,
        error: { code: "TOKEN_SCOPE_MISMATCH", message: "Artifact is not in the authorized scope of this token." },
      };
    }

    // 6. Check Release Status (Release retraction after issuance check)
    const release = await this.ctx.provider.getRelease(grant.claims.releaseId);
    if (!release) {
      return { ok: false, status: 404, error: { code: "RELEASE_NOT_FOUND", message: "Release not found." } };
    }
    if (release.status === "RETRACTED") {
      await this.recordEvent({
        licenseId: grant.claims.licenseId,
        installationId: grant.claims.installationId,
        eventType: "ARTIFACT_DOWNLOAD_FAILED",
        payload: { release_id: release.releaseId, artifact_id: artifactId, reason: "RELEASE_RETRACTED" },
      });
      return {
        ok: false,
        status: 403,
        error: { code: "RELEASE_RETRACTED", message: `Release "${release.releaseId}" has been retracted.` },
      };
    }

    // 7. Consume download use atomically
    let consume;
    try {
      consume = await this.ctx.grantStore.consumeArtifactUse(tokenHash, artifactId, serverNow);
    } catch {
      return {
        ok: false,
        status: 503,
        error: {
          code: "DISTRIBUTION_TEMPORARILY_UNAVAILABLE",
          message: "Distribution grant store is temporarily unavailable.",
        },
      };
    }

    if (!consume.allowed) {
      if (consume.code === "ARTIFACT_GRANT_EXHAUSTED") {
        return {
          ok: false,
          status: 403,
          error: {
            code: "ARTIFACT_GRANT_EXHAUSTED",
            message: "Download attempt quota exhausted for this artifact grant.",
          },
        };
      }
      return {
        ok: false,
        status: 403,
        error: {
          code: "DISTRIBUTION_NOT_ALLOWED",
          message: consume.reason || "Artifact use cannot be authorized.",
        },
      };
    }

    // 8. Get Metadata & Stream from Provider
    const metadata = await this.ctx.provider.getArtifactMetadata(artifactId);
    if (!metadata) {
      return { ok: false, status: 404, error: { code: "ARTIFACT_NOT_FOUND", message: "Artifact metadata not found." } };
    }

    // Double check architecture
    if (metadata.architecture !== grant.claims.architecture) {
      return {
        ok: false,
        status: 403,
        error: { code: "TOKEN_SCOPE_MISMATCH", message: "Artifact architecture does not match token grant." },
      };
    }

    await this.recordEvent({
      licenseId: grant.claims.licenseId,
      installationId: grant.claims.installationId,
      eventType: "ARTIFACT_DOWNLOAD_STARTED",
      payload: { artifact_id: artifactId, size: metadata.sizeBytes },
    });

    const stream = await this.ctx.provider.readArtifactStream(artifactId);
    if (!stream) {
      await this.recordEvent({
        licenseId: grant.claims.licenseId,
        installationId: grant.claims.installationId,
        eventType: "ARTIFACT_DOWNLOAD_FAILED",
        payload: { artifact_id: artifactId, reason: "STREAM_NOT_FOUND" },
      });
      return { ok: false, status: 404, error: { code: "ARTIFACT_NOT_FOUND", message: "Artifact binary not found." } };
    }

    // 8. Digest Verification on Gateway Stream
    const computedDigest = `sha256:${crypto.createHash("sha256").update(stream).digest("hex")}`;
    if (computedDigest !== metadata.digest) {
      await this.recordEvent({
        licenseId: grant.claims.licenseId,
        installationId: grant.claims.installationId,
        eventType: "ARTIFACT_DOWNLOAD_FAILED",
        payload: { artifact_id: artifactId, reason: "DIGEST_MISMATCH" },
      });
      return {
        ok: false,
        status: 500,
        error: { code: "ARTIFACT_DIGEST_MISMATCH", message: "Artifact payload corrupted. Digest mismatch." },
      };
    }

    await this.recordEvent({
      licenseId: grant.claims.licenseId,
      installationId: grant.claims.installationId,
      eventType: "ARTIFACT_DOWNLOAD_COMPLETED",
      payload: { artifact_id: artifactId, digest: computedDigest },
    });

    return {
      ok: true,
      status: 200,
      data: {
        metadata,
        stream,
      },
    };
  }
}
