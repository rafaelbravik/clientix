import crypto from "crypto";
import type {
  ArtifactMetadata,
  ArtifactType,
  ReleaseChannel,
  ReleaseStatus,
  SignedReleaseManifest,
  TargetArchitecture,
  ReleaseManifestPayload,
} from "./distribution-types";
import { type IReleaseManifestSigner } from "./manifest-signer";
import type { ArtifactStoragePublisher, ArtifactStorageReader } from "./artifact-storage";

export interface PublishArtifactInput {
  artifactId: string;
  architecture: TargetArchitecture;
  artifactType: ArtifactType;
  filename: string;
  data: Buffer;
  contentType?: string;
}

export interface PublishReleaseInput {
  releaseId: string;
  version: string;
  channel: ReleaseChannel;
  minSchemaVersion: string;
  maxSchemaVersion?: string;
  requiredMaintenanceDate?: string;
  artifacts: PublishArtifactInput[];
}

export interface ReleaseCatalogIndexItem {
  releaseId: string;
  version: string;
  channel: ReleaseChannel;
  status: ReleaseStatus;
  publishedAt: string;
  minSchemaVersion: string;
  maxSchemaVersion?: string;
  manifestPath: string;
}

export interface ReleaseCatalogIndex {
  catalogVersion: 1;
  updatedAt: string;
  releases: ReleaseCatalogIndexItem[];
}

/**
 * Clientix L9.1.1 — Release Publisher
 *
 * Handles the authorized build/release pipeline publishing flow:
 * 1. Uploads immutable artifacts addressed by SHA-256 digest
 * 2. Assembles manifest payload
 * 3. Signs manifest cryptographically (Ed25519)
 * 4. Uploads signed manifest LAST
 * 5. Updates catalog index (`releases/index.json`)
 *
 * Guarantees Partial Release Safety:
 * If an artifact upload fails midway, the signed manifest is NEVER uploaded,
 * preventing any client or gateway from discovering an incomplete release.
 */
export class ReleasePublisher {
  constructor(
    private readonly storage: ArtifactStoragePublisher & ArtifactStorageReader,
    private readonly manifestSigner: IReleaseManifestSigner,
    private readonly keyPrefix: string = ""
  ) {
    this.keyPrefix = keyPrefix ? keyPrefix.replace(/\/+$/, "") + "/" : "";
  }

  public buildArtifactStorageKey(releaseId: string, artifactId: string, digestHex: string): string {
    return `${this.keyPrefix}releases/${releaseId}/${artifactId}/${digestHex}`;
  }

  public buildManifestStorageKey(releaseId: string): string {
    return `${this.keyPrefix}releases/${releaseId}/manifest.json`;
  }

  public buildIndexStorageKey(): string {
    return `${this.keyPrefix}releases/index.json`;
  }

  /**
   * Publishes a release to object storage following strict publish order:
   * artifacts -> sign -> manifest -> index.
   */
  async publishRelease(input: PublishReleaseInput): Promise<{
    manifest: SignedReleaseManifest;
    artifacts: ArtifactMetadata[];
  }> {
    if (input.artifacts.length === 0) {
      throw new Error(`Cannot publish release "${input.releaseId}" without any artifacts.`);
    }

    const publishedArtifacts: ArtifactMetadata[] = [];
    const nowIso = new Date().toISOString();

    // 1. Upload all artifacts first (immutable content addressing)
    for (const artInput of input.artifacts) {
      const digestHex = crypto.createHash("sha256").update(artInput.data).digest("hex");
      const fullDigest = `sha256:${digestHex}` as `sha256:${string}`;
      const storageKey = this.buildArtifactStorageKey(input.releaseId, artInput.artifactId, digestHex);

      await this.storage.putObject(
        storageKey,
        artInput.data,
        artInput.contentType ?? "application/octet-stream"
      );

      publishedArtifacts.push({
        artifactId: artInput.artifactId,
        releaseId: input.releaseId,
        architecture: artInput.architecture,
        artifactType: artInput.artifactType,
        digest: fullDigest,
        sizeBytes: artInput.data.length,
        filename: artInput.filename,
        createdAt: nowIso,
      });
    }

    // 2. Assemble manifest payload
    const payload: ReleaseManifestPayload = {
      manifestVersion: 1,
      version: input.version,
      channel: input.channel,
      publishedAt: nowIso,
      minSchemaVersion: input.minSchemaVersion,
      maxSchemaVersion: input.maxSchemaVersion,
      artifacts: publishedArtifacts,
    };

    // 3. Cryptographically sign the manifest
    const signedManifest = await this.manifestSigner.signManifest(payload);

    // 4. Upload signed manifest LAST
    const manifestBuffer = Buffer.from(JSON.stringify(signedManifest, null, 2), "utf-8");
    const manifestKey = this.buildManifestStorageKey(input.releaseId);
    await this.storage.putObject(manifestKey, manifestBuffer, "application/json");

    // 5. Update catalog index
    await this.updateCatalogIndex({
      releaseId: input.releaseId,
      version: input.version,
      channel: input.channel,
      status: "PUBLISHED",
      publishedAt: nowIso,
      minSchemaVersion: input.minSchemaVersion,
      maxSchemaVersion: input.maxSchemaVersion,
      manifestPath: manifestKey,
    });

    return {
      manifest: signedManifest,
      artifacts: publishedArtifacts,
    };
  }

  /**
   * Retracts a release by updating catalog metadata.
   * Artifact binaries are preserved for audit and disaster recovery.
   */
  async retractRelease(releaseId: string): Promise<boolean> {
    const indexKey = this.buildIndexStorageKey();
    const indexBuf = await this.storage.getObjectStream(indexKey);
    if (!indexBuf) {
      return false;
    }

    const index: ReleaseCatalogIndex = JSON.parse(indexBuf.toString("utf-8"));
    const entry = index.releases.find((r) => r.releaseId === releaseId);
    if (!entry) {
      return false;
    }

    entry.status = "RETRACTED";
    index.updatedAt = new Date().toISOString();

    if (this.storage.deleteObject) {
      await this.storage.deleteObject(indexKey);
    }
    await this.storage.putObject(
      indexKey,
      Buffer.from(JSON.stringify(index, null, 2), "utf-8"),
      "application/json"
    );

    return true;
  }

  private async updateCatalogIndex(newItem: ReleaseCatalogIndexItem): Promise<void> {
    const indexKey = this.buildIndexStorageKey();
    let index: ReleaseCatalogIndex = {
      catalogVersion: 1,
      updatedAt: new Date().toISOString(),
      releases: [],
    };

    const existingBuf = await this.storage.getObjectStream(indexKey);
    if (existingBuf) {
      try {
        index = JSON.parse(existingBuf.toString("utf-8"));
      } catch {
        // Fallback to fresh index if corrupted
      }
    }

    const existingIndex = index.releases.findIndex((r) => r.releaseId === newItem.releaseId);
    if (existingIndex >= 0) {
      index.releases[existingIndex] = newItem;
    } else {
      index.releases.push(newItem);
    }
    index.updatedAt = new Date().toISOString();

    if (this.storage.deleteObject) {
      await this.storage.deleteObject(indexKey);
    }
    await this.storage.putObject(
      indexKey,
      Buffer.from(JSON.stringify(index, null, 2), "utf-8"),
      "application/json"
    );
  }
}
