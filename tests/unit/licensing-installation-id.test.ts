import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import path from "path";
import os from "os";
import {
  generateInstallationId,
  isValidInstallationId,
  MemoryInstallationIdStorage,
  FileInstallationIdStorage,
  getOrCreateInstallationId,
} from "@/lib/licensing";

describe("Licensing — Installation ID Generator & Storage", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-inst-test-"));
    tmpFile = path.join(tmpDir, "installation-id");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  });

  it("generates IDs adhering to the inst_<UUID> format", () => {
    const id = generateInstallationId();
    expect(isValidInstallationId(id)).toBe(true);
    expect(id.startsWith("inst_")).toBe(true);
    expect(id.length).toBe(41); // "inst_" (5) + UUID (36)
  });

  it("validates installation IDs correctly", () => {
    expect(isValidInstallationId("inst_123e4567-e89b-42d3-a456-426614174000")).toBe(true);
    expect(isValidInstallationId("inst_123e4567-e89b-12d3-a456-426614174000")).toBe(false);
    expect(isValidInstallationId("123e4567-e89b-12d3-a456-426614174000")).toBe(false);
    expect(isValidInstallationId("inst_not-a-uuid")).toBe(false);
    expect(isValidInstallationId("")).toBe(false);
    expect(isValidInstallationId("inst_")).toBe(false);
  });

  it("MemoryStorage creates ID on first run and returns identical ID subsequently", async () => {
    const storage = new MemoryInstallationIdStorage();
    const id1 = await getOrCreateInstallationId(storage);
    const id2 = await getOrCreateInstallationId(storage);

    expect(isValidInstallationId(id1)).toBe(true);
    expect(id1).toBe(id2);
  });

  it("FileInstallationIdStorage creates persistent ID on disk", async () => {
    const storage = new FileInstallationIdStorage(tmpFile);
    const id1 = await getOrCreateInstallationId(storage);

    expect(isValidInstallationId(id1)).toBe(true);

    // Read file directly from disk
    const diskContent = await fs.readFile(tmpFile, "utf-8");
    expect(diskContent.trim()).toBe(id1);

    // Second access with fresh storage instance
    const storage2 = new FileInstallationIdStorage(tmpFile);
    const id2 = await getOrCreateInstallationId(storage2);
    expect(id2).toBe(id1);
  });

  it("throws explicit error when disk content is corrupted", async () => {
    await fs.writeFile(tmpFile, "corrupted-random-bytes\n", "utf-8");
    const storage = new FileInstallationIdStorage(tmpFile);

    await expect(getOrCreateInstallationId(storage)).rejects.toThrow(
      /Installation ID corrompido/
    );
  });

  it("fails explicitly when persistent file is empty or truncated (corruption protection)", async () => {
    await fs.writeFile(tmpFile, "   \n", "utf-8");
    const storage = new FileInstallationIdStorage(tmpFile);

    await expect(getOrCreateInstallationId(storage)).rejects.toThrow(
      /vazio ou truncado/
    );
  });

  it("handles concurrent in-process getOrCreate calls safely", async () => {
    const storage = new FileInstallationIdStorage(tmpFile);
    const [id1, id2, id3] = await Promise.all([
      getOrCreateInstallationId(storage),
      getOrCreateInstallationId(storage),
      getOrCreateInstallationId(storage),
    ]);

    expect(isValidInstallationId(id1)).toBe(true);
    expect(id1).toBe(id2);
    expect(id2).toBe(id3);
  });

  it("handles concurrent cross-process getOrCreate calls simultaneously", async () => {
    const moduleUrl = (await import("url")).pathToFileURL(
      path.resolve(process.cwd(), "lib/licensing/installation-id.ts")
    ).href;

    const workerScript = `
      import { FileInstallationIdStorage, getOrCreateInstallationId } from "${moduleUrl}";
      async function main() {
        const filePath = process.argv[2];
        const storage = new FileInstallationIdStorage(filePath);
        const id = await getOrCreateInstallationId(storage);
        process.stdout.write(id);
      }
      main().catch(err => {
        process.stderr.write(err.message || String(err));
        process.exit(1);
      });
    `;

    const scriptPath = path.join(tmpDir, "worker.mjs");
    await fs.writeFile(scriptPath, workerScript, "utf-8");

    const { execFile } = await import("child_process");

    const runWorker = () =>
      new Promise<string>((resolve, reject) => {
        execFile(
          process.execPath,
          [scriptPath, tmpFile],
          { cwd: process.cwd() },
          (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout.trim());
          }
        );
      });

    // Execute 4 separate node processes simultaneously
    const results = await Promise.all([runWorker(), runWorker(), runWorker(), runWorker()]);

    expect(results.length).toBe(4);
    const firstId = results[0];
    expect(isValidInstallationId(firstId!)).toBe(true);
    for (const res of results) {
      expect(res).toBe(firstId);
    }

    // Verify file content on disk matches exactly
    const onDisk = (await fs.readFile(tmpFile, "utf-8")).trim();
    expect(onDisk).toBe(firstId);
  });
});
