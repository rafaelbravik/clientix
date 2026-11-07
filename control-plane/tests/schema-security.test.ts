import { describe, it, expect, beforeAll } from "vitest";
import fs from "fs/promises";
import path from "path";

describe("L8.1E Control Plane Schema Constraints & Security Contract Verification", () => {
  const migrationPath = path.resolve(__dirname, "../migrations/0001_initial_control_plane.sql");

  let migrationSql: string;

  beforeAll(async () => {
    migrationSql = await fs.readFile(migrationPath, "utf-8");
  });

  it("qualifies all entities strictly under schema control_plane", () => {
    expect(migrationSql).toContain("create schema if not exists control_plane;");
    expect(migrationSql).toContain(
      "create table if not exists control_plane.licensing_signer_keys",
    );
    expect(migrationSql).toContain("create table if not exists control_plane.licensing_customers");
    expect(migrationSql).toContain("create table if not exists control_plane.licensing_licenses");
    expect(migrationSql).toContain(
      "create table if not exists control_plane.licensing_activation_codes",
    );
    expect(migrationSql).toContain(
      "create table if not exists control_plane.licensing_installations",
    );
    expect(migrationSql).toContain("create table if not exists control_plane.licensing_nonces");
    expect(migrationSql).toContain("create table if not exists control_plane.licensing_events");
  });

  it("enforces canonical installation_id TEXT check constraint", () => {
    expect(migrationSql).toContain(
      "constraint ck_canonical_installation_id check (id ~* '^inst_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$')",
    );
  });

  it("enforces strict license admin status model without temporal drift states", () => {
    expect(migrationSql).toContain(
      "status text not null check (status in ('ACTIVE', 'SUSPENDED', 'REVOKED'))",
    );
    expect(migrationSql).not.toContain("'EXPIRED'");
    expect(migrationSql).not.toContain("'GRACE'");
    expect(migrationSql).not.toContain("'NOT_YET_VALID'");
  });

  it("enforces valid_from strictly before expires_at", () => {
    expect(migrationSql).toContain(
      "constraint ck_license_valid_range check (valid_from < expires_at)",
    );
  });

  it("enforces activation code usage invariant (used_count <= max_uses) and on delete restrict", () => {
    expect(migrationSql).toContain(
      "constraint ck_activation_code_usage check (used_count >= 0 and used_count <= max_uses)",
    );
    expect(migrationSql).toContain("on delete restrict");
  });

  it("enforces unique public_key_fingerprint check", () => {
    expect(migrationSql).toContain(
      "public_key_fingerprint text not null unique check (public_key_fingerprint ~* '^[0-9a-f]{64}$')",
    );
  });

  it("revokes all public, anon and authenticated access explicitly", () => {
    expect(migrationSql).toContain("revoke all on schema control_plane from public;");
    expect(migrationSql).toContain("revoke all on all tables in schema control_plane from public;");
    expect(migrationSql).toContain("revoke all on schema control_plane from anon");
    expect(migrationSql).toContain("revoke all on schema control_plane from authenticated");
  });

  it("enforces event immutability on licensing_events", () => {
    expect(migrationSql).toContain(
      "revoke update, delete on control_plane.licensing_events from clientix_control_plane",
    );
  });

  it("defines secure prune_expired_nonces routine with explicit search_path", () => {
    expect(migrationSql).toContain("create or replace function control_plane.prune_expired_nonces");
    expect(migrationSql).toContain("set search_path = control_plane, pg_catalog, pg_temp");
  });
});
