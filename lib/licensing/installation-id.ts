import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import type { InstallationIdStorage } from "./types";

const CANONICAL_INSTALLATION_ID_REGEX = /^inst_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Validates whether a string matches the required `inst_<UUID>` format.
 */
export function isValidInstallationId(id: string): boolean {
  return typeof id === "string" && CANONICAL_INSTALLATION_ID_REGEX.test(id);
}

/**
 * Generates a brand new cryptographically random installation ID in the format `inst_<UUIDv4>`.
 */
export function generateInstallationId(): string {
  return `inst_${crypto.randomUUID()}`;
}

/**
 * In-memory storage implementation of InstallationIdStorage (useful for tests and ephemeral environments).
 */
export class MemoryInstallationIdStorage implements InstallationIdStorage {
  private id: string | null;

  constructor(initialId: string | null = null) {
    this.id = initialId;
  }

  async read(): Promise<string | null> {
    return this.id;
  }

  async write(id: string): Promise<void> {
    this.id = id;
  }
}

/**
 * File-based atomic storage implementation of InstallationIdStorage.
 * Publishes a fully written temporary file with a create-if-absent hard link,
 * so concurrent processes never observe a partially written destination.
 */
export class FileInstallationIdStorage implements InstallationIdStorage {
  private readonly filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
  }

  async read(): Promise<string | null> {
    try {
      const content = await fs.readFile(this.filePath, "utf-8");
      const trimmed = content.trim();
      if (trimmed.length === 0) {
        // Explicit corruption failure: empty persistent file is considered corrupted state
        throw new Error(
          `Arquivo de installation ID está vazio ou truncado ("${this.filePath}"). Possível corrupção de estado persistente.`
        );
      }
      return trimmed;
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        return null;
      }
      throw err;
    }
  }

  /**
   * Publishes an ID only if the destination does not exist.
   *
   * The temporary file is exclusive and lives beside the destination. Its full
   * contents are flushed and the handle is closed before `link` makes the
   * destination visible. Creating a hard link fails atomically when the
   * destination already exists, on both Windows and POSIX filesystems that
   * support hard links. We deliberately do not fall back to a replacing rename
   * or a direct write: either could overwrite a winner or expose partial data.
   */
  async write(id: string): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });
    const temporaryPath = path.join(
      dir,
      `.${path.basename(this.filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`
    );
    let temporaryFileCreated = false;

    try {
      const temporaryFile = await fs.open(temporaryPath, "wx", 0o600);
      temporaryFileCreated = true;

      try {
        await temporaryFile.writeFile(`${id.trim()}\n`, { encoding: "utf-8" });
        await temporaryFile.sync();
      } finally {
        await temporaryFile.close();
      }

      try {
        // link() is an atomic create-if-absent operation because both paths are
        // in the same directory. Unlike rename(), it cannot replace a winner.
        await fs.link(temporaryPath, this.filePath);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
          throw err;
        }
        // Another process published first. The caller reads and validates it.
      }
    } finally {
      if (temporaryFileCreated) {
        try {
          await fs.unlink(temporaryPath);
        } catch (err: unknown) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
            throw err;
          }
        }
      }
    }
  }
}

// In-process serialization lock to guarantee concurrent in-memory callers share the exact same generation promise
const creationLocks = new WeakMap<InstallationIdStorage, Promise<string>>();

/**
 * Retrieves the existing installation ID or creates and persists a new one atomically.
 * Works safely across multiple threads or multiple independent operating system processes.
 * Throws explicit error if existing ID is invalid or corrupted.
 */
export async function getOrCreateInstallationId(storage: InstallationIdStorage): Promise<string> {
  const existing = await storage.read();

  if (existing !== null) {
    if (!isValidInstallationId(existing)) {
      throw new Error(
        `Installation ID corrompido ou em formato inválido encontrado no storage: "${existing}"`
      );
    }
    return existing;
  }

  // In-process promise deduplication
  const existingPromise = creationLocks.get(storage);
  if (existingPromise) {
    return existingPromise;
  }

  const creationPromise = (async () => {
    try {
      // Re-read in case of prior completion
      const recheck = await storage.read();
      if (recheck !== null) {
        if (!isValidInstallationId(recheck)) {
          throw new Error(
            `Installation ID corrompido ou em formato inválido encontrado no storage: "${recheck}"`
          );
        }
        return recheck;
      }

      const newId = generateInstallationId();
      await storage.write(newId);

      // Read back the confirmed value (which will be ours, or the winning process's)
      const confirmed = await storage.read();
      if (confirmed && isValidInstallationId(confirmed)) {
        return confirmed;
      }

      throw new Error("Falha ao persistir ou confirmar o Installation ID após escrita atômica.");
    } finally {
      creationLocks.delete(storage);
    }
  })();

  creationLocks.set(storage, creationPromise);
  return creationPromise;
}
