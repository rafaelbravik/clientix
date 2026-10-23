import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fork, type ChildProcess } from "child_process";
import { once } from "events";
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

type InstallationIdWorkerMessage =
  | { type: "ready" }
  | { type: "read"; attempt: number; exists: boolean }
  | { type: "legacy-empty-file-visible" }
  | { type: "result"; id: string }
  | { type: "error"; message: string };

function receiveWorkerMessage(child: ChildProcess): Promise<InstallationIdWorkerMessage> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      child.removeListener("message", onMessage);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
    };
    const onMessage = (value: unknown) => {
      cleanup();
      resolve(value as InstallationIdWorkerMessage);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(new Error(`Worker exited before IPC response (code=${code}, signal=${signal}).`));
    };

    child.once("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
  });
}

async function waitForWorkerMessage(
  child: ChildProcess,
  expectedType: "ready" | "read" | "result"
): Promise<InstallationIdWorkerMessage> {
  while (true) {
    const message = await receiveWorkerMessage(child);
    if (message.type === "error" || message.type === expectedType) {
      return message;
    }
  }
}

async function sendWorkers(children: ChildProcess[], command: string): Promise<void> {
  await Promise.all(
    children.map(
      (child) =>
        new Promise<void>((resolve, reject) => {
          child.send(command, (error) => (error ? reject(error) : resolve()));
        })
    )
  );
}

async function stopWorkers(children: ChildProcess[]): Promise<void> {
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill();
    }
  }

  await Promise.all(
    children.map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        return;
      }

      await once(child, "exit").catch(() => undefined);
    })
  );
}

