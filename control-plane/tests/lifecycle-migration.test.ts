import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  __dirname,
  "../migrations/0002_commercial_license_lifecycle.sql",
);
const commercialAdminMigrationPath = path.resolve(
  __dirname,
  "../migrations/0004_vendor_commercial_admin.sql",
);

describe("Control Plane license lifecycle migration contract", () => {
  it("adds commercial licensing state without touching customer schemas", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();

    expect(sql).toContain("alter table control_plane.licensing_customers");
    expect(sql).toContain("alter table control_plane.licensing_licenses");
    expect(sql).toContain("alter table control_plane.licensing_installations");
    expect(sql).toContain("activation_code_id uuid");
    expect(sql).toContain("create table if not exists control_plane.licensing_rate_limit_buckets");
    expect(sql).toContain("create table if not exists control_plane.licensing_admin_operations");
    expect(sql).toContain("status in ('draft', 'active', 'expired', 'suspended', 'revoked')");
    expect(sql).toContain("uq_cp_license_serial");
    expect(sql).not.toContain("public.");
    expect(sql).not.toContain("auth.");
  });

  it("uses row locks and atomic event writes for renewal and transfer", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();

    expect(sql).toContain("create or replace function control_plane.renew_license");
    expect(sql).toContain("for update");
    expect(sql).toContain("license_reissued");
    expect(sql).toContain("create or replace function control_plane.transfer_license_installation");
    expect(sql).toContain("installation_transferred");
    expect(sql).toContain("installation_registered");
    expect(sql).toContain("revoke all on function control_plane.transfer_license_installation");
    expect(sql).toContain("revoke all on control_plane.licensing_rate_limit_buckets from public");
  });
});

describe("Control Plane commercial administration migration contract", () => {
  it("keeps commercial administration in the isolated vendor schema", async () => {
    const sql = (await readFile(commercialAdminMigrationPath, "utf8")).toLowerCase();

    expect(sql).toContain("alter table control_plane.licensing_customers");
    expect(sql).toContain("add column if not exists internal_notes text");
    expect(sql).toContain("create or replace function control_plane.create_license_draft");
    expect(sql).toContain("pg_advisory_xact_lock");
    expect(sql).toContain("idempotency key already used for a different request");
    expect(sql).toContain("create or replace function control_plane.renew_license_with_request_id");
    expect(sql).toContain("expired license renewal basis is required");
    expect(sql).toContain("p_duration_days integer");
    expect(sql).toContain(
      "create or replace function control_plane.transfer_license_installation_with_request_id",
    );
    expect(sql).toContain(
      "create or replace function control_plane.authorize_installation_recovery_with_request_id",
    );
    expect(sql).toContain("clientix.request_id");
    expect(sql).toContain("revoke execute on function control_plane.create_license_draft");
    expect(sql).not.toContain("public.");
    expect(sql).not.toContain("auth.");
    expect(sql).not.toContain("deskcomm-crm");
  });
});
