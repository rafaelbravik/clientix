import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { NAMESPACE_DESTE_REPO } from "./_identidade-deste-repo";

import {
  assertJournalTransition,
  classifyInterruptedUpdate,
  commitReleaseState,
  createReleaseCheckpoint,
  createUpdatePlan,
  readReleaseCheckpoint,
  readUpdateJournal,
  recordCheckpointDatabaseBackup,
  restoreReleaseCheckpoint,
  runUpdateTransaction,
  validateTargetMigrationPlan,
  verifyCheckpointDatabaseBackup,
  writeUpdateJournal,
} from "../../distribution/installer/release-update-transaction.mjs";

const IMAGE_NAMES = ["app", "worker", "scheduler", "voice_agent", "migrator", "caddy"];
const OFFICIAL_KEY_ID = "clientix-release-2026-01";
const REPOSITORIES = Object.fromEntries(IMAGE_NAMES.map((name) => [
  name,
  `${NAMESPACE_DESTE_REPO}/${name === "caddy" ? "clientix-ingress" : `clientix-${name.replaceAll("_", "-")}`}`,
]));
const CURRENT_IMAGES = Object.fromEntries(IMAGE_NAMES.map((name) => [name, `${REPOSITORIES[name]}@sha256:${"a".repeat(64)}`]));
const TARGET_IMAGES = Object.fromEntries(IMAGE_NAMES.map((name) => [name, `${REPOSITORIES[name]}@sha256:${"b".repeat(64)}`]));
const CURRENT_RELEASE = {
  installed_version: "1.70.0",
  release_id: "release-a",
  schema_version: "0516",
  signer_key_id: OFFICIAL_KEY_ID,
};

function manifest(overrides = {}) {
  const result = {
    release_id: "release-b",
    release_version: "1.70.1",
    signer_key_id: OFFICIAL_KEY_ID,
    signature: "signed-fixture-signature",
    schema_target: "0517",
    compatibility: {
      min_schema: "0516",
      max_schema: "0516",
      compatible_previous_apps: ["1.70.0"],
    },
    migration: { strategy: "expand", ids: ["0517_expand_customer_ingress"] },
    rollback: {
      application: true,
      configuration: true,
      database_strategy: "preserve_schema",
      compatible_previous_apps: ["1.70.0"],
    },
    required_backups: ["configuration", "database", "release_state", "image_state"],
    images: TARGET_IMAGES,
    ...overrides,
  };
  return {
    ...result,
    payload_sha256: createHash("sha256").update(JSON.stringify({ release_id: result.release_id })).digest("hex"),
  };
}

function plan(overrides = {}) {
  return createUpdatePlan({
    currentRelease: CURRENT_RELEASE,
    currentImages: CURRENT_IMAGES,
    currentSchema: "0516",
    manifest: manifest(overrides),
    ...overrides.planOptions,
  });
}

function createOperations(overrides = {}) {
  const events = [];
  const operations = {
    verifyManifest: async () => events.push("verify-signature"),
    preflight: async () => events.push("preflight"),
    checkpoint: async () => {
      events.push("checkpoint-database-config-state-images");
      return {
        complete: true,
        database_backup: true,
        configuration: true,
        release_state: true,
        image_state: true,
        database_backup_sha256: "d".repeat(64),
      };
    },
    pullImages: async () => events.push("pull-digests"),
    verifyDigests: async () => events.push("verify-local-digests"),
    applyTargetConfig: async () => events.push("apply-config-b"),
    applyMigrations: async () => { events.push("migrate"); return { schema: "0517" }; },
    startServices: async (images) => events.push(images?.app?.includes("sha256:aaaaaaaa") ? "start-a" : "start-b"),
    checkHealth: async (_updatePlan, options = {}) => {
      events.push(options.rollback || options.current ? "health-a" : "health-b");
      return Object.fromEntries(["app", "worker", "scheduler", "caddy", "database", "redis", "waha", "critical_route", "https"].map((key) => [key, true]));
    },
    commit: async () => events.push("commit-b"),
    restoreConfig: async () => events.push("restore-a-config"),
    recordRolledBackState: async () => events.push("record-a-with-schema-b"),
    inspectSchema: async () => "0517",
    journal: async (entry) => events.push(`journal:${entry.state}`),
    ...overrides,
  };
  return { events, operations };
}

