import crypto from "crypto";
import type {
  ArtifactMetadata,
  ReleaseMetadata,
  SignedReleaseManifest,
  ReleaseStatus,
} from "./distribution-types";
import { type IReleaseManifestSigner } from "./manifest-signer";
import type { DistributionProvider } from "./distribution-provider";
import type { ArtifactStorageReader } from "./artifact-storage";

/**
 * Clientix L9.1 / L9.1.1 — Real Artifact Provider (Read-Only Gateway)
 *
 * Implements DistributionProvider against any ArtifactStorageReader.
 * Adheres to strict least-privilege: possesses ZERO write capabilities (no put, delete, or overwrite).
 *
 * Source of Truth in production:
 * - Signed release manifest at `releases/${releaseId}/manifest.json`
 * - Release catalog index at `releases/index.json`
 *
 * Endpoints and release metadata are addressed immutably via:
 *   `releases/${releaseId}/${artifactId}/${digest.replace('sha256:', '')}`
 */

export interface RealArtifactProviderOptions {
  storage: ArtifactStorageReader;
  manifestSigner?: IReleaseManifestSigner;
  keyPrefix?: string;
}

export class RealArtifactProvider implements DistributionProvider {
  private readonly storage: ArtifactStorageReader;
  private readonly manifestSigner?: IReleaseManifestSigner;
  private readonly keyPrefix: string;
  private releases = new Map<string, ReleaseMetadata>();

  constructor(options: RealArtifactProviderOptions) {
    this.storage = options.storage;
    this.manifestSigner = options.manifestSigner;
    this.keyPrefix = options.keyPrefix ? options.keyPrefix.replace(/\/+$/, "") + "/" : "";
  }

  /**
   * Builds an immutable, content-addressed storage key:
   * e.g. "releases/rel_v2/art_app/a1b2c3d4..."
   */
  public buildStorageKey(releaseId: string, artifactId: string, digest: string): string {
    const cleanDigest = digest.replace(/^sha256:/, "");
    return `${this.keyPrefix}releases/${releaseId}/${artifactId}/${cleanDigest}`;
  }

  /**
   * Registers a release metadata record in-memory (useful for testing or cache seeding).
   */
  public registerRelease(release: ReleaseMetadata): void {
    this.releases.set(release.releaseId, release);
  }

  /**
   * Resolves release metadata. Checks in-memory cache first, then object storage source of truth.
   */
  async getRelease(releaseId: string): Promise<ReleaseMetadata | null> {
    const cached = this.releases.get(releaseId);
    if (cached) return cached;

    // Load from Object Storage source of truth: `releases/${releaseId}/manifest.json`
    const manifestKey = `${this.keyPrefix}releases/${releaseId}/manifest.json`;
    const manifestBuf = await this.storage.getObjectStream(manifestKey);
    if (!manifestBuf) {
      return null;
    }

    try {
      const manifest: SignedReleaseManifest = JSON.parse(manifestBuf.toString("utf-8"));
      let status: ReleaseStatus = "PUBLISHED";

      // Check catalog index for retraction status
      const indexKey = `${this.keyPrefix}releases/index.json`;
      const indexBuf = await this.storage.getObjectStream(indexKey);
      if (indexBuf) {
        try {
          const index = JSON.parse(indexBuf.toString("utf-8"));
          const entry = Array.isArray(index.releases)
            ? index.releases.find((r: { releaseId: string }) => r.releaseId === releaseId)
            : null;
          if (entry && entry.status === "RETRACTED") {
            status = "RETRACTED";
          }
        } catch {
          // Fallback to published if index parsing fails
        }
      }

      const release: ReleaseMetadata = {
        releaseId,
        version: manifest.payload.version,
        channel: manifest.payload.channel,
        status,
        publishedAt: manifest.payload.publishedAt,
        minSchemaVersion: manifest.payload.minSchemaVersion,
        maxSchemaVersion: manifest.payload.maxSchemaVersion,
        artifacts: manifest.payload.artifacts,
      };

      this.releases.set(releaseId, release);
      return release;
    } catch {
      return null;
    }
  }

  /**
   * Resolves signed release manifest from Object Storage or signs cached release payload.
   */
  async getManifest(releaseId: string): Promise<SignedReleaseManifest | null> {
    // 1. Try reading signed manifest directly from storage
    const manifestKey = `${this.keyPrefix}releases/${releaseId}/manifest.json`;
    const manifestBuf = await this.storage.getObjectStream(manifestKey);
    if (manifestBuf) {
      try {
        return JSON.parse(manifestBuf.toString("utf-8"));
      } catch {
        // Fall through to fallback
      }
    }

    // 2. Fallback: Sign dynamically if manifestSigner was supplied and release is cached
    const rel = await this.getRelease(releaseId);
    if (!rel || !this.manifestSigner) return null;

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
      const art = rel.artifacts.find((a) => a.artifactId === artifactId);
      if (art) return art;
    }
    return null;
  }

  async readArtifactStream(artifactId: string): Promise<Buffer | null> {
    // 1. Locate metadata across registered releases
    let targetArtifact: ArtifactMetadata | null = null;
    let targetReleaseId = "";

    for (const rel of this.releases.values()) {
      const found = rel.artifacts.find((a) => a.artifactId === artifactId);
      if (found) {
        targetArtifact = found;
        targetReleaseId = rel.releaseId;
        break;
      }
    }

    if (!targetArtifact) {
      return null;
    }

    // 2. Fetch using immutable content-addressed storage key
    const storageKey = this.buildStorageKey(targetReleaseId, targetArtifact.artifactId, targetArtifact.digest);
    const buffer = await this.storage.getObjectStream(storageKey);
    if (!buffer) {
      return null;
    }

    // 3. Digest verification
    const computedDigest = `sha256:${crypto.createHash("sha256").update(buffer).digest("hex")}`;
    if (computedDigest !== targetArtifact.digest) {
      throw new Error(
        `Artifact Storage Corruption: Digest mismatch for artifact "${artifactId}". Expected ${targetArtifact.digest}, got ${computedDigest}.`
      );
    }

    return buffer;
  }
}
