import fs from "fs/promises";
import path from "path";
import crypto from "crypto";

export interface DatabaseClient {
  query<R = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<{ rows: R[]; rowCount?: number }>;
}

export interface ControlPlaneMigrationFile {
  version: string;
  filename: string;
  sql: string;
  checksum: string;
}

export interface MigrationRecord {
  version: string;
  checksum: string;
  applied_at: string;
}

export interface MigrationRunResult {
  appliedCount: number;
  appliedVersions: string[];
  totalMigrations: number;
}

/**
 * Advisory lock ID dedicated specifically to Clientix Control Plane migrations.
 * 64-bit signed integer representation: 8182838485868788
 */
export const CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_ID = "8182838485868788";

/**
 * Computes SHA-256 of normalized migration content.
 */
export function computeMigrationChecksum(sql: string): string {
  // Normalize Windows CRLF to LF so checksum is identical across platforms
  const normalized = sql.replace(/\r\n/g, "\n").trim();
  return crypto.createHash("sha256").update(normalized, "utf-8").digest("hex");
}

/**
 * Reads and sorts all migration SQL files from the migrations directory.
 */
export async function loadControlPlaneMigrations(
  migrationsDir: string
): Promise<ControlPlaneMigrationFile[]> {
  const entries = await fs.readdir(migrationsDir);
  const sqlFiles = entries.filter((f) => f.endsWith(".sql")).sort();

  const migrations: ControlPlaneMigrationFile[] = [];
  for (const filename of sqlFiles) {
    const fullPath = path.join(migrationsDir, filename);
    const sql = await fs.readFile(fullPath, "utf-8");
    const version = filename.replace(/\.sql$/, "");
    const checksum = computeMigrationChecksum(sql);
    migrations.push({
      version,
      filename,
      sql,
      checksum,
    });
  }

  return migrations;
}

/**
 * Ensures the schema_migrations table exists inside the control_plane schema.
 */
export async function ensureMigrationTable(client: DatabaseClient): Promise<void> {
  await client.query(`create schema if not exists control_plane;`);
  await client.query(`
    create table if not exists control_plane.schema_migrations (
      version text primary key,
      checksum text not null,
      applied_at timestamptz not null default now()
    );
  `);
}

/**
 * Fetches all applied migrations from control_plane.schema_migrations.
 */
export async function getAppliedMigrations(client: DatabaseClient): Promise<Map<string, MigrationRecord>> {
  const res = await client.query<MigrationRecord>(
    `select version, checksum, applied_at from control_plane.schema_migrations order by version asc;`
  );
  const map = new Map<string, MigrationRecord>();
  for (const row of res.rows) {
    map.set(row.version, row);
  }
  return map;
}

/**
 * Executes Control Plane migrations atomically with advisory lock and checksum integrity checks.
 */
export async function runControlPlaneMigrations(
  client: DatabaseClient,
  migrationsDir: string
): Promise<MigrationRunResult> {
  // 1. Acquire advisory lock
  await client.query(`select pg_advisory_lock(${CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_ID});`);

  try {
    // 2. Ensure control_plane.schema_migrations exists
    await ensureMigrationTable(client);

    // 3. Load migration files from disk
    const availableMigrations = await loadControlPlaneMigrations(migrationsDir);

    // 4. Load applied history from database
    const appliedMap = await getAppliedMigrations(client);

    // 5. Verify integrity of previously applied migrations (Checksum Tamper Check)
    for (const migration of availableMigrations) {
      const applied = appliedMap.get(migration.version);
      if (applied) {
        if (applied.checksum !== migration.checksum) {
          throw new Error(
            `Checksum mismatch detected on applied migration "${migration.version}". Database: ${applied.checksum}, Disk: ${migration.checksum}. Aborting to prevent inconsistent state.`
          );
        }
      }
    }

    // 6. Filter pending migrations
    const pending = availableMigrations.filter((m) => !appliedMap.has(m.version));
    const appliedVersions: string[] = [];

    // 7. Apply each pending migration in an explicit transaction
    for (const migration of pending) {
      await client.query("BEGIN;");
      try {
        // Execute migration SQL
        await client.query(migration.sql);

        // Record migration history
        await client.query(
          `insert into control_plane.schema_migrations (version, checksum, applied_at) values ($1, $2, now());`,
          [migration.version, migration.checksum]
        );

        await client.query("COMMIT;");
        appliedVersions.push(migration.version);
      } catch (err) {
        await client.query("ROLLBACK;");
        throw new Error(
          `Failed applying control plane migration "${migration.version}": ${(err as Error).message}`
        );
      }
    }

    return {
      appliedCount: appliedVersions.length,
      appliedVersions,
      totalMigrations: availableMigrations.length,
    };
  } finally {
    // Release advisory lock
    await client.query(`select pg_advisory_unlock(${CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_ID});`);
  }
}