let tempDir = "";
afterEach(async () => {
  if (tempDir) await fs.rm(tempDir, { recursive: true, force: true });
  tempDir = "";
});

describe("release updater preflight plan", () => {
  it("builds a digest-pinned A to B plan and declares previous-app compatibility", () => {
    const result = plan();
    expect(result).toMatchObject({
      source_version: "1.70.0",
      target_version: "1.70.1",
      source_schema: "0516",
      target_schema: "0517",
      rollback_compatible: true,
      database_backup_required: true,
    });
    expect(result.source_images).toEqual(CURRENT_IMAGES);
    expect(result.target_images).toEqual(TARGET_IMAGES);
  });

  it("blocks a downgrade before any update operation", () => {
    expect(() => plan({ release_version: "1.69.9" })).toThrow("RELEASE_DOWNGRADE_BLOCKED");
  });

  it("requires the signed migration IDs to equal the target migrator pending ledger exactly", () => {
    const status = {
      state_type: "TRACKED_INSTALLATION",
      schema_evidence_valid: true,
      target_baseline: "0517",
      pending_migrations: ["0517_expand_customer_ingress.sql"],
    };
    const target = { ...manifest(), migration: { strategy: "expand", ids: ["0517_expand_customer_ingress.sql"] } };
    expect(validateTargetMigrationPlan(status, target).migration_ids).toEqual(["0517_expand_customer_ingress.sql"]);
    expect(() => validateTargetMigrationPlan(status, { ...target, migration: { strategy: "expand", ids: ["another.sql"] } }))
      .toThrow("MIGRATION_PLAN_MISMATCH");
    expect(() => validateTargetMigrationPlan({ ...status, pending_migrations: [] }, target))
      .toThrow("MIGRATION_PLAN_MISMATCH");
    expect(() => validateTargetMigrationPlan({ ...status, pending_migrations: ["0517_expand_customer_ingress.sql", "0517_expand_customer_ingress.sql"] }, target))
      .toThrow("MIGRATION_PLAN_MISMATCH");
  });

  it("allows an already-applied identical release to be handled idempotently", () => {
    const same = createUpdatePlan({
      currentRelease: { installed_version: "1.70.1", release_id: "release-b", signer_key_id: OFFICIAL_KEY_ID },
      currentImages: TARGET_IMAGES,
      currentSchema: "0517",
      manifest: { ...manifest(), schema_target: "0517" },
    });
    expect(same.idempotent).toBe(true);
  });

  it("rejects reuse of a release version with different release identity or digests", () => {
    expect(() => createUpdatePlan({
      currentRelease: { installed_version: "1.70.1", release_id: "release-b", signer_key_id: OFFICIAL_KEY_ID },
      currentImages: CURRENT_IMAGES,
      currentSchema: "0517",
      manifest: { ...manifest(), schema_target: "0517" },
    })).toThrow("RELEASE_VERSION_REUSED");
  });

  it("rejects a mutable tag as image authority", () => {
    const images = { ...TARGET_IMAGES, app: `${REPOSITORIES.app}:1.70.1` };
    expect(() => plan({ images })).toThrow("IMAGE_DIGEST_INVALID_APP");
  });

  it("requires the Clientix ingress repository and an immutable digest", () => {
    expect(plan().target_images.caddy).toBe(TARGET_IMAGES.caddy);

    const mutableIngress = { ...TARGET_IMAGES, caddy: `${REPOSITORIES.caddy}:1.70.1` };
    expect(() => plan({ images: mutableIngress })).toThrow("IMAGE_DIGEST_INVALID_CADDY");

    const untrustedIngress = {
      ...TARGET_IMAGES,
      caddy: `attacker.invalid/clientix-ingress@sha256:${"b".repeat(64)}`,
    };
    expect(() => plan({ images: untrustedIngress })).toThrow("IMAGE_REPOSITORY_UNAUTHORIZED_CADDY");
  });

  it("rejects digest references from unauthorized production repositories", () => {
    const images = { ...TARGET_IMAGES, app: `attacker.invalid/clientix-app@sha256:${"b".repeat(64)}` };
    expect(() => plan({ images })).toThrow("IMAGE_REPOSITORY_UNAUTHORIZED_APP");
  });

  it("accepts only local digest references for an explicitly TEST-signed fixture", () => {
    const testImages = Object.fromEntries(IMAGE_NAMES.map((name) => [name, `localhost:5500/clientix-${name.replaceAll("_", "-")}@sha256:${"c".repeat(64)}`]));
    const testCurrentImages = Object.fromEntries(IMAGE_NAMES.map((name) => [name, `localhost:5500/clientix-${name.replaceAll("_", "-")}@sha256:${"a".repeat(64)}`]));
    const testManifest = {
      ...manifest({ images: testImages, signer_key_id: "clientix-test-release-fixture" }),
    };
    const result = createUpdatePlan({
      currentRelease: { ...CURRENT_RELEASE, signer_key_id: "clientix-test-release-fixture" },
      currentImages: testCurrentImages,
      currentSchema: "0516",
      manifest: testManifest,
      allowTestMode: true,
    });
    expect(result.target_images).toEqual(testImages);
    expect(() => createUpdatePlan({
      currentRelease: CURRENT_RELEASE,
      currentImages: CURRENT_IMAGES,
      currentSchema: "0516",
      manifest: testManifest,
    })).toThrow("RELEASE_SIGNER_UNTRUSTED");
  });

  it("bootstraps a legacy installer state only when explicitly allowed and labels it as digest-pinned, not signed", () => {
    const legacyRelease = { installed_version: "1.70.0", schema_version: "0516" };
    expect(() => createUpdatePlan({
      currentRelease: legacyRelease,
      currentImages: CURRENT_IMAGES,
      currentSchema: "0516",
      manifest: manifest(),
    })).toThrow("CURRENT_RELEASE_SIGNER_UNTRUSTED");
    const result = createUpdatePlan({
      currentRelease: legacyRelease,
      currentImages: CURRENT_IMAGES,
      currentSchema: "0516",
      manifest: manifest(),
      allowLegacySource: true,
    });
    expect(result).toMatchObject({ source_version: "1.70.0", source_authentication: "legacy_digest_pinned" });
  });

  it("blocks schema ranges that do not include the installed schema", () => {
    expect(() => plan({ compatibility: { min_schema: "0517", max_schema: "0517", compatible_previous_apps: ["1.70.0"] } }))
      .toThrow("SCHEMA_COMPATIBILITY_BLOCKED");
  });

  it("requires the source app version in the signed compatibility declaration", () => {
    expect(() => plan({ compatibility: { min_schema: "0516", max_schema: "0516", compatible_previous_apps: [] } }))
      .toThrow("PREVIOUS_APPLICATION_NOT_DECLARED_COMPATIBLE");
  });

  it("requires explicit release ID confirmation for destructive migrations", () => {
    const destructive = {
      migration: { strategy: "irreversible", ids: ["0517_drop_legacy_column"] },
      rollback: { application: false, configuration: true, database_strategy: "operator", compatible_previous_apps: [] },
    };
    expect(() => plan(destructive)).toThrow("IRREVERSIBLE_RELEASE_CONFIRMATION_REQUIRED");
    const confirmed = plan({ ...destructive, planOptions: { confirmIrreversibleReleaseId: "release-b" } });
    expect(confirmed.rollback_compatible).toBe(false);
  });
});

