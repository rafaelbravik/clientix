import crypto from "crypto";
import type {
  DistributionGrant,
  ArtifactMetadata,
  SignedReleaseManifest,
  ReleaseMetadata,
} from "./distribution-types";
import { type IReleaseManifestSigner } from "./manifest-signer";
import type { DistributionGrantStore, ConsumeArtifactResult } from "./redis-grant-store";

export interface DistributionProvider {
  getRelease(releaseId: string): Promise<ReleaseMetadata | null>;
  getManifest(releaseId: string): Promise<SignedReleaseManifest | null>;
  getArtifactMetadata(artifactId: string): Promise<ArtifactMetadata | null>;
  readArtifactStream(artifactId: string): Promise<Buffer | null>;
}

export type GrantStore = DistributionGrantStore;

/**
 * MemoryGrantStore — TEST_ONLY / LOCAL_ONLY
 *
 * NOT FOR PRODUCTION USE.
 * Production must configure RedisGrantStore (Shared Redis/Upstash).
 * In NODE_ENV=production, DistributionService fails closed if an in-memory store is provided.
 */
export class MemoryGrantStore implements DistributionGrantStore {
  public readonly isTestOnly = true;
  private grantsByHash = new Map<string, DistributionGrant>();
  private grantIdToHash = new Map<string, string>();
  private revokedGrantIds = new Set<string>();
  private lockPromise: Promise<void> = Promise.resolve();

  private hashToken(token: string): string {
    return crypto.createHash("sha256").update(token, "utf-8").digest("hex");
  }

  private async withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    let release!: () => void;
    const nextLock = new Promise<void>((res) => {
      release = res;
    });
    const prevLock = this.lockPromise;
    this.lockPromise = nextLock;

    await prevLock;
    try {
      return await fn();
    } finally {
      release();
    }
  }

  async createGrant(grant: DistributionGrant, _ttlSeconds?: number): Promise<void> {
    await this.withLock(() => {
      this.grantsByHash.set(grant.tokenHash, grant);
      this.grantIdToHash.set(grant.grantId, grant.tokenHash);
    });
  }

  async saveGrant(grant: DistributionGrant): Promise<void> {
    return this.createGrant(grant);
  }

  async revokeGrant(grantId: string): Promise<void> {
    await this.withLock(() => {
      this.revokedGrantIds.add(grantId);
      const tokenHash = this.grantIdToHash.get(grantId);
      if (tokenHash) {
        this.grantsByHash.delete(tokenHash);
      }
    });
  }

  async isRevoked(grantId: string): Promise<boolean> {
    return this.withLock(() => this.revokedGrantIds.has(grantId));
  }

  async getGrant(tokenHash: string): Promise<DistributionGrant | null> {
    return this.withLock(() => {
      const grant = this.grantsByHash.get(tokenHash);
      if (!grant) return null;
      if (this.revokedGrantIds.has(grant.grantId)) return null;
      return grant;
    });
  }

  async getGrantByToken(token: string): Promise<DistributionGrant | null> {
    const hash = this.hashToken(token);
    return this.getGrant(hash);
  }

  async consumeArtifactUse(
    tokenHash: string,
    artifactId: string,
    currentUnixSeconds: number
  ): Promise<ConsumeArtifactResult> {
    return this.withLock(() => {
      const grant = this.grantsByHash.get(tokenHash);
      if (!grant) {
        return { allowed: false, code: "GRANT_NOT_FOUND", reason: "Distribution grant not found." };
      }

      if (this.revokedGrantIds.has(grant.grantId)) {
        return { allowed: false, code: "GRANT_REVOKED", reason: "Distribution grant revoked." };
      }

      if (grant.claims.expiresAt <= currentUnixSeconds) {
        return { allowed: false, code: "GRANT_EXPIRED", reason: "Distribution grant expired." };
      }

      if (!grant.claims.allowedArtifactIds.includes(artifactId)) {
        return { allowed: false, code: "ARTIFACT_NOT_ALLOWED", reason: "Artifact not allowed for this grant." };
      }

      const currentCount = grant.remainingUses.get(artifactId);
      if (currentCount === undefined || currentCount <= 0) {
        return {
          allowed: false,
          code: "ARTIFACT_GRANT_EXHAUSTED",
          reason: "Download attempt quota exhausted for this artifact grant.",
        };
      }

      grant.remainingUses.set(artifactId, currentCount - 1);
      return { allowed: true, code: "OK" };
    });
  }

  async consumeArtifactDownload(token: string, artifactId: string): Promise<{ allowed: boolean; reason?: string }> {
    const hash = this.hashToken(token);
    const res = await this.consumeArtifactUse(hash, artifactId, Math.floor(Date.now() / 1000));
    return { allowed: res.allowed, reason: res.code ?? res.reason };
  }
}

export class LocalFakeDistributionProvider implements DistributionProvider {
  private releases = new Map<string, ReleaseMetadata>();
  private artifactPayloads = new Map<string, Buffer>();

  constructor(private readonly manifestSigner: IReleaseManifestSigner) {}

  addRelease(release: ReleaseMetadata, payloads: Record<string, Buffer>): void {
    this.releases.set(release.releaseId, release);
    for (const [artId, buf] of Object.entries(payloads)) {
      this.artifactPayloads.set(artId, buf);
    }
  }

  async getRelease(releaseId: string): Promise<ReleaseMetadata | null> {
    return this.releases.get(releaseId) || null;
  }

  async getManifest(releaseId: string): Promise<SignedReleaseManifest | null> {
    const rel = this.releases.get(releaseId);
    if (!rel) return null;

    return this.manifestSigner.signManifest({
      manifestVersion: 1,
      version: rel.version,
      channel: rel.channel,
      publishedAt: rel.publishedAt,
      minSchemaVersion: rel.minSchemaVersion,
      maxSchemaVersion: rel.maxSchemaVersion,
      artifacts: rel.artifacts,
    });
  }

  async getArtifactMetadata(artifactId: string): Promise<ArtifactMetadata | null> {
    for (const rel of this.releases.values()) {
      const found = rel.artifacts.find((a) => a.artifactId === artifactId);
      if (found) return found;
    }
    return null;
  }

  async readArtifactStream(artifactId: string): Promise<Buffer | null> {
    const buf = this.artifactPayloads.get(artifactId);
    return buf || null;
  }
}
