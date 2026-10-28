import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  compareSemVer,
  evaluateSchemaCompatibility,
} from "../../distribution/installer/verify-release-manifest.mjs";

const require = createRequire(import.meta.url);
const { deriveCurrentSchema } = require("../../scripts/migrator/clientix-migrator.js");
const schemaManifest = JSON.parse(readFileSync("supabase/manifest.json", "utf8"));
const sha256 = (contents) => createHash("sha256").update(contents).digest("hex");

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
    const webchatMigration = schemaManifest.migrations.find((entry) => entry.sequence === 511);
    const agendaAclMigration = schemaManifest.migrations.find((entry) => entry.sequence === 512);
    const playbookAclMigration = schemaManifest.migrations.find((entry) => entry.sequence === 513);
    const workerAclMigration = schemaManifest.migrations.find((entry) => entry.sequence === 514);
    const workerTriggerAclMigration = schemaManifest.migrations.find((entry) => entry.sequence === 515);
    const tenantLimitMigration = schemaManifest.migrations.find((entry) => entry.sequence === 516);
    const recoveryCodesMigration = schemaManifest.migrations.find((entry) => entry.sequence === 517);
    const historyImportMigration = schemaManifest.migrations.find((entry) => entry.sequence === 518);
    const leadAttachmentsMigration = schemaManifest.migrations.find((entry) => entry.sequence === 519);
    const knowledgeSourceAtomicMigration = schemaManifest.migrations.find((entry) => entry.sequence === 520);
    const caseWaitRemindersMigration = schemaManifest.migrations.find((entry) => entry.sequence === 522);
    const pipelineListMigration = schemaManifest.migrations.find((entry) => entry.sequence === 523);
    const quickRepliesBarMigration = schemaManifest.migrations.find((entry) => entry.sequence === 524);
    const campaignSplitMessagesMigration = schemaManifest.migrations.find((entry) => entry.sequence === 525);
    expect(schemaManifest.schema_target).toBe("0525");
    expect(schemaManifest.baseline.incorporated_through_sequence).toBe(525);
    expect(webchatMigration).toMatchObject({
      file: "20261010120000_0511_webchat_widget_bootstrap.sql",
      version: "20261010120000",
      sequence: 511,
    });
    expect(agendaAclMigration).toMatchObject({
      file: "20261015223000_0512_agenda_event_type_acl.sql",
      version: "20261015223000",
      sequence: 512,
    });
    expect(playbookAclMigration).toMatchObject({
      file: "20261016220127_0513_worker_playbook_runtime_acl.sql",
      version: "20261016220127",
      sequence: 513,
    });
    expect(workerAclMigration).toMatchObject({
      file: "20261017142810_0514_worker_runtime_acl_contract.sql",
      version: "20261017142810",
      sequence: 514,
    });
    expect(workerTriggerAclMigration).toMatchObject({
      file: "20261019204527_0515_agent_worker_trigger_function_acl.sql",
      version: "20261019204527",
      sequence: 515,
    });
    expect(tenantLimitMigration).toMatchObject({
      file: "20261021131855_0516_atomic_installation_tenant_limit.sql",
      version: "20261021131855",
      sequence: 516,
    });
    expect(recoveryCodesMigration).toMatchObject({
      file: "20261024153053_0517_mfa_recovery_codes_server_only.sql",
      version: "20261024153053",
      sequence: 517,
    });
    expect(historyImportMigration).toMatchObject({
      file: "20261026015206_0518_whatsapp_history_import.sql",
      version: "20261026015206",
      sequence: 518,
    });
    expect(leadAttachmentsMigration).toMatchObject({
      file: "20261026170000_0519_crm_lead_file_attachments.sql",
      version: "20261026170000",
      sequence: 519,
    });
    expect(knowledgeSourceAtomicMigration).toMatchObject({
      file: "20261026235409_0520_knowledge_source_patch_atomic.sql",
      version: "20261026235409",
      sequence: 520,
    });
    expect(caseWaitRemindersMigration).toMatchObject({
      file: "20261027100000_0522_case_wait_reminders.sql",
      version: "20261027100000",
      sequence: 522,
    });
    expect(pipelineListMigration).toMatchObject({
      file: "20261027171000_0523_pipeline_list_page_index.sql",
      version: "20261027171000",
      sequence: 523,
      slug: "pipeline_list_page_index",
    });
    expect(quickRepliesBarMigration).toMatchObject({
      file: "20261027210000_0524_message_template_inbox_bar.sql",
      version: "20261027210000",
      sequence: 524,
      slug: "message_template_inbox_bar",
    });
    expect(campaignSplitMessagesMigration).toMatchObject({
      file: "20261028152934_0525_campaign_split_messages.sql",
      version: "20261028152934",
      sequence: 525,
      slug: "campaign_split_messages",
    });

    const baseline510Checksum = "a".repeat(64);
    const trackedState = {
      type: "TRACKED_INSTALLATION",
      applied: [
        { version: "baseline:0510", checksum: baseline510Checksum },
      ],
    };

    expect(deriveCurrentSchema(trackedState, schemaManifest)).toMatchObject({ valid: true, currentSchema: "0510" });
    expect(deriveCurrentSchema({
      ...trackedState,
      applied: [...trackedState.applied, { version: webchatMigration.version, checksum: webchatMigration.checksum }],
    }, schemaManifest)).toMatchObject({ valid: true, currentSchema: "0511" });
    expect(deriveCurrentSchema({
      ...trackedState,
      applied: [
        ...trackedState.applied,
        { version: webchatMigration.version, checksum: webchatMigration.checksum },
        { version: agendaAclMigration.version, checksum: agendaAclMigration.checksum },
        { version: playbookAclMigration.version, checksum: playbookAclMigration.checksum },
      ],
    }, schemaManifest)).toMatchObject({ valid: true, currentSchema: "0513" });
    expect(deriveCurrentSchema({
      ...trackedState,
      applied: [
        ...trackedState.applied,
        { version: webchatMigration.version, checksum: webchatMigration.checksum },
        { version: agendaAclMigration.version, checksum: agendaAclMigration.checksum },
        { version: playbookAclMigration.version, checksum: playbookAclMigration.checksum },
        { version: workerAclMigration.version, checksum: workerAclMigration.checksum },
      ],
    }, schemaManifest)).toMatchObject({ valid: true, currentSchema: "0514" });
    expect(deriveCurrentSchema({
      ...trackedState,
      applied: [
        ...trackedState.applied,
        { version: webchatMigration.version, checksum: webchatMigration.checksum },
        { version: agendaAclMigration.version, checksum: agendaAclMigration.checksum },
        { version: playbookAclMigration.version, checksum: playbookAclMigration.checksum },
        { version: workerAclMigration.version, checksum: workerAclMigration.checksum },
        { version: workerTriggerAclMigration.version, checksum: workerTriggerAclMigration.checksum },
        { version: tenantLimitMigration.version, checksum: tenantLimitMigration.checksum },
      ],
    }, schemaManifest)).toMatchObject({ valid: true, currentSchema: "0516" });
    const migrationsThrough517 = [
      webchatMigration, agendaAclMigration, playbookAclMigration, workerAclMigration,
      workerTriggerAclMigration, tenantLimitMigration, recoveryCodesMigration,
    ].map(({ version, checksum }) => ({ version, checksum }));
    expect(deriveCurrentSchema({
      ...trackedState,
      applied: [...trackedState.applied, ...migrationsThrough517],
    }, schemaManifest)).toMatchObject({ valid: true, currentSchema: "0517" });
    expect(deriveCurrentSchema({
      ...trackedState,
      applied: [...trackedState.applied, ...migrationsThrough517, {
        version: historyImportMigration.version, checksum: historyImportMigration.checksum,
      }],
    }, schemaManifest)).toMatchObject({ valid: true, currentSchema: "0518" });
    const migrationsThrough519 = [
      ...migrationsThrough517,
      { version: historyImportMigration.version, checksum: historyImportMigration.checksum },
      { version: leadAttachmentsMigration.version, checksum: leadAttachmentsMigration.checksum },
    ];
    expect(deriveCurrentSchema({
      ...trackedState,
      applied: [...trackedState.applied, ...migrationsThrough519],
    }, schemaManifest)).toMatchObject({ valid: true, currentSchema: "0519" });
    expect(deriveCurrentSchema({
      ...trackedState,
      applied: [...trackedState.applied, ...migrationsThrough519, {
        version: knowledgeSourceAtomicMigration.version, checksum: knowledgeSourceAtomicMigration.checksum,
      }],
    }, schemaManifest)).toMatchObject({ valid: true, currentSchema: "0520" });
    expect(deriveCurrentSchema({
      ...trackedState,
      applied: [...trackedState.applied, ...migrationsThrough519,
        { version: knowledgeSourceAtomicMigration.version, checksum: knowledgeSourceAtomicMigration.checksum },
        { version: caseWaitRemindersMigration.version, checksum: caseWaitRemindersMigration.checksum },
      ],
    }, schemaManifest)).toMatchObject({ valid: true, currentSchema: "0522" });
    expect(deriveCurrentSchema({
      ...trackedState,
      applied: [...trackedState.applied, ...migrationsThrough519,
        { version: knowledgeSourceAtomicMigration.version, checksum: knowledgeSourceAtomicMigration.checksum },
        { version: caseWaitRemindersMigration.version, checksum: caseWaitRemindersMigration.checksum },
        { version: pipelineListMigration.version, checksum: pipelineListMigration.checksum },
      ],
    }, schemaManifest)).toMatchObject({ valid: true, currentSchema: "0523" });
    expect(deriveCurrentSchema({
      ...trackedState,
      applied: [...trackedState.applied, ...migrationsThrough519,
        { version: knowledgeSourceAtomicMigration.version, checksum: knowledgeSourceAtomicMigration.checksum },
        { version: caseWaitRemindersMigration.version, checksum: caseWaitRemindersMigration.checksum },
        { version: pipelineListMigration.version, checksum: pipelineListMigration.checksum },
        { version: quickRepliesBarMigration.version, checksum: quickRepliesBarMigration.checksum },
      ],
    }, schemaManifest)).toMatchObject({ valid: true, currentSchema: "0524" });
    expect(deriveCurrentSchema({
      ...trackedState,
      applied: [...trackedState.applied, ...migrationsThrough519,
        { version: knowledgeSourceAtomicMigration.version, checksum: knowledgeSourceAtomicMigration.checksum },
        { version: caseWaitRemindersMigration.version, checksum: caseWaitRemindersMigration.checksum },
        { version: pipelineListMigration.version, checksum: pipelineListMigration.checksum },
        { version: quickRepliesBarMigration.version, checksum: quickRepliesBarMigration.checksum },
        { version: campaignSplitMessagesMigration.version, checksum: campaignSplitMessagesMigration.checksum },
      ],
    }, schemaManifest)).toMatchObject({ valid: true, currentSchema: "0525" });
    expect(deriveCurrentSchema({ type: "FRESH_DATABASE" }, schemaManifest)).toMatchObject({ valid: true, currentSchema: null });
    expect(deriveCurrentSchema({ type: "EXISTING_UNTRACKED_INSTALLATION" }, schemaManifest).valid).toBe(false);
    expect(deriveCurrentSchema({ type: "TRACKED_INSTALLATION", applied: [] }, schemaManifest).valid).toBe(false);
    expect(deriveCurrentSchema({
      type: "TRACKED_INSTALLATION",
      applied: [...trackedState.applied, { version: workerAclMigration.version, checksum: "b".repeat(64) }],
    }, schemaManifest).valid).toBe(false);
    expect(deriveCurrentSchema({
      type: "TRACKED_INSTALLATION",
      applied: [...trackedState.applied, { version: "unknown-version", checksum: "b".repeat(64) }],
    }, schemaManifest).valid).toBe(false);
  });

  it("keeps the registered baseline and migration checksums tied to their files", () => {
    const baseline = readFileSync(`supabase/${schemaManifest.baseline.file}`);
    const migrations = schemaManifest.migrations.filter((entry) => entry.sequence >= 511);

    expect(sha256(baseline)).toBe(schemaManifest.baseline.checksum);
    expect(baseline.length).toBe(schemaManifest.baseline.size_bytes);
    for (const migration of migrations) {
      const migrationSql = readFileSync(`supabase/migrations/${migration.file}`);
      expect(sha256(migrationSql)).toBe(migration.checksum);
    }
  });
});