describe("release update transaction and rollback", () => {
  it("verifies signature and creates the full checkpoint before pulling; migrations happen after pull", async () => {
    const { events, operations } = createOperations();
    const result = await runUpdateTransaction(plan(), operations, { transactionId: "tx-release-b-1" });
    expect(result).toMatchObject({ result: "COMMITTED", exit_code: 0, state: "COMMITTED" });
    expect(events.indexOf("verify-signature")).toBeLessThan(events.indexOf("pull-digests"));
    expect(events.indexOf("checkpoint-database-config-state-images")).toBeLessThan(events.indexOf("pull-digests"));
    expect(events.indexOf("verify-local-digests")).toBeLessThan(events.indexOf("migrate"));
    expect(events.indexOf("checkpoint-database-config-state-images")).toBeLessThan(events.indexOf("migrate"));
    expect(events.indexOf("health-b")).toBeLessThan(events.indexOf("commit-b"));
    expect(events.at(-1)).toBe("journal:COMMITTED");
  });

  it("fails closed when backup creation fails before pull", async () => {
    const { events, operations } = createOperations({ checkpoint: async () => { events.push("checkpoint-failed"); throw Object.assign(new Error("synthetic"), { code: "BACKUP_FAILED" }); } });
    const result = await runUpdateTransaction(plan(), operations, { transactionId: "tx-backup-failure" });
    expect(result).toMatchObject({ result: "FAILED_PRE_MIGRATION", error_code: "BACKUP_FAILED" });
    expect(events).not.toContain("pull-digests");
  });

  it("does not migrate after a pull failure", async () => {
    const { events, operations } = createOperations({ pullImages: async () => { events.push("pull-failed"); throw Object.assign(new Error("synthetic"), { code: "PULL_FAILED" }); } });
    const result = await runUpdateTransaction(plan(), operations, { transactionId: "tx-pull-failure" });
    expect(result).toMatchObject({ result: "FAILED_PRE_MIGRATION", error_code: "PULL_FAILED" });
    expect(events).not.toContain("migrate");
  });

  it("detects a pulled digest mismatch before changing config or migrating", async () => {
    const { events, operations } = createOperations({ verifyDigests: async () => { events.push("digest-mismatch"); throw Object.assign(new Error("synthetic"), { code: "IMAGE_DIGEST_MISMATCH" }); } });
    const result = await runUpdateTransaction(plan(), operations, { transactionId: "tx-digest-mismatch" });
    expect(result.error_code).toBe("IMAGE_DIGEST_MISMATCH");
    expect(events).not.toContain("apply-config-b");
    expect(events).not.toContain("migrate");
  });

  it("restores app/config and preserves the expanded schema after an app health failure", async () => {
    let appChecks = 0;
    const { events, operations } = createOperations({
      checkHealth: async (_updatePlan, options = {}) => {
        events.push(options.rollback ? "health-rollback" : "health-update");
        appChecks += 1;
        const gates = Object.fromEntries(["app", "worker", "scheduler", "caddy", "database", "redis", "waha", "critical_route", "https"].map((key) => [key, true]));
        if (!options.rollback && appChecks === 1) gates.app = false;
        return gates;
      },
    });
    const result = await runUpdateTransaction(plan(), operations, { transactionId: "tx-app-health" });
    expect(result).toMatchObject({ result: "ROLLED_BACK", exit_code: 1, schema_after: "0517" });
    expect(events).toContain("restore-a-config");
    expect(events).toContain("start-a");
    expect(events).toContain("record-a-with-schema-b");
    expect(events).not.toContain("commit-b");
  });

  it.each(["worker", "caddy"]) ("rolls back when %s health fails", async (failedGate) => {
    let normalCheck = 0;
    const { events, operations } = createOperations({
      checkHealth: async (_updatePlan, options = {}) => {
        if (options.rollback) events.push("health-rollback");
        else events.push("health-update");
        normalCheck += 1;
        const gates = Object.fromEntries(["app", "worker", "scheduler", "caddy", "database", "redis", "waha", "critical_route", "https"].map((key) => [key, true]));
        if (!options.rollback && normalCheck === 1) gates[failedGate] = false;
        return gates;
      },
    });
    expect((await runUpdateTransaction(plan(), operations, { transactionId: `tx-${failedGate}` })).result).toBe("ROLLED_BACK");
    expect(events).toContain("start-a");
  });

  it("requires operator recovery after a confirmed irreversible migration fails health", async () => {
    const destructive = {
      migration: { strategy: "irreversible", ids: ["0517_drop_legacy_column"] },
      rollback: { application: false, configuration: true, database_strategy: "operator", compatible_previous_apps: [] },
    };
    const confirmedPlan = plan({ ...destructive, planOptions: { confirmIrreversibleReleaseId: "release-b" } });
    const { events, operations } = createOperations({
      checkHealth: async () => Object.fromEntries(["app", "worker", "scheduler", "caddy", "database", "redis", "waha", "critical_route", "https"].map((key) => [key, false])),
    });
    const result = await runUpdateTransaction(confirmedPlan, operations, { transactionId: "tx-irreversible" });
    expect(result.result).toBe("MANUAL_RECOVERY_REQUIRED");
    expect(events).not.toContain("restore-a-config");
    expect(events.at(-1)).toBe("journal:MANUAL_RECOVERY_REQUIRED");
  });

  it("marks recovery manual when schema cannot be proven after migration interruption", async () => {
    const { events, operations } = createOperations({
      applyMigrations: async () => { events.push("migration-interrupted"); throw Object.assign(new Error("synthetic"), { code: "MIGRATION_INTERRUPTED" }); },
      inspectSchema: async () => { throw new Error("unavailable"); },
    });
    const result = await runUpdateTransaction(plan(), operations, { transactionId: "tx-schema-unknown" });
    expect(result.result).toBe("MANUAL_RECOVERY_REQUIRED");
    expect(events).not.toContain("restore-a-config");
  });

  it("does no pull, backup, migration, or state mutation on an idempotent rerun", async () => {
    const { events, operations } = createOperations();
    const samePlan = { ...plan(), idempotent: true };
    const result = await runUpdateTransaction(samePlan, operations, { transactionId: "tx-idempotent" });
    expect(result).toMatchObject({ result: "IDEMPOTENT", exit_code: 0 });
    expect(events).toEqual(["health-a"]);
  });

  it("supports deterministic fault injection without reading an environment variable", async () => {
    const { events, operations } = createOperations();
    const result = await runUpdateTransaction(plan(), operations, {
      transactionId: "tx-fault-injection",
      failAt: async (stage) => {
        if (stage === "pull") throw Object.assign(new Error("synthetic"), { code: "INJECTED_PULL_FAILURE" });
      },
    });
    expect(result.error_code).toBe("INJECTED_PULL_FAILURE");
    expect(events).not.toContain("pull-digests");
    expect(events).not.toContain("migrate");
  });
});

