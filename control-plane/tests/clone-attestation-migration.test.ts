import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const migrationPath = path.resolve(
  __dirname,
  "../migrations/0003_installation_clone_attestation.sql",
);

describe("Control Plane clone-attestation migration contract", () => {
  it("stores only challenge digests, sessions, vendor recovery digests, and clone state", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("licensing_attestation_challenges");
    expect(sql).toContain("challenge_digest");
    expect(sql).toContain("licensing_instance_sessions");
    expect(sql).toContain("licensing_installation_recoveries");
    expect(sql).toContain("code_digest");
    expect(sql).toContain("clone_status");
    expect(sql).toContain("transfer_pending");
    expect(sql).not.toContain("private_key");
    expect(sql).not.toContain("hardware_fingerprint");
    expect(sql).not.toContain("public.");
    expect(sql).not.toContain("auth.");
  });

  it("locks vendor recovery authorization and closes active sessions atomically", async () => {
    const sql = (await readFile(migrationPath, "utf8")).toLowerCase();
    expect(sql).toContain("authorize_installation_recovery");
    expect(sql).toContain("for update");
    expect(sql).toContain("installation_recovery_authorized");
    expect(sql).toContain("instance_session_ended");
    expect(sql).toContain(
      "grant execute on function control_plane.authorize_installation_recovery",
    );
  });
});
