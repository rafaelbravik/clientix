import path from "node:path";
import { Pool, type PoolClient } from "pg";

import { resolveControlPlaneConfig } from "../src/admin-service-provider";
import { runControlPlaneMigrations, type DatabaseClient } from "./migrator";

class PinnedDatabaseClient implements DatabaseClient {
  constructor(private readonly client: PoolClient) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: unknown[] = [],
  ): Promise<{ rows: R[]; rowCount?: number }> {
    const result = await this.client.query(sql, params as never[]);
    return { rows: result.rows as R[], rowCount: result.rowCount ?? undefined };
  }
}

async function main(): Promise<void> {
  if (process.env.CONTROL_PLANE_MIGRATIONS_APPROVED !== "yes") {
    throw new Error(
      "Set CONTROL_PLANE_MIGRATIONS_APPROVED=yes to run vendor Control Plane migrations.",
    );
  }

  const { databaseUrl } = resolveControlPlaneConfig(process.env);
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  try {
    const result = await runControlPlaneMigrations(
      new PinnedDatabaseClient(client),
      path.resolve(process.cwd(), "control-plane", "migrations"),
    );
    process.stdout.write(
      `${JSON.stringify({ applied_count: result.appliedCount, applied_versions: result.appliedVersions })}\n`,
    );
  } finally {
    client.release();
    await pool.end();
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`Control Plane migration failed: ${message}\n`);
  process.exitCode = 1;
});
