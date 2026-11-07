import { describe, it, expect } from "vitest";
import path from "path";
import {
  runControlPlaneMigrations,
  loadControlPlaneMigrations,
  CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_ID,
  type DatabaseClient,
} from "../scripts/migrator";

class MockDatabaseClient implements DatabaseClient {
  public executedQueries: { sql: string; params?: unknown[] }[] = [];
  public migrationsTable = new Map<
    string,
    { version: string; checksum: string; applied_at: string }
  >();
  public locks = new Set<string>();
  public inTransaction = false;
  public failOnSqlPattern?: RegExp;

  async query<R = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<{ rows: R[]; rowCount?: number }> {
    this.executedQueries.push({ sql, params });

    const trimmed = sql.trim();

    if (this.failOnSqlPattern && this.failOnSqlPattern.test(sql)) {
      throw new Error(`Simulated database failure matching ${this.failOnSqlPattern}`);
    }

    if (trimmed.startsWith("select pg_advisory_lock")) {
      this.locks.add(CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_ID);
      return { rows: [] };
    }

    if (trimmed.startsWith("select pg_advisory_unlock")) {
      this.locks.delete(CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_ID);
      return { rows: [] };
    }

    if (trimmed === "BEGIN;") {
      this.inTransaction = true;
      return { rows: [] };
    }

    if (trimmed === "COMMIT;") {
      this.inTransaction = false;
      return { rows: [] };
    }

    if (trimmed === "ROLLBACK;") {
      this.inTransaction = false;
      return { rows: [] };
    }

    if (
      trimmed.startsWith(
        "select version, checksum, applied_at from control_plane.schema_migrations",
      )
    ) {
      const rows = Array.from(this.migrationsTable.values()) as unknown as R[];
      return { rows, rowCount: rows.length };
    }

    if (trimmed.startsWith("insert into control_plane.schema_migrations")) {
      const version = params?.[0] as string;
      const checksum = params?.[1] as string;
      this.migrationsTable.set(version, {
        version,
        checksum,
        applied_at: new Date().toISOString(),
      });
      return { rows: [], rowCount: 1 };
    }

    return { rows: [] };
  }
}

describe("L8.1E Control Plane Migration Runner & Schema Certification", () => {
  const realMigrationsDir = path.resolve(__dirname, "../migrations");

  it("loads 0001_initial_control_plane.sql deterministically with valid checksum", async () => {
    const migrations = await loadControlPlaneMigrations(realMigrationsDir);
    expect(migrations.length).toBeGreaterThanOrEqual(1);

    const first = migrations[0]!;
    expect(first.version).toBe("0001_initial_control_plane");
    expect(first.filename).toBe("0001_initial_control_plane.sql");
    expect(first.sql).toContain("create schema if not exists control_plane;");
    expect(first.sql).toContain("create table if not exists control_plane.licensing_licenses");
    expect(first.sql).toContain("create table if not exists control_plane.licensing_installations");
    expect(first.sql).toContain("create table if not exists control_plane.licensing_events");
    expect(first.checksum).toHaveLength(64);
  });

  it("applies migration on first run and is idempotent on second run (0 pending)", async () => {
    const db = new MockDatabaseClient();

    // First run applies the schema, lifecycle, clone protection and commercial admin migrations.
    const res1 = await runControlPlaneMigrations(db, realMigrationsDir);
    expect(res1.appliedCount).toBe(4);
    expect(res1.appliedVersions).toContain("0001_initial_control_plane");
    expect(res1.appliedVersions).toContain("0002_commercial_license_lifecycle");
    expect(res1.appliedVersions).toContain("0003_installation_clone_attestation");
    expect(res1.appliedVersions).toContain("0004_vendor_commercial_admin");
    expect(db.migrationsTable.has("0001_initial_control_plane")).toBe(true);
    expect(db.migrationsTable.has("0002_commercial_license_lifecycle")).toBe(true);
    expect(db.migrationsTable.has("0003_installation_clone_attestation")).toBe(true);
    expect(db.migrationsTable.has("0004_vendor_commercial_admin")).toBe(true);

    // Second run: 0 migrations pending
    const res2 = await runControlPlaneMigrations(db, realMigrationsDir);
    expect(res2.appliedCount).toBe(0);
    expect(res2.appliedVersions).toHaveLength(0);
  });

  it("detects checksum tampering on previously applied migration and aborts fail-closed", async () => {
    const db = new MockDatabaseClient();

    // Pre-record migration in database with a mismatched/corrupted checksum
    db.migrationsTable.set("0001_initial_control_plane", {
      version: "0001_initial_control_plane",
      checksum: "tampered_checksum_000000000000000000000000000000000000000000000000",
      applied_at: new Date().toISOString(),
    });

    await expect(runControlPlaneMigrations(db, realMigrationsDir)).rejects.toThrow(
      /checksum mismatch detected/i,
    );
  });

  it("rolls back transaction cleanly if migration SQL execution fails", async () => {
    const db = new MockDatabaseClient();
    db.failOnSqlPattern = /licensing_customers/i;

    await expect(runControlPlaneMigrations(db, realMigrationsDir)).rejects.toThrow(
      /failed applying control plane migration/i,
    );

    // Database state should NOT record the migration as applied
    expect(db.migrationsTable.size).toBe(0);
    expect(db.inTransaction).toBe(false);
  });

  it("releases advisory lock even if migration fails", async () => {
    const db = new MockDatabaseClient();
    db.failOnSqlPattern = /control_plane/i;

    await expect(runControlPlaneMigrations(db, realMigrationsDir)).rejects.toThrow();
    // Lock must be released in finally block
    expect(db.locks.has(CONTROL_PLANE_MIGRATION_ADVISORY_LOCK_ID)).toBe(false);
  });
});
