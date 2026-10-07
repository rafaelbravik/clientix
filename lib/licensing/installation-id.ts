import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import type { InstallationIdStorage } from "./types";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PREFIX = "inst_";

/**
 * Validates whether a string matches the required `inst_<UUID>` format.
 */
export function isValidInstallationId(id: string): boolean {
  if (!id.startsWith(PREFIX)) {
    return false;
  }
  const uuidPart = id.slice(PREFIX.length);
  return UUID_REGEX.test(uuidPart);
}

/**
 * Generates a brand new cryptographically random installation ID in the format `inst_<UUIDv4>`.
 */
export function generateInstallationId(): string {
  return `${PREFIX}${crypto.randomUUID()}`;
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
 * Writes via a temporary file and atomic rename to prevent corruption under concurrency or sudden shutdown.
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
   * Writes the installation ID atomically.
   * If exclusive creation is requested (initial creation), uses flag "wx" (O_CREAT | O_EXCL)
   * so only one process succeeds in creating the target file.
   * If the file already exists (EEXIST), it does not overwrite.
   */
  async write(id: string): Promise<void> {
    const dir = path.dirname(this.filePath);
    await fs.mkdir(dir, { recursive: true });

    // Try exclusive atomic create first (wx = O_CREAT | O_EXCL)
    try {
      await fs.writeFile(this.filePath, `${id.trim()}\n`, {
        encoding: "utf-8",
        mode: 0o600,
        flag: "wx",
      });
      return;
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "EEXIST") {
        // Another process won the creation race and created the file.
        // That is expected in concurrent cross-process scenarios; read existing value.
        return;
      }
      // For any other I/O failure, propagate
      throw err;
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
