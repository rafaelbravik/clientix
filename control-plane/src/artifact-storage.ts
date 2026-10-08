import crypto from "crypto";
import fs from "fs";
import path from "path";

/**
 * Clientix L9.1 — Storage Backend & Real Artifact Provider Abstraction
 *
 * Provides immutable, content-addressed artifact persistence and retrieval.
 * Decouples the Distribution Engine from any specific cloud/registry vendor.
 */

export interface StorageObjectMetadata {
  key: string;
  sizeBytes: number;
  digest: `sha256:${string}`;
  contentType?: string;
  lastModified?: Date;
}

export interface ArtifactStorageReader {
  getObjectMetadata(key: string): Promise<StorageObjectMetadata | null>;
  getObjectStream(key: string): Promise<Buffer | null>;
  objectExists(key: string): Promise<boolean>;
}

export interface ArtifactStoragePublisher {
  putObject(key: string, data: Buffer, contentType?: string): Promise<StorageObjectMetadata>;
  deleteObject?(key: string): Promise<boolean>;
}

export interface ArtifactStorageBackend extends ArtifactStorageReader, ArtifactStoragePublisher {
  deleteObject(key: string): Promise<boolean>;
}

/**
 * FilesystemArtifactStorage
 *
 * Local/On-Premise filesystem backend suitable for offline distributions,
 * local development, testing, and isolated VPS environments.
 * Strictly prevents path traversal attacks.
 */
export class FilesystemArtifactStorage implements ArtifactStorageBackend {
  private readonly rootDir: string;

  constructor(rootDir: string) {
    this.rootDir = path.resolve(rootDir);
    if (!fs.existsSync(this.rootDir)) {
      fs.mkdirSync(this.rootDir, { recursive: true });
    }
  }

  private resolveSafePath(key: string): string {
    const safeKey = key.replace(/\\/g, "/");
    const resolved = path.resolve(this.rootDir, safeKey);
    if (!resolved.startsWith(this.rootDir)) {
      throw new Error(`Security Violation: Path traversal detected for key "${key}".`);
    }
    return resolved;
  }

  async getObjectMetadata(key: string): Promise<StorageObjectMetadata | null> {
    const filePath = this.resolveSafePath(key);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const stat = await fs.promises.stat(filePath);
    const content = await fs.promises.readFile(filePath);
    const digest = `sha256:${crypto.createHash("sha256").update(content).digest("hex")}` as `sha256:${string}`;

    return {
      key,
      sizeBytes: stat.size,
      digest,
      lastModified: stat.mtime,
    };
  }

  async getObjectStream(key: string): Promise<Buffer | null> {
    const filePath = this.resolveSafePath(key);
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return fs.promises.readFile(filePath);
  }

  async objectExists(key: string): Promise<boolean> {
    const filePath = this.resolveSafePath(key);
    return fs.existsSync(filePath);
  }

  async putObject(key: string, data: Buffer, contentType?: string): Promise<StorageObjectMetadata> {
    const filePath = this.resolveSafePath(key);
    const newDigest = `sha256:${crypto.createHash("sha256").update(data).digest("hex")}` as `sha256:${string}`;

    if (fs.existsSync(filePath)) {
      const existing = await fs.promises.readFile(filePath);
      const existingDigest = `sha256:${crypto.createHash("sha256").update(existing).digest("hex")}`;
      if (existingDigest === newDigest) {
        const stat = await fs.promises.stat(filePath);
        return {
          key,
          sizeBytes: stat.size,
          digest: newDigest,
          contentType,
          lastModified: stat.mtime,
        };
      }
      throw new Error(
        `IMMUTABLE_OBJECT_CONFLICT: Object already exists at key "${key}" with digest ${existingDigest}, cannot overwrite with different digest ${newDigest}.`
      );
    }

    const dir = path.dirname(filePath);
    if (!fs.existsSync(dir)) {
      await fs.promises.mkdir(dir, { recursive: true });
    }

    await fs.promises.writeFile(filePath, data);

    return {
      key,
      sizeBytes: data.length,
      digest: newDigest,
      contentType,
      lastModified: new Date(),
    };
  }

  async deleteObject(key: string): Promise<boolean> {
    const filePath = this.resolveSafePath(key);
    if (!fs.existsSync(filePath)) {
      return false;
    }
    await fs.promises.unlink(filePath);
    return true;
  }
}

/**
 * MemoryArtifactStorage
 *
 * In-memory storage backend for fast, isolated unit testing without disk I/O.
 */
export class MemoryArtifactStorage implements ArtifactStorageBackend {
  private objects = new Map<string, { data: Buffer; contentType?: string; lastModified: Date }>();

  async getObjectMetadata(key: string): Promise<StorageObjectMetadata | null> {
    const item = this.objects.get(key);
    if (!item) return null;

    const digest = `sha256:${crypto.createHash("sha256").update(item.data).digest("hex")}` as `sha256:${string}`;
    return {
      key,
      sizeBytes: item.data.length,
      digest,
      contentType: item.contentType,
      lastModified: item.lastModified,
    };
  }

  async getObjectStream(key: string): Promise<Buffer | null> {
    const item = this.objects.get(key);
    return item ? Buffer.from(item.data) : null;
  }

  async objectExists(key: string): Promise<boolean> {
    return this.objects.has(key);
  }

  async putObject(key: string, data: Buffer, contentType?: string): Promise<StorageObjectMetadata> {
    const copy = Buffer.from(data);
    const newDigest = `sha256:${crypto.createHash("sha256").update(copy).digest("hex")}` as `sha256:${string}`;

    const existing = this.objects.get(key);
    if (existing) {
      const existingDigest = `sha256:${crypto.createHash("sha256").update(existing.data).digest("hex")}`;
      if (existingDigest === newDigest) {
        return {
          key,
          sizeBytes: existing.data.length,
          digest: newDigest,
          contentType: existing.contentType,
          lastModified: existing.lastModified,
        };
      }
      throw new Error(
        `IMMUTABLE_OBJECT_CONFLICT: Object already exists at key "${key}" with digest ${existingDigest}, cannot overwrite with different digest ${newDigest}.`
      );
    }

    const lastModified = new Date();
    this.objects.set(key, { data: copy, contentType, lastModified });

    return {
      key,
      sizeBytes: copy.length,
      digest: newDigest,
      contentType,
      lastModified,
    };
  }

  async deleteObject(key: string): Promise<boolean> {
    return this.objects.delete(key);
  }
}
