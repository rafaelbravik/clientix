import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  compareSemVer,
  evaluateSchemaCompatibility,
} from "../../distribution/installer/verify-release-manifest.mjs";

const require = createRequire(import.meta.url);
const { deriveCurrentSchema } = require("../../scripts/migrator/clientix-migrator.js");

describe("signed installer compatibility contract", () => {
  it("compares SemVer core and prerelease precedence numerically", () => {
    expect(compareSemVer("1.0.0", "1.0.0")).toBe(0);
    expect(compareSemVer("1.0.1", "1.0.0")).toBeGreaterThan(0);
    expect(compareSemVer("1.0.0", "1.1.0")).toBeLessThan(0);
    expect(compareSemVer("1.10.0", "1.9.0")).toBeGreaterThan(0);
    expect(compareSemVer("1.0.0-alpha", "1.0.0")).toBeLessThan(0);
    expect(compareSemVer("1.0.0-alpha.2", "1.0.0-alpha.10")).toBeLessThan(0);
    expect(compareSemVer("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
    expect(compareSemVer("1.0.0+build.1", "1.0.0+build.2")).toBe(0);
    expect(() => compareSemVer("01.0.0", "1.0.0")).toThrow("INVALID_SEMVER");
  });

  it("allows inclusive schema bounds and rejects source schemas outside them", () => {
    const payload = {
      schema_target: "0520",
      compatibility: { min_schema: "0500", max_schema: "0515" },
    };
    const status = (currentSchema) => ({
      state_type: "TRACKED_INSTALLATION",
      target_baseline: "0520",
      current_schema: currentSchema,
      schema_evidence_valid: true,
    });

    expect(evaluateSchemaCompatibility(payload, status("0500")).allowed).toBe(true);
    expect(evaluateSchemaCompatibility(payload, status("0515")).allowed).toBe(true);
    expect(evaluateSchemaCompatibility(payload, status("0508")).allowed).toBe(true);
    expect(evaluateSchemaCompatibility(payload, status("0499")).reason).toBe("SCHEMA_TOO_OLD_FOR_DIRECT_UPDATE");
    expect(evaluateSchemaCompatibility(payload, status("0516")).reason).toBe("SCHEMA_NEWER_THAN_RELEASE");
    expect(evaluateSchemaCompatibility(payload, { ...status("0508"), target_baseline: "0519" }).reason)
      .toBe("MIGRATOR_SCHEMA_TARGET_MISMATCH");
  });

  it("allows a fresh install without an origin schema and blocks untracked source state", () => {
    const payload = {
      schema_target: "0510",
      compatibility: { min_schema: "0510", max_schema: "0510" },
    };
    expect(evaluateSchemaCompatibility(payload, {
      state_type: "FRESH_DATABASE",
      target_baseline: "0510",
      current_schema: null,
      schema_evidence_valid: true,
    }).allowed).toBe(true);
    expect(evaluateSchemaCompatibility(payload, {
      state_type: "EXISTING_UNTRACKED_INSTALLATION",
      target_baseline: "0510",
      current_schema: null,
      schema_evidence_valid: false,
    }).reason).toBe("CURRENT_SCHEMA_UNAVAILABLE");
  });

  it("derives the current schema from the migrator ledger and fails closed on unknown rows", () => {
    const baselineChecksum = "a".repeat(64);
    const migrationChecksum = "b".repeat(64);
    const manifest = {
      schema_target: "0510",
      baseline: { incorporated_through_sequence: 510, checksum: baselineChecksum },
      migrations: [{ version: "20261006120000", sequence: 511, checksum: migrationChecksum }],
    };
    const trackedState = {
      type: "TRACKED_INSTALLATION",
      applied: [
        { version: "baseline:0510", checksum: baselineChecksum },
        { version: "20261006120000", checksum: migrationChecksum },
      ],
    };

    expect(deriveCurrentSchema(trackedState, manifest)).toMatchObject({ valid: true, currentSchema: "0511" });
    expect(deriveCurrentSchema({ type: "FRESH_DATABASE" }, manifest)).toMatchObject({ valid: true, currentSchema: null });
    expect(deriveCurrentSchema({ type: "EXISTING_UNTRACKED_INSTALLATION" }, manifest).valid).toBe(false);
    expect(deriveCurrentSchema({ type: "TRACKED_INSTALLATION", applied: [] }, manifest).valid).toBe(false);
    expect(deriveCurrentSchema({
      type: "TRACKED_INSTALLATION",
      applied: [...trackedState.applied, { version: "unknown-version", checksum: migrationChecksum }],
    }, manifest).valid).toBe(false);
  });
});