describe("update journal and crash recovery classification", () => {
  it("classifies a pre-migration interruption as safely recoverable", () => {
    expect(classifyInterruptedUpdate({ state: "IMAGES_PULLED" }, plan())).toEqual({ recovery: "SAFE_PRE_MIGRATION_ROLLBACK" });
  });

  it("resumes only with proven compatible schema and otherwise requires intervention", () => {
    expect(classifyInterruptedUpdate({ state: "MIGRATION_STARTED" }, plan(), "0517")).toEqual({
      recovery: "ROLLBACK_APPLICATION_KEEP_SCHEMA",
      schema: "0517",
    });
    expect(classifyInterruptedUpdate({ state: "MIGRATION_STARTED" }, plan(), null).recovery).toBe("OPERATOR_REQUIRED");
  });

  it("enforces legal state transitions", () => {
    expect(() => assertJournalTransition("CHECKPOINT_CREATED", "MIGRATION_STARTED")).toThrow("UPDATE_JOURNAL_TRANSITION_INVALID");
    expect(() => assertJournalTransition("MIGRATION_STARTED", "MIGRATIONS_APPLIED")).not.toThrow();
    expect(() => assertJournalTransition("COMMITTED", "ROLLBACK_IN_PROGRESS")).not.toThrow();
  });

  it("writes an atomic sanitized journal and refuses sensitive field names", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-update-journal-"));
    const event = {
      transaction_id: "tx-journal-safe",
      state: "PREFLIGHT_OK",
      source_version: "1.70.0",
      target_version: "1.70.1",
      source_schema: "0516",
      target_schema: "0517",
      release_id: "release-b",
    };
    writeUpdateJournal(tempDir, event);
    writeUpdateJournal(tempDir, { ...event, state: "CHECKPOINT_CREATED" });
    expect(await readUpdateJournal(tempDir)).toMatchObject({
      state: "CHECKPOINT_CREATED",
      release_id: "release-b",
      events: [{ state: "PREFLIGHT_OK" }, { state: "CHECKPOINT_CREATED" }],
    });
    expect(await fs.readdir(path.join(tempDir, "state"))).toEqual(["update-journal.json"]);
    const journalPath = path.join(tempDir, "state", "update-journal.json");
    const tampered = JSON.parse(await fs.readFile(journalPath, "utf8"));
    tampered.events[0].state = "COMMITTED";
    await fs.writeFile(journalPath, JSON.stringify(tampered));
    expect(() => readUpdateJournal(tempDir)).toThrow("UPDATE_JOURNAL_INVALID");
    await fs.writeFile(journalPath, JSON.stringify(await (async () => {
      const restored = { ...tampered, events: [
        { state: "PREFLIGHT_OK", updated_at: new Date().toISOString() },
        { state: "CHECKPOINT_CREATED", updated_at: new Date().toISOString() },
      ] };
      restored.updated_at = restored.events[1].updated_at;
      return restored;
    })()));
    const separateDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-update-journal-sensitive-"));
    expect(() => writeUpdateJournal(separateDir, { ...event, token_value: "synthetic" }))
      .toThrow("UPDATE_JOURNAL_SENSITIVE_FIELD_FORBIDDEN");
    await fs.rm(separateDir, { recursive: true, force: true });
  });

  it("blocks a new update while an earlier journal is incomplete", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-update-pending-"));
    writeUpdateJournal(tempDir, {
      transaction_id: "tx-pending",
      state: "PREFLIGHT_OK",
      source_version: "1.70.0",
      target_version: "1.70.1",
      source_schema: "0516",
      target_schema: "0517",
    });
    expect(() => writeUpdateJournal(tempDir, {
      transaction_id: "tx-next",
      state: "PREFLIGHT_OK",
      source_version: "1.70.0",
      target_version: "1.70.2",
      source_schema: "0516",
      target_schema: "0518",
    })).toThrow("UPDATE_RECOVERY_REQUIRED");
  });

  it("checkpoints only allowlisted config and image state, validates the DB backup, and restores without .env", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-release-checkpoint-"));
    await fs.mkdir(path.join(tempDir, "state"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "backups"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "state", "release.json"), JSON.stringify(CURRENT_RELEASE));
    await fs.writeFile(path.join(tempDir, "state", "current-release-manifest.json"), JSON.stringify({ release_id: "release-a" }));
    await fs.writeFile(path.join(tempDir, "compose.yaml"), "services: { app: { image: old } }\n");
    await fs.writeFile(path.join(tempDir, ".env"), "CLOUDFLARE_API_TOKEN=SYNTHETIC_TOKEN_MARKER\nAPP_IMAGE=old\n");
    const runtimeConfig = {
      APP_IMAGE: CURRENT_IMAGES.app,
      WORKER_IMAGE: CURRENT_IMAGES.worker,
      SCHEDULER_IMAGE: CURRENT_IMAGES.scheduler,
      VOICE_AGENT_IMAGE: CURRENT_IMAGES.voice_agent,
      MIGRATOR_IMAGE: CURRENT_IMAGES.migrator,
      CADDY_IMAGE: CURRENT_IMAGES.caddy,
      CLIENTIX_ACME_CHALLENGE: "dns",
      CLIENTIX_ACME_DNS_PROVIDER: "cloudflare",
      CLIENTIX_ACME_SECRET_MODE: "external",
      CLIENTIX_CLOUDFLARE_TOKEN_FILE: "/run/secrets/cloudflare-token",
    };
    const verifiedB = { ...manifest(), signer_key_id: "clientix-test-release-fixture", signature: "synthetic-signature" };
    const checkpoint = createReleaseCheckpoint(tempDir, "tx-checkpoint", {
      currentImages: CURRENT_IMAGES,
      runtimeConfig,
      verifiedManifest: verifiedB,
      signedManifest: { keyId: verifiedB.signer_key_id, signature: verifiedB.signature, payload: { release_id: "release-b" } },
      plan: plan(),
      allowTestMode: true,
    });
    expect(checkpoint.complete).toBe(true);
    const dbBackup = path.join(tempDir, "backups", "db.dump");
    await fs.writeFile(dbBackup, "synthetic database backup");
    const databaseBackup = await recordCheckpointDatabaseBackup(tempDir, "tx-checkpoint", {
      path: dbBackup,
      sha256: createHash("sha256").update("synthetic database backup").digest("hex"),
      size_bytes: Buffer.byteLength("synthetic database backup"),
    });
    expect(databaseBackup.database_backup).toBe(true);
    expect(await verifyCheckpointDatabaseBackup(tempDir, "tx-checkpoint")).toMatchObject({ sha256: databaseBackup.sha256 });
    const checkpointRoot = path.join(tempDir, "backups", "releases", "tx-checkpoint");
    const checkpointFiles = [];
    async function list(dir) {
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await list(full);
        else checkpointFiles.push(full);
      }
    }
    await list(checkpointRoot);
    expect(checkpointFiles.some((file) => path.basename(file) === ".env")).toBe(false);
    for (const file of checkpointFiles) expect(await fs.readFile(file, "utf8")).not.toContain("SYNTHETIC_TOKEN_MARKER");
    await fs.writeFile(path.join(tempDir, "compose.yaml"), "services: { app: { image: new } }\n");
    const restored = restoreReleaseCheckpoint(tempDir, "tx-checkpoint", "0517", { allowTestMode: true });
    expect(restored.images).toEqual(CURRENT_IMAGES);
    expect(await fs.readFile(path.join(tempDir, "compose.yaml"), "utf8")).toContain("old");
    expect(JSON.parse(await fs.readFile(path.join(tempDir, "state", "release.json"), "utf8")).schema_version).toBe("0517");
    expect(await fs.readFile(path.join(tempDir, ".env"), "utf8")).toContain("SYNTHETIC_TOKEN_MARKER");
  });

  it("checkpoints an older P1-09 state without inventing a predecessor signature", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-legacy-release-checkpoint-"));
    await fs.mkdir(path.join(tempDir, "state"), { recursive: true });
    await fs.mkdir(path.join(tempDir, "backups"), { recursive: true });
    await fs.writeFile(path.join(tempDir, "state", "release.json"), JSON.stringify({
      installed_version: "1.70.0",
      schema_version: "0516",
      installation_id: "inst_123e4567-e89b-42d3-a456-426614174000",
    }));
    await fs.writeFile(path.join(tempDir, "compose.yaml"), "services: { app: { image: old } }\n");
    const runtimeConfig = {
      APP_IMAGE: CURRENT_IMAGES.app,
      WORKER_IMAGE: CURRENT_IMAGES.worker,
      SCHEDULER_IMAGE: CURRENT_IMAGES.scheduler,
      VOICE_AGENT_IMAGE: CURRENT_IMAGES.voice_agent,
      MIGRATOR_IMAGE: CURRENT_IMAGES.migrator,
      CADDY_IMAGE: CURRENT_IMAGES.caddy,
      CLIENTIX_ACME_CHALLENGE: "direct",
      CLIENTIX_ACME_DNS_PROVIDER: "",
      CLIENTIX_ACME_SECRET_MODE: "external",
      CLIENTIX_CLOUDFLARE_TOKEN_FILE: "",
    };
    const verified = manifest();
    const legacyPlan = createUpdatePlan({
      currentRelease: { installed_version: "1.70.0", schema_version: "0516" },
      currentImages: CURRENT_IMAGES,
      currentSchema: "0516",
      manifest: verified,
      allowLegacySource: true,
    });
    createReleaseCheckpoint(tempDir, "tx-legacy-source", {
      currentImages: CURRENT_IMAGES,
      runtimeConfig,
      verifiedManifest: verified,
      signedManifest: { keyId: OFFICIAL_KEY_ID, signature: verified.signature, payload: { release_id: verified.release_id } },
      plan: legacyPlan,
    });
    const checkpoint = readReleaseCheckpoint(tempDir, "tx-legacy-source");
    expect(checkpoint.legacy_source).toBe(true);
    expect(checkpoint.release_state.signer_key_id).toBeUndefined();
    expect(checkpoint.release_state.current_release_manifest).toBeUndefined();
  });

  it("commits release state only from a verified manifest identity and stores digest authority", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-release-state-"));
    const manifestPath = path.join(tempDir, "release.json");
    const verified = {
      ...manifest(),
      signer_key_id: "clientix-test-release-fixture",
      signature: "synthetic-signature",
    };
    await fs.writeFile(manifestPath, JSON.stringify({
      keyId: verified.signer_key_id,
      signature: verified.signature,
      payload: { release_id: verified.release_id },
    }));
    const state = commitReleaseState(tempDir, manifestPath, verified, {
      installationId: "inst_123e4567-e89b-42d3-a456-426614174000",
      transactionId: "tx-release-b",
      schemaVersion: "0517",
      allowTestMode: true,
    });
    expect(state.images).toEqual(TARGET_IMAGES);
    expect(state.update_checkpoint_id).toBe("tx-release-b");
    expect(JSON.parse(await fs.readFile(path.join(tempDir, "state", "release.json"), "utf8")).installed_version)
      .toBe("1.70.1");
  });

  it("rejects a post-verification manifest payload change even when key ID, signature, and release ID remain", async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clientix-release-state-tamper-"));
    const manifestPath = path.join(tempDir, "release.json");
    const verified = {
      ...manifest(),
      signer_key_id: "clientix-test-release-fixture",
      signature: "synthetic-signature",
    };
    await fs.writeFile(manifestPath, JSON.stringify({
      keyId: verified.signer_key_id,
      signature: verified.signature,
      payload: { release_id: verified.release_id, release_version: "1.99.0" },
    }));
    expect(() => commitReleaseState(tempDir, manifestPath, verified, {
      installationId: "inst_123e4567-e89b-42d3-a456-426614174000",
      schemaVersion: "0517",
      allowTestMode: true,
    })).toThrow("SIGNED_MANIFEST_CHANGED_AFTER_VERIFY");
  });

  it("keeps the CLI sequence fail-closed: signed manifest before pull, backup before migration, health before release commit", async () => {
    const source = await fs.readFile(path.resolve("distribution/installer/install.sh"), "utf8");
    const start = source.indexOf("cmd_update() {");
    const end = source.indexOf("\nhandle_rollback_exit() {", start);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const body = source.slice(start, end);
    const position = (text) => body.indexOf(text);
    expect(position("validate_manifest")).toBeLessThan(position("ensure_target_images"));
    expect(position("create_update_checkpoint")).toBeLessThan(position("run_backup"));
    expect(position("run_backup")).toBeLessThan(position("ensure_target_images"));
    expect(position("ensure_target_images")).toBeLessThan(position("run_migrator update --backup-ack"));
    expect(position("run_migrator update --backup-ack")).toBeLessThan(position("compose up -d"));
    expect(position("validate_target_migration_plan")).toBeLessThan(position("run_migrator update --backup-ack"));
    expect(position("check_health 300")).toBeLessThan(position("commit-state"));
    expect(position("check_health 45")).toBeLessThan(position("commit-state"));
    expect(position("commit-state")).toBeLessThan(position("write_update_journal COMMITTED"));
  });
});
