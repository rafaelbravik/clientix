import { readFile } from "node:fs/promises";
import path from "node:path";
import { Pool, type PoolClient } from "pg";

import {
  provisionActiveSignerPublicKey,
  type SignerProvisioningDatabase,
} from "../src/signer-key-provisioning";

class PinnedDatabaseClient implements SignerProvisioningDatabase {
  constructor(private readonly client: PoolClient) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount?: number | null }> {
    const result = await this.client.query(sql, params as never[]);
    return { rows: result.rows as R[], rowCount: result.rowCount };
  }
}

async function main(): Promise<void> {
  if (process.env.DESKCOMM_ENV_MODE !== "local") {
    throw new Error("LOCAL_SIGNER_MODE_REQUIRED");
  }

  const keyId = process.env.CONTROL_PLANE_ACTIVE_LICENSE_KEY_ID?.trim() ?? "";
  if (!keyId.startsWith("clientix-certification-test-")) {
    throw new Error("LOCAL_SIGNER_KEY_ID_REQUIRED");
  }

  const databaseUrl = process.env.CONTROL_PLANE_DATABASE_URL ?? "";
  let parsedDatabaseUrl: URL;
  try {
    parsedDatabaseUrl = new URL(databaseUrl);
  } catch {
    throw new Error("LOCAL_CONTROL_PLANE_DATABASE_REQUIRED");
  }
  const databaseName = decodeURIComponent(parsedDatabaseUrl.pathname.slice(1));
  if (
    !["postgres:", "postgresql:"].includes(parsedDatabaseUrl.protocol) ||
    !["127.0.0.1", "localhost", "::1"].includes(parsedDatabaseUrl.hostname) ||
    decodeURIComponent(parsedDatabaseUrl.username) !== "clientix_vendor" ||
    databaseName !== "clientix_control_plane"
  ) {
    throw new Error("LOCAL_CONTROL_PLANE_DATABASE_REQUIRED");
  }

  const signerDirectory = path.resolve(process.cwd(), ".clientix-local", "control-plane");
  const privateKeyPath = path.join(signerDirectory, "license-private.pem");
  const publicKeyPath = path.join(signerDirectory, "license-public.pem");
  const privateKeyPem = await readFile(privateKeyPath, "utf8");
  const configuredPublicKeyPem = await readFile(publicKeyPath, "utf8");
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  let client: PoolClient | undefined;
  try {
    client = await pool.connect();
    const result = await provisionActiveSignerPublicKey(new PinnedDatabaseClient(client), {
      keyId,
      privateKeyPem,
      configuredPublicKeyPem,
    });
    process.stdout.write(`${JSON.stringify({ result, active_signer_key_id: keyId })}\n`);
  } finally {
    client?.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const code =
    error instanceof Error && /^[A-Z0-9_]{1,80}$/.test(error.message)
      ? error.message
      : "LOCAL_SIGNER_PROVISIONING_FAILED";
  process.stderr.write(`${code}\n`);
  process.exitCode = 1;
});