describe("Licensing — Installation ID Generator & Storage", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-inst-test-"));
    tmpFile = path.join(tmpDir, "installation-id");
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
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

    // A later writer cannot replace an already published valid ID.
    await storage2.write(generateInstallationId());
    expect(await storage2.read()).toBe(id1);
  });

  it("creates the parent directory when it does not exist", async () => {
    const nestedFile = path.join(tmpDir, "nested", "state", "installation-id");
    const storage = new FileInstallationIdStorage(nestedFile);

    const id = await getOrCreateInstallationId(storage);

    expect(isValidInstallationId(id)).toBe(true);
    expect((await fs.readFile(nestedFile, "utf-8")).trim()).toBe(id);
  });

  it("throws explicit error when disk content is corrupted", async () => {
    await fs.writeFile(tmpFile, "corrupted-random-bytes\n", "utf-8");
    const storage = new FileInstallationIdStorage(tmpFile);

    await expect(getOrCreateInstallationId(storage)).rejects.toThrow(
      /Installation ID corrompido/
    );
    expect(await fs.readFile(tmpFile, "utf-8")).toBe("corrupted-random-bytes\n");
  });

  it("fails explicitly when persistent file is empty or truncated (corruption protection)", async () => {
    await fs.writeFile(tmpFile, "   \n", "utf-8");
    const storage = new FileInstallationIdStorage(tmpFile);

    await expect(getOrCreateInstallationId(storage)).rejects.toThrow(
      /vazio ou truncado/
    );
    expect(await fs.readFile(tmpFile, "utf-8")).toBe("   \n");
  });

  it("propagates filesystem errors without replacing the existing path", async () => {
    await fs.mkdir(tmpFile);
    const storage = new FileInstallationIdStorage(tmpFile);

    await expect(getOrCreateInstallationId(storage)).rejects.toThrow();
    expect((await fs.stat(tmpFile)).isDirectory()).toBe(true);
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

  it("shares one complete ID across synchronized cross-process creation rounds", async () => {
    const moduleUrl = (await import("url")).pathToFileURL(
      path.resolve(process.cwd(), "lib/licensing/installation-id.ts")
    ).href;

    const workerScript = `
      import { FileInstallationIdStorage, getOrCreateInstallationId } from "${moduleUrl}";
      import fs from "fs/promises";
      import path from "path";
      const filePath = process.argv[2];
      const send = (message) => new Promise((resolve, reject) => {
        if (!process.send) return reject(new Error("Worker IPC is unavailable."));
        process.send(message, (error) => error ? reject(error) : resolve());
      });
      const waitForCommand = (expected) => new Promise((resolve) => {
        const listener = (command) => {
          if (command === expected) {
            process.removeListener("message", listener);
            resolve();
          }
        };
        process.on("message", listener);
      });

      const storage = new FileInstallationIdStorage(filePath);
      const originalWriteFile = fs.writeFile.bind(fs);
      fs.writeFile = async (target, data, options = {}) => {
        if (path.resolve(String(target)) === path.resolve(filePath) && options.flag === "wx") {
          const temporaryLegacyWriter = await fs.open(target, "wx", options.mode);
          const release = waitForCommand("finish-legacy-write");
          await send({ type: "legacy-empty-file-visible" });
          await release;
          try {
            await temporaryLegacyWriter.writeFile(data, { encoding: options.encoding || "utf-8" });
          } finally {
            await temporaryLegacyWriter.close();
          }
          return;
        }
        return originalWriteFile(target, data, options);
      };

      let coordinatedReads = 0;
      const coordinatedStorage = {
        read: async () => {
          const value = await storage.read();
          if (coordinatedReads < 2) {
            const attempt = ++coordinatedReads;
            const release = waitForCommand("continue-" + attempt);
            await send({ type: "read", attempt, exists: value !== null });
            await release;
          }
          return value;
        },
        write: (id) => storage.write(id),
      };

      process.once("message", async (command) => {
        try {
          if (command !== "start") throw new Error("Unexpected worker command.");
          const id = await getOrCreateInstallationId(coordinatedStorage);
          await send({ type: "result", id });
        } catch (error) {
          await send({ type: "error", message: error?.message || String(error) });
          process.exitCode = 1;
        } finally {
          process.disconnect();
        }
      });

      send({ type: "ready" }).catch((error) => {
        process.stderr.write(error?.message || String(error));
        process.exitCode = 1;
        process.disconnect();
      });
    `;

    const scriptPath = path.join(tmpDir, "worker.mjs");
    await fs.writeFile(scriptPath, workerScript, "utf-8");

    // Do not pass unrelated parent environment variables to subprocesses.
    const workerEnv: NodeJS.ProcessEnv = { NODE_ENV: "test" };
    for (const key of ["PATH", "SystemRoot", "WINDIR", "TEMP", "TMP"]) {
      const value = process.env[key];
      if (value !== undefined) workerEnv[key] = value;
    }

    const workerCount = 6;
    const rounds = 2;

    for (let round = 1; round <= rounds; round += 1) {
      const roundDir = path.join(tmpDir, `round-${round}`);
      const filePath = path.join(roundDir, "installation-id");
      const children: ChildProcess[] = [];

      try {
        for (let worker = 0; worker < workerCount; worker += 1) {
          children.push(
            fork(scriptPath, [filePath], {
              cwd: process.cwd(),
              env: workerEnv,
              stdio: ["ignore", "ignore", "ignore", "ipc"],
            })
          );
        }

        // Synchronize every process before it reads the missing destination.
        const readyMessages = await Promise.all(
          children.map((child) => waitForWorkerMessage(child, "ready"))
        );
        expect(readyMessages.every((message) => message.type === "ready")).toBe(true);

        const initialReadMessages = children.map((child) => waitForWorkerMessage(child, "read"));
        await sendWorkers(children, "start");
        const initialReads = await Promise.all(initialReadMessages);
        expect(
          initialReads.every(
            (message) => message.type === "read" && message.attempt === 1 && !message.exists
          )
        ).toBe(true);

        const recheckMessages = children.map((child) => waitForWorkerMessage(child, "read"));
        await sendWorkers(children, "continue-1");
        const rechecks = await Promise.all(recheckMessages);
        expect(
          rechecks.every(
            (message) => message.type === "read" && message.attempt === 2 && !message.exists
          )
        ).toBe(true);

        let legacyEmptyPublicationCount = 0;
        let legacyWriterReleased = false;
        for (const child of children) {
          child.on("message", (message: InstallationIdWorkerMessage) => {
            if (message.type === "legacy-empty-file-visible") {
              legacyEmptyPublicationCount += 1;
            }
            if (message.type === "error" && !legacyWriterReleased) {
              legacyWriterReleased = true;
              for (const worker of children) {
                if (worker.connected) worker.send("finish-legacy-write", () => undefined);
              }
            }
          });
        }

        const resultMessages = children.map((child) => waitForWorkerMessage(child, "result"));
        await sendWorkers(children, "continue-2");

        const messages = await Promise.all(resultMessages);
        const workerErrors = messages.filter(
          (message): message is Extract<InstallationIdWorkerMessage, { type: "error" }> =>
            message.type === "error"
        );
        expect(workerErrors).toEqual([]);

        const ids = messages.map((message) => {
          if (message.type !== "result") {
            throw new Error(`Unexpected worker response: ${message.type}`);
          }
          return message.id;
        });

        expect(ids).toHaveLength(workerCount);
        expect(ids.every(isValidInstallationId)).toBe(true);
        expect(new Set(ids).size).toBe(1);
        expect(legacyEmptyPublicationCount).toBe(0);

        const id = ids[0]!;
        expect(await fs.readFile(filePath, "utf-8")).toBe(`${id}\n`);
        expect(await fs.readdir(roundDir)).toEqual(["installation-id"]);

        const exitCodes = await Promise.all(
          children.map(async (child) => {
            if (child.exitCode !== null) return child.exitCode;
            const [code] = await once(child, "exit");
            return code;
          })
        );
        expect(exitCodes).toEqual(Array(workerCount).fill(0));
      } finally {
        await stopWorkers(children);
      }
    }
  });
});
