import crypto from "crypto";
import fs from "fs";
import path from "path";

export interface InstallerVerifyParams {
  tempFilePath: string;
  targetFilePath: string;
  expectedSizeBytes: number;
  expectedDigest: `sha256:${string}`;
}

export interface InstallerVerifyResult {
  ok: boolean;
  code?: "SIZE_MISMATCH" | "DIGEST_MISMATCH" | "FILE_MISSING";
  installedPath?: string;
  actualSizeBytes?: number;
  actualDigest?: string;
}

/**
 * Clientix L9.1.1 — Installer Verification Contract
 *
 * Enforces atomic download and strict verification:
 * 1. Writes payload to a temporary file (.tmp.part)
 * 2. Compares byte size against signed manifest sizeBytes
 * 3. Computes full SHA-256 digest and verifies against signed manifest digest
 * 4. Only if BOTH match: atomically promotes/renames temp file to target path
 * 5. If ANY check fails: aborts and unlinks temp file; target installation remains untouched.
 */
export class InstallerArtifactVerifier {
  public static async verifyAndPromote(
    params: InstallerVerifyParams,
  ): Promise<InstallerVerifyResult> {
    const { tempFilePath, targetFilePath, expectedSizeBytes, expectedDigest } = params;

    if (!fs.existsSync(tempFilePath)) {
      return { ok: false, code: "FILE_MISSING" };
    }

    try {
      // 1. Verify exact byte size
      const stat = await fs.promises.stat(tempFilePath);
      if (stat.size !== expectedSizeBytes) {
        await fs.promises.unlink(tempFilePath).catch(() => {});
        return {
          ok: false,
          code: "SIZE_MISMATCH",
          actualSizeBytes: stat.size,
        };
      }

      // 2. Verify full SHA-256 digest
      const content = await fs.promises.readFile(tempFilePath);
      const computedDigest = `sha256:${crypto.createHash("sha256").update(content).digest("hex")}`;
      if (computedDigest !== expectedDigest) {
        await fs.promises.unlink(tempFilePath).catch(() => {});
        return {
          ok: false,
          code: "DIGEST_MISMATCH",
          actualDigest: computedDigest,
        };
      }

      // 3. Atomically promote temp file to target destination
      const targetDir = path.dirname(targetFilePath);
      if (!fs.existsSync(targetDir)) {
        await fs.promises.mkdir(targetDir, { recursive: true });
      }

      await fs.promises.rename(tempFilePath, targetFilePath);

      return {
        ok: true,
        installedPath: targetFilePath,
        actualSizeBytes: stat.size,
        actualDigest: computedDigest,
      };
    } catch (err) {
      await fs.promises.unlink(tempFilePath).catch(() => {});
      throw err;
    }
  }
}
